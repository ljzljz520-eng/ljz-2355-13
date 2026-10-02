import { randomUUID, randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto'

export function newId(prefix) {
  return `${prefix}-${randomBytes(6).toString('hex')}`
}

export function uuid() {
  return randomUUID()
}

export function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

// 查看回执令牌：一次性生成给访客，只保存哈希
export function generateViewerToken() {
  const token = randomBytes(24).toString('base64url')
  return { token, hash: hashToken(token) }
}

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex')
}

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const dk = scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${dk}`
}

export function verifyPassword(password, stored) {
  const [salt, dk] = stored.split(':')
  const candidate = scryptSync(password, salt, 64)
  const expected = Buffer.from(dk, 'hex')
  return candidate.length === expected.length && timingSafeEqual(candidate, expected)
}

export function constantTimeEqual(a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}
