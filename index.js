/**
 * dsh-jinhsi-avatar host half.
 *
 * 余额：DSH 账号服务（ctx.get('deepseekAccount').getBalance），与设置页「充值余额」同源，实时。
 * 今日已用：本地按回合累计 —— 监听 assistant/message 的 usage（input/cache/output）+ 模型名，
 *          按官方价目表（谷/峰两档）折算成 CNY，按日期持久化。
 * 忙碌：turn/start 记为运行中，turn/end 清除。
 *
 * @module dsh-jinhsi-avatar
 */

import { readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const name = 'avatar'

export const inject = ['webServer', 'sessions']

const ROUTE = '/dsh-avatar/state'
const BALANCE_CACHE_MS = 15000
const FLUSH_MS = 8000

// 官方价目表（CNY / 百万 token）：[谷价, 峰价]
// 峰时 09:00–12:00、14:00–18:00（北京时间）；周末全天谷价
const PRICE_FLASH = { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] }
const PRICE_PRO = { hit: [0.15, 0.3], miss: [4.5, 9.0], out: [13.5, 27.0] }
const PEAK_HOURS = [[9, 12], [14, 18]]
const WEEKEND_VALLEY_FROM = Date.UTC(2026, 7, 22, 16, 0, 0) / 1000 // 北京时间 2026-08-23 00:00 起

function priceFor(model) {
  const m = String(model || '').toLowerCase()
  if (m.indexOf('pro') !== -1) return PRICE_PRO
  return PRICE_FLASH
}

function isPeakTime(sec) {
  const bj = new Date(sec * 1000 + 8 * 3600 * 1000)
  if (sec >= WEEKEND_VALLEY_FROM) {
    const dow = bj.getUTCDay()
    if (dow === 0 || dow === 6) return false
  }
  const hour = bj.getUTCHours()
  return PEAK_HOURS.some(([s, e]) => hour >= s && hour < e)
}

function costOf(model, usage, atSec) {
  const p = priceFor(model)
  const off = isPeakTime(atSec) ? 1 : 0
  const input = Number(usage?.inputTokens) || 0
  const cache = Number(usage?.cacheReadTokens) || 0
  const output = Number(usage?.outputTokens) || 0
  const cost = (cache / 1e6) * p.hit[off] + (input / 1e6) * p.miss[off] + (output / 1e6) * p.out[off]
  return { cost, tokens: input + cache + output }
}

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function usageFile() {
  return path.join(dshHome(), 'dsh-jinhsi-avatar-usage.json')
}

function todayKey() {
  const now = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

async function readAccountBalance(ctx) {
  const account = (typeof ctx.get === 'function' ? ctx.get('deepseekAccount') : null) || ctx.deepseekAccount
  if (!account || typeof account.getBalance !== 'function') throw new Error('no deepseekAccount service')
  const result = await account.getBalance({
    version: String(process.env.DSH_CLIENT_VERSION || process.env.DSH_VERSION || '') || 'unknown',
    locale: String(process.env.DSH_LOCALE || '') || 'zh_CN',
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  })
  if (!result) throw new Error('not signed in (no account grant)')
  if (result.status !== 'ready') throw new Error(`account balance status ${result.status || 'unknown'}`)
  const num = (v) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  const wallets = Array.isArray(result.value) ? result.value : []
  const bonus = Array.isArray(result.bonusWallets) ? result.bonusWallets : []
  const curOf = (w) => String((w && w.currency) || 'CNY').toUpperCase()
  const usable = wallets.concat(bonus).filter((w) => w && num(w.balance) !== null)
  if (!usable.length) throw new Error('no wallets')
  const currency = curOf(usable.find((w) => curOf(w) === 'CNY') || usable[0])
  const sumOf = (list) => list
    .filter((w) => w && curOf(w) === currency && num(w.balance) !== null)
    .reduce((s, w) => s + Number(w.balance), 0)
  return { recharge: sumOf(wallets), bonus: sumOf(bonus), currency }
}

export function apply(ctx) {
  const running = new Map()
  const STALE_MS = 20 * 60 * 1000

  function isBusy() {
    const now = Date.now()
    for (const [id, at] of running) {
      if (now - at > STALE_MS) running.delete(id)
    }
    return running.size > 0
  }

  // ---- 今日用量账本（本地按回合累计） ----
  let ledger = { date: todayKey(), cny: 0, tokens: 0, byModel: {} }
  let ledgerLoaded = false
  let lastFlush = 0
  let dirty = false

  async function loadLedger() {
    if (ledgerLoaded) return
    ledgerLoaded = true
    const saved = await readJson(usageFile())
    if (saved && saved.date === todayKey() && Number.isFinite(Number(saved.cny))) {
      ledger = {
        date: saved.date,
        cny: Number(saved.cny) || 0,
        tokens: Number(saved.tokens) || 0,
        byModel: saved.byModel && typeof saved.byModel === 'object' ? saved.byModel : {},
      }
    }
  }

  async function flushLedger(force) {
    if (!dirty) return
    if (!force && Date.now() - lastFlush < FLUSH_MS) return
    dirty = false
    lastFlush = Date.now()
    try {
      await writeFile(usageFile(), JSON.stringify(ledger, null, 2), 'utf8')
    } catch {
      /* 写不了不影响展示 */
    }
  }

  function rollDayIfNeeded() {
    const key = todayKey()
    if (ledger.date !== key) {
      ledger = { date: key, cny: 0, tokens: 0, byModel: {} }
      dirty = true
    }
  }

  void loadLedger()

  ctx.on('session/event', (session, event) => {
    if (!event) return
    const id = String(session?.id || '')
    if (!id) return
    if (event.type === 'turn/start') {
      running.set(id, Date.now())
      return
    }
    if (event.type === 'turn/end') {
      running.delete(id)
      void flushLedger(true)
      return
    }
    if (event.type !== 'assistant/message') return
    const usage = event.data?.usage
    if (!usage || typeof usage !== 'object') return
    const model = event.data?.message?.source?.model || ''
    const { cost, tokens } = costOf(model, usage, Math.floor(Date.now() / 1000))
    if (!Number.isFinite(cost) || cost <= 0) return
    rollDayIfNeeded()
    ledger.cny += cost
    ledger.tokens += tokens
    const key = model || 'unknown'
    const row = ledger.byModel[key] || { cny: 0, tokens: 0 }
    row.cny += cost
    row.tokens += tokens
    ledger.byModel[key] = row
    dirty = true
    void flushLedger(false)
  })

  ctx.on('session/disposed', (session) => {
    const id = String(session?.id || '')
    if (id) running.delete(id)
  })

  let balanceCache = { at: 0, value: null }

  async function readBalance() {
    if (Date.now() - balanceCache.at < BALANCE_CACHE_MS && balanceCache.value) return balanceCache.value
    try {
      const info = await readAccountBalance(ctx)
      balanceCache = { at: Date.now(), value: { cny: info.recharge, bonus: info.bonus, error: '' } }
    } catch (error) {
      balanceCache = {
        at: Date.now(),
        value: { cny: null, bonus: null, error: String((error && error.message) || error).slice(0, 160) },
      }
    }
    return balanceCache.value
  }

  const route = {
    kind: 'exact',
    path: ROUTE,
    handler: async (req, res) => {
      await loadLedger()
      rollDayIfNeeded()
      const balance = await readBalance()
      const today = ledger.cny
      const payload = {
        ok: true,
        busy: isBusy(),
        running: running.size,
        cny: balance.cny,
        stars: balance.cny != null ? Math.round(balance.cny * 10) : null,
        todayCny: today,
        todayStars: Math.round(today * 10),
        tokens: ledger.tokens,
        bonus: balance.bonus,
        source: balance.cny != null ? 'deepseekAccount' : null,
        apiError: balance.error,
      }
      const body = JSON.stringify(payload)
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
      })
      res.end(body)
    },
  }

  const dispose = ctx.webServer?.register?.(route)
  ctx?.logger?.debug?.('[dsh-jinhsi-avatar] state route registered')

  return () => {
    void flushLedger(true)
    try { dispose?.() } catch { /* ignore */ }
  }
}
