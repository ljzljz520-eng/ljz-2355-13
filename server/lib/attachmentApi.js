import path from 'node:path'
import fs from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { randomUUID, createHash } from 'node:crypto'
import { db, sha256, UPLOAD_DIR } from './db.js'
import { HttpError, readRaw, MAX_CHUNK_BYTES, MAX_TOTAL_MB } from './util.js'

const MAX_TOTAL = MAX_TOTAL_MB * 1024 * 1024

function ownerHashFromToken(token) {
  return token ? sha256(token) : null
}

/** POST /api/feedback/uploads/init  {filename,size,mime,total_chunks,chunk_size,reporter_token} */
export function initUpload(body) {
  if (!body.filename || !body.total_chunks || !body.chunk_size) {
    throw new HttpError(400, 'filename, total_chunks, chunk_size required')
  }
  if (body.total_chunks > 2000) throw new HttpError(400, 'too many chunks')
  if (body.size && body.size > MAX_TOTAL) throw new HttpError(413, `file exceeds ${MAX_TOTAL_MB}MB`)
  const ownerHash = ownerHashFromToken(body.reporter_token)
  if (!ownerHash) throw new HttpError(400, 'reporter_token required')

  const uploadId = randomUUID()
  // 若同一文件（大小+名+owner）已有未完成/已完成登记，直接复用（中断后重开页面也能续）
  const existing = db
    .prepare(
      `SELECT DISTINCT upload_id FROM upload_chunks WHERE filename=? AND owner_hash=?
       ORDER BY id DESC LIMIT 1`
    )
    .get(body.filename, ownerHash)
  const uid = existing ? existing.upload_id : uploadId
  if (!existing) {
    db.prepare(
      `INSERT INTO upload_chunks (upload_id, filename, mime, total_chunks, chunk_size, total_size, owner_hash, chunk_index, sha256)
       VALUES (?,?,?,?,?,?,?,-1,'meta')`
    ).run(uid, body.filename, body.mime || null, body.total_chunks, body.chunk_size, body.size || null, ownerHash)
  }
  const received = db
    .prepare("SELECT chunk_index FROM upload_chunks WHERE upload_id=? AND chunk_index>=0")
    .all(uid)
    .map((r) => r.chunk_index)
  return { upload_id: uid, received_chunks: received.sort((a, b) => a - b), done: false }
}

/** PUT /api/feedback/uploads/:id/chunks/:i?sha256=...  raw body = chunk bytes */
export async function putChunk(req, uploadId, indexStr, query, reporterToken) {
  const index = Number(indexStr)
  const meta = db
    .prepare("SELECT * FROM upload_chunks WHERE upload_id=? AND chunk_index=-1")
    .get(uploadId)
  if (!meta) throw new HttpError(404, 'upload not found')
  if (ownerHashFromToken(reporterToken) !== meta.owner_hash) throw new HttpError(403, 'not your upload')
  if (!Number.isInteger(index) || index < 0 || index >= meta.total_chunks) {
    throw new HttpError(400, 'invalid chunk index')
  }
  const expectedSha = query.sha256
  if (!expectedSha) throw new HttpError(400, 'chunk sha256 query param required')
  const buf = await readRaw(req, MAX_CHUNK_BYTES)
  if (buf.length > meta.chunk_size) throw new HttpError(413, 'chunk larger than declared chunk_size')
  if (sha256(buf) !== expectedSha) throw new HttpError(422, 'chunk checksum mismatch')

  const tmpDir = path.join(UPLOAD_DIR, uploadId)
  fs.mkdirSync(tmpDir, { recursive: true })
  fs.writeFileSync(path.join(tmpDir, String(index)), buf)
  db.prepare(
    `INSERT INTO upload_chunks (upload_id, filename, mime, total_chunks, chunk_size, total_size, owner_hash, chunk_index, sha256)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(upload_id, chunk_index) DO UPDATE SET sha256=excluded.sha256`
  ).run(uploadId, meta.filename, meta.mime, meta.total_chunks, meta.chunk_size, meta.total_size, meta.owner_hash, index, expectedSha)
  return status(uploadId, { hashed: true, hash: meta.owner_hash })
}

/** GET /api/feedback/uploads/:id/status?reporter_token=...  断点恢复：返回缺哪些片 */
export function status(uploadId, auth) {
  const meta = db
    .prepare("SELECT * FROM upload_chunks WHERE upload_id=? AND chunk_index=-1")
    .get(uploadId)
  if (!meta) throw new HttpError(404, 'upload not found')
  if (auth) {
    // auth 可能是原始 reporter_token（HTTP 调用）或已是哈希（内部调用）
    const hash = auth.hashed ? auth.hash : ownerHashFromToken(auth.token || auth)
    if (hash !== meta.owner_hash) throw new HttpError(403, 'not your upload')
  }
  const rows = db
    .prepare("SELECT chunk_index FROM upload_chunks WHERE upload_id=? AND chunk_index>=0")
    .all(uploadId)
  const received = rows.map((r) => r.chunk_index).sort((a, b) => a - b)
  const missing = []
  for (let i = 0; i < meta.total_chunks; i++) if (!received.includes(i)) missing.push(i)
  return {
    upload_id: uploadId,
    received_chunks: received,
    missing_chunks: missing,
    done: missing.length === 0
  }
}

/** POST /api/feedback/uploads/:id/complete {reporter_token,sha256,visibility} */
export async function completeUpload(body, uploadId) {
  const meta = db
    .prepare("SELECT * FROM upload_chunks WHERE upload_id=? AND chunk_index=-1")
    .get(uploadId)
  if (!meta) throw new HttpError(404, 'upload not found')
  if (ownerHashFromToken(body.reporter_token) !== meta.owner_hash) throw new HttpError(403, 'not your upload')

  const st = status(uploadId, { token: body.reporter_token })
  if (!st.done) return { done: false, missing_chunks: st.missing_chunks }

  // 幂等：网络重发 complete 不重复拼装
  const idemKey = `complete:${uploadId}`
  const existing = db.prepare('SELECT response_json FROM idempotency WHERE idempotency_key=?').get(idemKey)
  if (existing) return { done: true, ...JSON.parse(existing.response_json), reused: true }

  const tmpDir = path.join(UPLOAD_DIR, uploadId)
  const hash = createHash('sha256')
  const parts = []
  for (let i = 0; i < meta.total_chunks; i++) {
    const p = path.join(tmpDir, String(i))
    if (!fs.existsSync(p)) throw new HttpError(409, `chunk ${i} missing`)
    const b = fs.readFileSync(p)
    hash.update(b)
    parts.push(b)
  }
  const whole = Buffer.concat(parts)
  const digest = hash.digest('hex')
  if (body.sha256 && body.sha256 !== digest) throw new HttpError(422, 'whole-file checksum mismatch')
  if (whole.length > MAX_TOTAL) throw new HttpError(413, 'assembled file too large')

  // 内容去重：同一文件只存一份
  let att = db.prepare('SELECT * FROM attachments WHERE sha256=?').get(digest)
  if (!att) {
    const storagePath = path.join(UPLOAD_DIR, `${digest}.bin`)
    fs.writeFileSync(storagePath, whole)
    const r = db
      .prepare(
        `INSERT INTO attachments (filename, mime, size, sha256, storage_path, visibility, owner_hash, complete)
         VALUES (?,?,?,?,?,?,?,1)`
      )
      .run(
        meta.filename, meta.mime, whole.length, digest, storagePath,
        body.visibility === 'internal' ? 'internal' : 'private', meta.owner_hash
      )
    att = db.prepare('SELECT * FROM attachments WHERE id=?').get(r.lastInsertRowid)
  }
  db.prepare('INSERT OR IGNORE INTO idempotency (idempotency_key, scope, response_json) VALUES (?,?,?)')
    .run(idemKey, 'upload_complete', JSON.stringify({ sha256: digest, attachment_id: att.id }))
  fs.rmSync(tmpDir, { recursive: true, force: true })
  return { done: true, sha256: digest, attachment_id: att.id, filename: att.filename, size: att.size }
}

/** GET /api/feedback/attachments/:id/download —— 权限在这里收口 */
export async function downloadAttachment(req, res, attId, viewer, reporterHash, login) {
  // 鉴权必须在任何 await 之前完成：否则异常会逃逸出路由 try/catch 导致进程崩溃
  const att = db.prepare('SELECT * FROM attachments WHERE id=? AND complete=1').get(attId)
  const allowed =
    viewer === 'maintainer' ||
    (viewer === 'reporter' && reporterHash && att?.owner_hash === reporterHash)
  if (!att || !allowed) {
    // 公开访客：不暴露文件是否存在的差异，统一 403
    throw new HttpError(403, 'attachment access denied')
  }
  if (!fs.existsSync(att.storage_path)) throw new HttpError(410, 'file missing on storage')
  const stat = fs.statSync(att.storage_path)
  res.writeHead(200, {
    'content-type': att.mime || 'application/octet-stream',
    'content-length': stat.size,
    'content-disposition': `attachment; filename="${encodeURIComponent(att.filename)}"`,
    'cache-control': 'private, no-store'
  })
  await pipeline(fs.createReadStream(att.storage_path), res)
}
