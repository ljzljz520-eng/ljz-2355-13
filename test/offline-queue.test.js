/**
 * 离线提交队列单元测试：
 *  - 断网时进入队列且携带幂等键；恢复后自动重放
 *  - 无论重放多少次，服务端只产生一条工单（幂等键去重）
 */
import test from 'node:test'
import assert from 'node:assert/strict'

// ---- 最小浏览器环境桩 ----
const mem = new Map()
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k)
}
let online = true
globalThis.navigator = { ...(globalThis.navigator || {}), onLine: true }
const listeners = {}
globalThis.window = {
  addEventListener: (ev, fn) => (listeners[ev] = fn),
  get navigator() { return { onLine: online } }
}
globalThis.document = { addEventListener() {}, visibilityState: 'visible' }

// 可切换失败/成功的 fetch 桩
let fetchMode = 'offline'
const receivedBodies = []
globalThis.fetch = async (url, init) => {
  receivedBodies.push(JSON.parse(init.body))
  if (fetchMode === 'offline') {
    return new Response('', { status: 503 })
  }
  const body = JSON.parse(init.body)
  // 模拟服务端幂等：同一 key 返回同一 code，并标记 reused
  const key = body.idempotency_key
  const codes = (globalThis.__codes ||= new Map())
  if (!codes.has(key)) codes.set(key, `FB-${String(codes.size + 1).padStart(6, '0')}`)
  return new Response(JSON.stringify({ code: codes.get(key), reused: codes.seenKey?.has(key) || false }), {
    status: 201, headers: { 'content-type': 'application/json' }
  })
}

const { enqueue, loadQueue, flushQueue } = await import(
  '../docs/.vitepress/theme/feedback/queue.js'
)

test('离线时入队（带幂等键），多次 flush 不丢单；上线后重放成功且仅一次', async () => {
  fetchMode = 'offline'
  const item = enqueue({ kind: 'content_question', title: '离线疑问', body: 'b', page_path: '/x', reporter_token: 'rt' })
  assert.match(item.idempotency_key, /^clt_/)

  await flushQueue()
  await flushQueue() // 离线期间重复尝试
  let q = loadQueue()
  assert.equal(q.length, 1)
  assert.equal(q[0].status, 'queued')
  assert.ok(q[0].attempts >= 2)

  fetchMode = 'online'
  await flushQueue()
  q = loadQueue()
  assert.equal(q[0].status, 'sent')
  assert.equal(q[0].response.code, 'FB-000001')

  // 再 flush：已发送项不重发（无新 fetch 产生是保证幂等的客户端侧补充）
  const before = receivedBodies.length
  await flushQueue()
  assert.equal(receivedBodies.length, before)
})

test('两条离线工单各自幂等键不同，不会相互覆盖', async () => {
  const a = enqueue({ kind: 'content_question', title: 'A', body: 'a', page_path: '/x', reporter_token: 'rt' })
  const b = enqueue({ kind: 'content_question', title: 'B', body: 'b', page_path: '/y', reporter_token: 'rt' })
  assert.notEqual(a.idempotency_key, b.idempotency_key)
  await flushQueue()
  const q = loadQueue().filter((x) => [a.id, b.id].includes(x.id))
  assert.equal(q.every((x) => x.status === 'sent'), true)
  assert.notEqual(q[0].response.code, q[1].response.code)
})
