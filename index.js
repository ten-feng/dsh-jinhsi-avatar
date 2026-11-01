/**
 * dsh-jinhsi-avatar host half.
 *
 * 1. 余额 / 今日已用：直接读本机账本 `~/.dsh/.dshw-usage.json`
 *    （`lastBalance` 与 `todayUsage`，单位 CNY，和设置里的用量信息同源）。
 *    不走任何网络请求。
 * 2. 忙碌状态：聚合 turn/start / turn/end，任意会话在跑时前端让形象体回窝。
 *
 * @module dsh-jinhsi-avatar
 */

import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const name = 'avatar'

export const inject = ['webServer', 'sessions']

const ROUTE = '/dsh-avatar/state'
const CACHE_MS = 5000

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

/** 本地账本：余额 + 今日已用 */
async function readLedger() {
  const home = dshHome()
  const files = [
    path.join(home, '.dshw-usage.json'),
    path.join(home, 'profiles', 'web', '.dshw-usage.json'),
  ]
  for (const file of files) {
    const data = await readJson(file)
    if (!data) continue
    const cny = Number(data.lastBalance)
    const today = Number(data.todayUsage)
    if (Number.isFinite(cny) || Number.isFinite(today)) {
      return {
        cny: Number.isFinite(cny) ? cny : null,
        todayCny: Number.isFinite(today) ? today : null,
        source: path.basename(file),
      }
    }
  }
  return { cny: null, todayCny: null, source: null }
}

export function apply(ctx) {
  const running = new Set()

  ctx.on('session/event', (session, event) => {
    const id = String(session?.id || '')
    if (!id || !event) return
    if (event.type === 'turn/start') running.add(id)
    else if (event.type === 'turn/end') running.delete(id)
  })
  ctx.on('session/disposed', (session) => {
    const id = String(session?.id || '')
    if (id) running.delete(id)
  })

  let cache = { at: 0, value: null }

  async function readUsage() {
    if (Date.now() - cache.at < CACHE_MS && cache.value) return cache.value
    const value = await readLedger()
    cache = { at: Date.now(), value }
    return value
  }

  const route = {
    kind: 'exact',
    path: ROUTE,
    handler: async (req, res) => {

      const usage = await readUsage()
      const payload = {
        ok: true,
        busy: running.size > 0,
        running: running.size,
        cny: usage.cny,
        stars: usage.cny != null ? Math.round(usage.cny * 10) : null,
        todayCny: usage.todayCny,
        todayStars: usage.todayCny != null ? Math.round(usage.todayCny * 10) : null,
        source: usage.source,
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
    try { dispose?.() } catch { /* ignore */ }
  }
}
