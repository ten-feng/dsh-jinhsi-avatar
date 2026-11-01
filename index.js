/**
 * dsh-jinhsi-avatar host half.
 *
 * 两件事：
 *   1. 把「充值余额 + 今日花费」喂给浏览器半区（读本机鲸鱼余额挂件的账本）
 *   2. 汇总会话忙碌状态：任意会话在跑回合时，形象体应回到窝点不动
 *
 * @module dsh-jinhsi-avatar
 */

import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const name = 'avatar'

export const inject = ['webServer', 'sessions']

const ROUTE = '/dsh-avatar/state'

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

async function readUsage() {
  const home = dshHome()
  const candidates = [
    path.join(home, '.dshw-usage.json'),
    path.join(home, 'profiles', 'web', '.dshw-usage.json'),
  ]
  for (const file of candidates) {
    const data = await readJson(file)
    if (!data) continue
    const balance = Number(data.lastBalance)
    const today = Number(data.todayUsage)
    if (Number.isFinite(balance) || Number.isFinite(today)) {
      return {
        cny: Number.isFinite(balance) ? balance : null,
        todayCny: Number.isFinite(today) ? today : null,
        source: path.basename(file),
      }
    }
  }
  return null
}

export function apply(ctx) {
  // 活跃回合计数：turn/start 记一笔，turn/end 清掉
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

  const route = {
    kind: 'exact',
    path: ROUTE,
    handler: async (req, res) => {
      const usage = await readUsage()
      const payload = {
        ok: true,
        busy: running.size > 0,
        running: running.size,
        cny: usage?.cny ?? null,
        stars: usage?.cny != null ? Math.round(usage.cny * 10) : null,
        todayCny: usage?.todayCny ?? null,
        todayStars: usage?.todayCny != null ? Math.round(usage.todayCny * 10) : null,
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
