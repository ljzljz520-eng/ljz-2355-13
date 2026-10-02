import { createApp } from './src/server.js'
import { Store } from './src/store.js'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export function start(port = process.env.PORT || 8788, filename) {
  const uploadsDir = process.env.FEEDBACK_UPLOADS || path.join(__dirname, 'uploads')
  fs.mkdirSync(path.dirname(filename || path.join(__dirname, 'data', 'feedback.db')), { recursive: true })
  fs.mkdirSync(uploadsDir, { recursive: true })
  const store = new Store(filename)
  seed(store)
  const app = createApp(store)

  return new Promise((resolve) => {
    const server = app.listen(port, () => resolve({ server, store, port: server.address().port }))
  })
}

function seed(store) {
  const adminUser = process.env.FEEDBACK_ADMIN_USER || 'admin'
  const adminPass = process.env.FEEDBACK_ADMIN_PASS || 'admin-123456'
  store.ensureMaintainer(adminUser, adminPass, '站点管理员', 'admin')
  // 预置两位维护者，用于“两个维护者合并同一工单”的协作场景
  store.ensureMaintainer('mona', 'mona-pass-123', 'Mona 维护者')
  store.ensureMaintainer('rafa', 'rafa-pass-123', 'Rafa 维护者')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = process.env.PORT || 8788
  start(port).then(({ port: p }) => {
    console.log(`[feedback] 工单服务已启动: http://localhost:${p}/console`)
  })
}
