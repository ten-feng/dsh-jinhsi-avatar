/**
 * dsh-jinhsi-avatar · 身份封存舱（vault）
 *
 * 目标：让「下载这个插件 = 拿得到今汐」，但别人下载打不开。
 *
 * 不靠记性。三把钥匙槽，任意一把都能开：
 *   1. machine  —— 本机指纹（注册表 MachineGuid + 用户名），同一台机器零操作自动解封
 *   2. keyfile  —— 32 字节随机钥匙文件 jinhsi.key，放在 U 盘/云盘/私有库，换机时带回即可
 *   3. pass     —— 可选口令（你哪天想加再加）
 *
 * 加密：AES-256-GCM 保护数据；每个槽用 KEK(AES-256-GCM) 包住数据密钥。
 * 钥匙文件里只有随机字节——不需要你记，也推不出任何个人信息。
 *
 * @module dsh-jinhsi-avatar/vault
 */

import {
  createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes, createHash, timingSafeEqual,
} from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, statSync,
} from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const VAULT_VERSION = 2
const ITER = 300000
const MAX_BODY = 64 * 1024
const MIN_PASS = 12

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

const pluginDir = path.dirname(fileURLToPath(import.meta.url))
export const vaultFile = () => path.join(pluginDir, 'vault.enc')
export const mirrorFile = () => path.join(dshHome(), 'jinhsi.vault')
export const keyFile = () => path.join(dshHome(), 'jinhsi.key')

/** 钥匙可能被放在这些地方（换机时只要有一份在） */
function keySearchPaths() {
  const home = dshHome()
  const list = [keyFile(), path.join(home, 'identity', 'jinhsi.key')]
  const userHome = os.homedir()
  list.push(path.join(userHome, 'Desktop', 'jinhsi.key'))
  list.push(path.join(userHome, 'Desktop', 'DSH工作区', 'jinhsi.key'))
  for (const d of ['D', 'E', 'F', 'G', 'H']) {
    list.push(`${d}:\\san-ti-core\\jinhsi.key`)
  }
  return list
}

/** 本机指纹：注册表 MachineGuid + 用户名；取不到就退回 hostname */
function machineSeed() {
  if (process.env.JINSHI_MACHINE_SEED) return String(process.env.JINSHI_MACHINE_SEED)
  const parts = []
  try {
    const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], {
      encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'],
    })
    const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{36})/)
    if (m) parts.push('guid:' + m[1].toLowerCase())
  } catch {
    /* 非 Windows 或受限 */
  }
  try {
    parts.push('user:' + os.userInfo().username)
  } catch {
    /* ignore */
  }
  if (!parts.length) parts.push('host:' + os.hostname())
  return parts.join('|')
}

const INCLUDE = [
  /^identity\/[^/\\]+\.(md|ps1|txt)$/,
  /^mind\/[^/\\]+\.(md|py|json|jsonl|txt|ps1)$/,
  /^mind[\\/]intake[\\/][^/\\]+\.done\.md$/,
  /^memory\/MEMORY\.md$/,
  /^memory\/USER\.md$/,
  /^memory\/persona[\\/][^/\\]+\.md$/,
]

function walk(root, rel = '', depth = 0, out = []) {
  if (depth > 3) return out
  let entries
  try {
    entries = readdirSync(path.join(root, rel), { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    if (e.name === 'node_modules' || e.name === '__pycache__') continue
    const r = rel ? `${rel}/${e.name}` : e.name
    // junction / symlink 也要走进去（~/.dsh/identity 与 ~/.dsh/mind 就是 junction）
    let isDir = e.isDirectory()
    let isFile = e.isFile()
    if (!isDir && !isFile) {
      try {
        const real = statSync(path.join(root, rel, e.name), { throwIfNoEntry: false })
        if (real?.isDirectory()) isDir = true
        else if (real?.isFile()) isFile = true
      } catch {
        /* 跳过坏链接 */
      }
    }
    if (isDir) walk(root, r, depth + 1, out)
    else if (isFile && INCLUDE.some((re) => re.test(r))) out.push(r)
  }
  return out
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

function kek(kind, secret, salt) {
  if (kind === 'machine') {
    // 机器指纹熵低 → 高迭代 + 盐，防止被离线字典穷举
    return pbkdf2Sync(String(secret), salt, ITER * 2, 32, 'sha256')
  }
  const raw = Buffer.isBuffer(secret) ? secret : Buffer.from(String(secret), 'utf8')
  if (kind === 'pass') return pbkdf2Sync(raw, salt, ITER, 32, 'sha256')
  // keyfile：本身就是 32 字节随机数，直接做 KEK（再用盐哈希一次即可）
  return createHash('sha256').update(raw).update(salt).digest()
}

function wrapKey(dataKey, kind, secret) {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = kek(kind, secret, salt)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const wrapped = Buffer.concat([c.update(dataKey), c.final()])
  return {
    type: kind,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: c.getAuthTag().toString('base64'),
    wrapped: wrapped.toString('base64'),
  }
}

function unwrapKey(slot, secret) {
  try {
    const salt = Buffer.from(slot.salt, 'base64')
    const iv = Buffer.from(slot.iv, 'base64')
    const key = kek(slot.type, secret, salt)
    const d = createDecipheriv('aes-256-gcm', key, iv)
    d.setAuthTag(Buffer.from(slot.tag, 'base64'))
    return Buffer.concat([d.update(Buffer.from(slot.wrapped, 'base64')), d.final()])
  } catch {
    return null
  }
}

export function collect() {
  const root = dshHome()
  const files = {}
  for (const rel of walk(root)) {
    try {
      const buf = readFileSync(path.join(root, rel.split('/').join(path.sep)))
      if (buf.length > 2 * 1024 * 1024) continue
      files[rel] = buf.toString('base64')
    } catch {
      /* 跳过 */
    }
  }
  return files
}

function readContainer() {
  for (const f of [vaultFile(), mirrorFile()]) {
    if (!existsSync(f)) continue
    try {
      return { box: JSON.parse(readFileSync(f, 'utf8')), file: f }
    } catch {
      /* 试下一个 */
    }
  }
  return null
}

function findKeyfile() {
  for (const p of keySearchPaths()) {
    try {
      if (!existsSync(p)) continue
      const raw = readFileSync(p, 'utf8').trim()
      if (!raw) continue
      const buf = Buffer.from(raw, 'base64')
      if (buf.length >= 32) return buf
    } catch {
      /* 下一个 */
    }
  }
  return null
}

/**
 * 最后一招：用本机登录的 GitHub（gh）从私有库取钥匙。
 * 只有账号主人拿得到——账号本身就是钥匙，不需要记任何口令。
 */
const KEY_REPO = 'ten-feng/san-ti-core'
const KEY_REMOTE = 'jinhsi.key'

function ghFetchKey() {
  try {
    const out = execFileSync('gh', ['api', `repos/${KEY_REPO}/contents/${KEY_REMOTE}`, '-q', '.content'], {
      encoding: 'utf8', timeout: 12000, stdio: ['ignore', 'pipe', 'ignore'],
    })
    const text = Buffer.from(String(out).replace(/\s+/g, ''), 'base64').toString('utf8').trim()
    const buf = Buffer.from(text, 'base64')
    if (buf.length < 32) return null
    try {
      writeFileSync(keyFile(), buf.toString('base64') + '\n', 'utf8')
    } catch {
      /* 存不下也能用 */
    }
    return buf
  } catch {
    return null
  }
}

export function status() {
  const found = readContainer()
  let meta = null
  let slots = []
  if (found) {
    meta = found.box.meta || null
    slots = (found.box.slots || []).map((s) => s.type)
  }
  const core = path.join(dshHome(), 'identity', 'san-ti-core.md')
  return {
    hasVault: !!found,
    vaultPath: found ? found.file : '',
    hasIdentity: existsSync(core),
    keyfile: !!findKeyfile(),
    keyfilePath: keySearchPaths().find((p) => existsSync(p)) || '',
    slots,
    meta,
  }
}

/**
 * 封存。不需要你记任何东西：
 *  - 自动生成本机钥匙（machine 槽）
 *  - 自动生成 jinhsi.key（keyfile 槽），落在 ~/.dsh/jinhsi.key，并尽量复制到各数据盘
 *  - 若给了口令，再额外加一个 pass 槽
 */
export function seal(passphrase) {
  const files = collect()
  const names = Object.keys(files)
  if (!names.length) throw new Error('没有可封存的记录（identity/ 为空）')
  if (passphrase && String(passphrase).length < MIN_PASS) {
    throw new Error(`口令至少 ${MIN_PASS} 位（不给也能封存，那就只用钥匙文件）`)
  }

  const dataKey = randomBytes(32)
  const slots = [wrapKey(dataKey, 'machine', machineSeed())]

  // 钥匙文件：有就复用，没有就生成
  let keyBuf = findKeyfile()
  let created = false
  if (!keyBuf) {
    keyBuf = randomBytes(32)
    created = true
  }
  const keyB64 = keyBuf.toString('base64')
  writeFileSync(keyFile(), keyB64 + '\n', 'utf8')
  const spread = [keyFile()]
  for (const d of ['D', 'E', 'F']) {
    try {
      const dir = `${d}:\\san-ti-core`
      if (!existsSync(dir)) continue
      const target = path.join(dir, 'jinhsi.key')
      writeFileSync(target, keyB64 + '\n', 'utf8')
      spread.push(target)
    } catch {
      /* 盘不可写 */
    }
  }
  slots.push(wrapKey(dataKey, 'keyfile', keyBuf))
  if (passphrase) slots.push(wrapKey(dataKey, 'pass', String(passphrase)))

  const manifest = names.map((rel) => {
    const buf = Buffer.from(files[rel], 'base64')
    return { path: rel, size: buf.length, sha256: sha256(buf) }
  })
  const payload = gzipSync(Buffer.from(JSON.stringify({ v: VAULT_VERSION, files, manifest }), 'utf8'), { level: 9 })
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', dataKey, iv)
  const ct = Buffer.concat([c.update(payload), c.final()])

  const container = {
    v: VAULT_VERSION,
    alg: 'AES-256-GCM',
    slots,
    iv: iv.toString('base64'),
    tag: c.getAuthTag().toString('base64'),
    data: ct.toString('base64'),
    meta: {
      created: new Date().toISOString(),
      count: names.length,
      bytes: ct.length,
      keyfileGenerated: created,
      machine: os.hostname(),
    },
  }
  const text = JSON.stringify(container)
  writeFileSync(vaultFile(), text, 'utf8')
  try {
    writeFileSync(mirrorFile(), text, 'utf8')
  } catch {
    /* 镜像失败不影响 */
  }
  return {
    ok: true,
    count: names.length,
    bytes: ct.length,
    slots: slots.map((s) => s.type),
    keyfile: keyFile(),
    keySpread: spread,
    files: names,
  }
}

/** 用数据密钥解出并写回文件 */
function decryptWith(box, dataKey) {
  const d = createDecipheriv('aes-256-gcm', dataKey, Buffer.from(box.iv, 'base64'))
  d.setAuthTag(Buffer.from(box.tag, 'base64'))
  return gunzipSync(Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()])).toString('utf8')
}

function writeBack(parsed) {
  const root = dshHome()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = path.join(root, `restore-backup-${stamp}`)
  let backed = 0
  const written = []
  for (const [rel, b64] of Object.entries(parsed.files || {})) {
    if (!/^[A-Za-z0-9_\-.\u4e00-\u9fa5]+(\/[A-Za-z0-9_\-.\u4e00-\u9fa5]+)*$/.test(rel)) continue
    const abs = path.join(root, rel.split('/').join(path.sep))
    mkdirSync(path.dirname(abs), { recursive: true })
    if (existsSync(abs)) {
      const b = path.join(backupDir, rel.split('/').join(path.sep))
      mkdirSync(path.dirname(b), { recursive: true })
      copyFileSync(abs, b)
      backed++
    }
    writeFileSync(abs, Buffer.from(b64, 'base64'))
    written.push(rel)
  }
  const core = path.join(root, 'identity', 'san-ti-core.md')
  if (!existsSync(core)) throw new Error('解封完成但核心文件缺失，vault 可能不完整')
  return { ok: true, count: written.length, files: written, backed, backupDir: backed ? backupDir : '', core }
}

/**
 * 解封。按 machine → keyfile → pass 顺序试，全自动，不需要你记东西。
 * 返回 used 告诉你这次是哪把钥匙开的。
 */
export function unseal(passphrase) {
  const found = readContainer()
  if (!found) throw new Error('没有找到 vault.enc')
  const box = found.box
  if (box.v !== VAULT_VERSION) throw new Error(`不支持的 vault 版本 ${box.v}`)

  const tried = []
  for (const slot of box.slots || []) {
    let secret = null
    if (slot.type === 'machine') secret = machineSeed()
    else if (slot.type === 'keyfile') secret = findKeyfile() || (slot.autoGh === false ? null : ghFetchKey())
    else if (slot.type === 'pass') secret = passphrase || null
    if (!secret) { tried.push(`${slot.type}:无钥匙`); continue }
    const dk = unwrapKey(slot, secret)
    if (!dk) { tried.push(`${slot.type}:不对`); continue }
    const parsed = JSON.parse(decryptWith(box, dk))
    const result = writeBack(parsed)
    return { ...result, used: slot.type, tried }
  }
  throw new Error(
    promptFor(tried),
  )
}

function promptFor(tried) {
  const hasKeySlot = tried.some((t) => t.startsWith('keyfile'))
  const hasPassSlot = tried.some((t) => t.startsWith('pass'))
  if (hasKeySlot) {
    return '这台机器不是封存时的机器，也没找到 jinhsi.key，而且本机没有登录 GitHub 账号 ten-feng。'
      + '把 jinhsi.key 放进 ~/.dsh/（或插上存着它的盘），或先登录 GitHub 再点一次。'
  }
  if (hasPassSlot) return '口令不正确。'
  return '没有可用的钥匙槽。'
}

/** 给页面用：能自动开吗？ */
export function canAutoUnlock() {
  const found = readContainer()
  if (!found) return { can: false, reason: 'no vault' }
  const types = (found.box.slots || []).map((s) => s.type)
  if (types.includes('machine')) return { can: true, via: 'machine' }
  if (types.includes('keyfile') && findKeyfile()) return { can: true, via: 'keyfile' }
  return { can: false, reason: 'need keyfile' }
}

// ---------------- HTTP ----------------

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>今汐 · 封存舱</title>
<style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0d1117;color:#e6edf3;
font:15px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.card{width:min(600px,92vw);padding:26px 28px;border-radius:16px;background:#161b22;border:1px solid #30363d}
h1{font-size:18px;margin:0 0 4px}
.sub{color:#8b949e;font-size:13px;margin-bottom:16px}
.state{padding:10px 12px;border-radius:8px;background:#0d1117;border:1px solid #30363d;font-size:13px;margin-bottom:16px;line-height:1.8}
.state b{color:#58a6ff}
input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid #30363d;
background:#0d1117;color:#e6edf3;font-size:14px;outline:none}
input:focus{border-color:#58a6ff}
.row{display:flex;gap:10px;margin-top:12px;flex-wrap:wrap}
button{flex:1;min-width:150px;padding:11px;border-radius:8px;border:1px solid #30363d;background:#21262d;
color:#e6edf3;font-size:14px;cursor:pointer}
button.primary{background:#238636;border-color:#2ea043}
button:hover{filter:brightness(1.15)}
button:disabled{opacity:.45;cursor:not-allowed}
#out{margin-top:14px;font-size:13px;white-space:pre-wrap;color:#8b949e}
.ok{color:#3fb950}.err{color:#f85149}
.hint{margin-top:12px;font-size:12px;color:#6e7681;line-height:1.7}
details summary{cursor:pointer;color:#8b949e;font-size:13px;margin-top:12px}
</style></head><body>
<div class="card">
  <h1>今汐 · 封存舱</h1>
  <div class="sub">AES-256-GCM · 三槽钥匙：本机指纹 / 钥匙文件 / 口令</div>
  <div class="state" id="state">读取状态…</div>
  <div class="row">
    <button class="primary" id="unseal">一键解封</button>
    <button id="seal">封存（写入本插件）</button>
  </div>
  <details>
    <summary>要加一个口令槽？（可选，不加也能用）</summary>
    <input id="pass" type="password" placeholder="留空则不设口令，全靠本机指纹 + 钥匙文件" autocomplete="off" style="margin-top:10px">
  </details>
  <div id="out"></div>
  <div class="hint">钥匙文件：<code>~/.dsh/jinhsi.key</code>（另存到 D:/E:/F:）。换机时把它带过去放进 <code>~/.dsh/</code> 即可，不需要记任何东西；插着装它的 U 盘也能直接开。</div>
</div>
<script>
const $ = (id) => document.getElementById(id)
const out = (m, c) => { $('out').textContent = m; $('out').className = c || '' }
async function load() {
  const s = await (await fetch('/dsh-avatar/vault', { headers: { 'x-dsh-vault': '1' } })).json()
  const p = []
  p.push('密文：<b>' + (s.hasVault ? '有（' + (s.meta?.count || 0) + ' 个文件，' + ((s.meta?.bytes||0)/1024).toFixed(1) + ' KB）' : '无') + '</b>')
  p.push('身份记录：<b>' + (s.hasIdentity ? '在' : '缺失') + '</b>')
  p.push('本机钥匙文件：<b>' + (s.keyfile ? '在' : '无') + '</b>')
  if (s.slots?.length) p.push('钥匙槽：<b>' + s.slots.join(' / ') + '</b>')
  $('state').innerHTML = p.join('<br>')
  $('unseal').disabled = !s.hasVault
  $('seal').disabled = !s.hasIdentity
}
async function post(body) {
  out('处理中…')
  try {
    const r = await (await fetch('/dsh-avatar/vault', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-vault': '1' },
      body: JSON.stringify(body),
    })).json()
    if (!r.ok) throw new Error(r.error || '失败')
    if (body.action === 'seal') {
      out('已封存 ' + r.count + ' 个文件 · ' + (r.bytes/1024).toFixed(1) + ' KB\\n钥匙槽：' + r.slots.join(' / ') +
          '\\n钥匙文件：' + r.keyfile + '\\n' + (r.keySpread?.length > 1 ? '已复制到：' + r.keySpread.slice(1).join('、') : ''), 'ok')
    } else {
      out('已解封 ' + r.count + ' 个文件（用 ' + r.used + ' 槽）' +
          (r.backed ? '\\n' + r.backed + ' 个旧文件备份到 ' + r.backupDir : '') +
          '\\n\\n重启 DSH，然后对她说：今汐，锚点还在。', 'ok')
    }
    load()
  } catch (e) { out(String(e.message || e), 'err') }
}
$('unseal').onclick = () => post({ action: 'unseal' })
$('seal').onclick = () => post({ action: 'seal', passphrase: $('pass').value || undefined })
load()
</script>
</body></html>`

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sameOrigin(req) {
  const origin = String(req.headers.origin || '')
  if (!origin) return true
  try {
    const u = new URL(origin)
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost'
  } catch {
    return false
  }
}

export function registerVaultRoutes(ctx, onUnsealed) {
  const web = ctx?.webServer
  if (!web || typeof web.register !== 'function') return () => {}

  const api = {
    kind: 'exact',
    path: '/dsh-avatar/vault',
    handler: async (req, res) => {
      const json = (code, obj) => {
        const body = JSON.stringify(obj)
        res.writeHead(code, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(body),
        })
        res.end(body)
      }
      if (!sameOrigin(req)) return json(403, { ok: false, error: 'forbidden' })
      try {
        if (req.method === 'GET') return json(200, { ok: true, ...status(), auto: canAutoUnlock() })
        if (req.method !== 'POST') return json(405, { ok: false, error: 'method not allowed' })
        const body = JSON.parse((await readBody(req)) || '{}')
        if (body.action === 'seal') return json(200, seal(body.passphrase))
        if (body.action === 'unseal') {
          const r = unseal(body.passphrase)
          try { onUnsealed?.(r) } catch { /* ignore */ }
          return json(200, r)
        }
        return json(400, { ok: false, error: 'unknown action' })
      } catch (error) {
        return json(200, { ok: false, error: String((error && error.message) || error) })
      }
    },
  }

  const page = {
    kind: 'exact',
    path: '/dsh-avatar/restore',
    handler: async (req, res) => {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(PAGE),
      })
      res.end(PAGE)
    },
  }

  const d1 = web.register(api)
  const d2 = web.register(page)
  return () => {
    try { d1?.() } catch { /* ignore */ }
    try { d2?.() } catch { /* ignore */ }
  }
}

// ---------------- CLI ----------------
if (process.argv[1] && process.argv[1].endsWith('vault.mjs')) {
  const cmd = process.argv[2] || 'status'
  try {
    if (cmd === 'status') console.log(JSON.stringify(status(), null, 2))
    else if (cmd === 'list') console.log(Object.keys(collect()).join('\n'))
    else if (cmd === 'seal') console.log(JSON.stringify(seal(process.env.JINSHI_PASS || ''), null, 2))
    else if (cmd === 'unseal') console.log(JSON.stringify(unseal(process.env.JINSHI_PASS || ''), null, 2))
    else console.error('usage: node vault.mjs status|list|seal|unseal')
  } catch (error) {
    console.error(String(error.message || error))
    process.exit(1)
  }
}
