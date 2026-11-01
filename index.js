/**
 * dsh-avatar host half.
 *
 * 只做一件事：把「充值余额」喂给浏览器半区。
 * 余额来自本机鲸鱼余额挂件记录的账本（~/.dsh/.dshw-usage.json 的 lastBalance，单位 CNY），
 * 也就是设置里那份余额口径，避免再去猜第三方接口。
 *
 * @module dsh-avatar
 */

import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const name = 'avatar'

export const inject = ['webServer']

const ROUTE = '/dsh-avatar/balance'

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

async function readBalance() {
  const home = dshHome()
  const candidates = [
    path.join(home, '.dshw-usage.json'),
    path.join(home, 'profiles', 'web', '.dshw-usage.json'),
  ]
  for (const file of candidates) {
    const data = await readJson(file)
    if (!data) continue
    const value = Number(data.lastBalance)
    if (Number.isFinite(value) && value >= 0) {
      return { cny: value, source: path.basename(file) }
    }
  }
  return null
}

export function apply(ctx) {
  const route = {
    kind: 'exact',
    path: ROUTE,
    handler: async (req, res) => {
      const balance = await readBalance()
      const payload = balance
        ? { ok: true, cny: balance.cny, stars: Math.round(balance.cny * 10), source: balance.source }
        : { ok: false, error: 'balance unavailable' }
      const body = JSON.stringify(payload)
      res.writeHead(balance ? 200 : 404, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
      })
      res.end(body)
    },
  }

  const dispose = ctx.webServer?.register?.(route)
  ctx?.logger?.debug?.('[dsh-avatar] balance route registered')
  return () => {
    try { dispose?.() } catch { /* ignore */ }
  }
}
