import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// 必须在导入 server 之前指定上传目录（server.js 在导入时读取该环境变量）
const uploadDir = process.env.FEEDBACK_UPLOADS =
  path.join(mkdtempSync(path.join(tmpdir(), 'fb-up-')), 'uploads')
mkdirSync(uploadDir, { recursive: true })

const { createApp } = await import('../src/server.js')
const { Store } = await import('../src/store.js')

export const MONA = 'Basic ' + Buffer.from('mona:mona-pass-123').toString('base64')
export const RAFA = 'Basic ' + Buffer.from('rafa:rafa-pass-123').toString('base64')
export const ADMIN = 'Basic ' + Buffer.from('admin:admin-123456').toString('base64')

export async function startTestServer() {
  const dir = mkdtempSync(path.join(tmpdir(), 'feedback-'))
  const dbFile = path.join(dir, 'test.db')

  const store = new Store(dbFile)
  store.ensureMaintainer('mona', 'mona-pass-123', 'Mona')
  store.ensureMaintainer('rafa', 'rafa-pass-123', 'Rafa')
  store.ensureMaintainer('admin', 'admin-123456', 'Admin', 'admin')

  const app = createApp(store)
  await new Promise((resolve) => app.listen(0, resolve))
  const port = app.address().port
  const base = `http://127.0.0.1:${port}`

  return {
    base,
    dir,
    store,
    stop: async () => {
      await new Promise((r) => app.close(r))
      rmSync(dir, { recursive: true, force: true })
      rmSync(path.dirname(uploadDir), { recursive: true, force: true })
    }
  }
}

export async function api(base, p, opts = {}) {
  const headers = { ...(opts.headers || {}) }
  let body = opts.body
  if (body && !(body instanceof Buffer) && !opts.raw) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(body)
  }
  const res = await fetch(base + p, { ...opts, headers, body })
  const text = await res.text()
  let json
  try { json = text ? JSON.parse(text) : {} } catch { json = { raw: text } }
  return { status: res.status, json, headers: res.headers }
}

export function ticketPayload(over = {}) {
  return {
    idempotencyKey: crypto.randomUUID(),
    category: 'example_failure',
    title: '按钮示例点击无效',
    body: '在 Chrome 中点击 basic 示例按钮无反应，控制台报错。',
    pageVersion: '2026.09.0',
    pagePath: '/components/button',
    pageAnchor: '#basic-usage',
    headingSnapshot: '基础按钮用法',
    env: { language: 'zh-CN', viewport: '1280x800', url: '/components/button#basic-usage' },
    ...over
  }
}
