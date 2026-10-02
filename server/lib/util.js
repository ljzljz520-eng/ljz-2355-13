import { db } from './db.js'

export const MAX_BODY_BYTES = 256 * 1024
export const MAX_CHUNK_BYTES = 5 * 1024 * 1024
export const MAX_TOTAL_MB = Number(process.env.MAX_UPLOAD_MB || 20)

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message)
    this.status = status
    this.details = details
  }
}

export function send(res, status, data, headers = {}) {
  const body = data instanceof Buffer || typeof data === 'string' ? data : JSON.stringify(data)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
  res.end(body)
}

export async function readJson(req, limit = MAX_BODY_BYTES) {
  const buf = await readRaw(req, limit)
  if (!buf.length) return {}
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    throw new HttpError(400, 'invalid JSON body')
  }
}

export function readRaw(req, limit = MAX_CHUNK_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new HttpError(413, `payload too large (limit ${limit} bytes)`))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** 鉴权：Bearer token → 维护者 login */
export function authMaintainer(req) {
  const h = req.headers['authorization'] || ''
  const token = h.startsWith('Bearer ') ? h.slice(7) : null
  if (!token) throw new HttpError(401, 'maintainer token required')
  const m = db.prepare('SELECT login FROM maintainers WHERE bearer_token=?').get(token)
  if (!m) throw new HttpError(403, 'invalid maintainer token')
  return m.login
}

export function actorOf(login) {
  return `maintainer:${login}`
}

/**
 * 幂等执行：同一 idempotencyKey+scope 永远返回同一响应。
 * 覆盖“重复网络回执”：客户端超时重试不会产生第二条工单。
 */
export function idempotent(scope, key, fn) {
  if (!key) return fn()
  const existing = db
    .prepare('SELECT response_json FROM idempotency WHERE idempotency_key=? AND scope=?')
    .get(key, scope)
  if (existing) return { reused: true, ...JSON.parse(existing.response_json) }
  const result = fn()
  db.prepare('INSERT INTO idempotency (idempotency_key, scope, response_json) VALUES (?,?,?)').run(
    key,
    scope,
    JSON.stringify(result)
  )
  return result
}

export function addEvent(ticketId, type, actor, payload = {}) {
  db.prepare(
    'INSERT INTO ticket_events (ticket_id, type, actor, payload_json) VALUES (?,?,?,?)'
  ).run(ticketId, type, actor, JSON.stringify(payload))
}

export function getTicketOrThrow(code) {
  const t = db.prepare('SELECT * FROM tickets WHERE code=?').get(code)
  if (!t) throw new HttpError(404, `ticket ${code} not found`)
  return t
}

export function nextTicketCode() {
  const n = db.prepare("SELECT COUNT(*) c FROM tickets").get().c + 1
  return `FB-${String(n).padStart(6, '0')}`
}
