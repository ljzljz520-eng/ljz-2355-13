// 访客身份：本地持久化的随机查询码。服务端只存其 sha256，不存原始 IP。
const TOKEN_KEY = 'fb.reporter_token'

export function getReporterToken() {
  let t = safeGet(TOKEN_KEY)
  if (!t) {
    t = 'rt_' + uuid() + uuid()
    safeSet(TOKEN_KEY, t)
  }
  return t
}

export function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '')
  return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function safeGet(k) {
  try { return localStorage.getItem(k) } catch { return null }
}
function safeSet(k, v) {
  try { localStorage.setItem(k, v) } catch { /* 隐私模式忽略 */ }
}
