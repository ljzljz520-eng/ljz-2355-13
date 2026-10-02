// 离线提交队列：
//  - 每条请求生成 UUID 幂等键，断网/超时重试不会产生重复工单（验收：重复网络回执）
//  - online 事件与 visibilitychange 时自动重放；服务端按幂等键去重
import { uuid } from './identity.js'

const QUEUE_KEY = 'fb.outbox.v1'

export function loadQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]') } catch { return [] }
}
function save(q) {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)) } catch {}
}

export function enqueue(payload) {
  const item = {
    id: uuid(),
    idempotency_key: 'clt_' + uuid(),
    payload,
    attempts: 0,
    status: 'queued',
    createdAt: new Date().toISOString()
  }
  const q = loadQueue()
  q.push(item)
  save(q)
  return item
}

export function updateItem(id, patch) {
  const q = loadQueue()
  const i = q.findIndex((x) => x.id === id)
  if (i >= 0) {
    q[i] = { ...q[i], ...patch }
    save(q)
    return q[i]
  }
  return null
}

export function removeItem(id) {
  save(loadQueue().filter((x) => x.id !== id))
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    // 4xx（除 408/429/5xx）属于请求本身错误，直接失败不重试
    const retriable = res.status === 408 || res.status === 429 || res.status >= 500
    const err = new Error(data.error || `HTTP ${res.status}`)
    err.retriable = retriable
    err.status = res.status
    throw err
  }
  return data
}

export async function flushQueue(onChange) {
  const q = loadQueue()
  for (const item of q) {
    if (item.status === 'sent' || item.status === 'failed') continue
    updateItem(item.id, { attempts: item.attempts + 1, status: 'sending' })
    onChange?.()
    try {
      const data = await postJson('/api/feedback/tickets', {
        ...item.payload,
        idempotency_key: item.idempotency_key
      })
      updateItem(item.id, { status: 'sent', response: data, sentAt: new Date().toISOString() })
    } catch (e) {
      updateItem(item.id, {
        status: e.retriable ? 'queued' : 'failed',
        lastError: e.message
      })
    }
    onChange?.()
  }
}

export function autoFlush(onChange) {
  if (typeof window === 'undefined') return () => {}
  const run = () => flushQueue(onChange)
  window.addEventListener('online', run)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') run()
  })
  return run
}
