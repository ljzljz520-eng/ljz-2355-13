// 维护者 Basic Auth；公开访客接口不需要登录
export function basicAuth(req) {
  const h = req.headers.authorization
  if (!h || !h.startsWith('Basic ')) return null
  try {
    const raw = Buffer.from(h.slice(6), 'base64').toString('utf8')
    const idx = raw.indexOf(':')
    if (idx < 0) return null
    return { username: raw.slice(0, idx), password: raw.slice(idx + 1) }
  } catch {
    return null
  }
}

export function requireMaintainer(req, store) {
  const cred = basicAuth(req)
  if (!cred) throw Object.assign(new Error('unauthorized'), { status: 401, code: 'unauthorized' })
  const m = store.authenticateMaintainer(cred.username, cred.password)
  if (!m) throw Object.assign(new Error('forbidden'), { status: 403, code: 'bad_credentials' })
  return m
}
