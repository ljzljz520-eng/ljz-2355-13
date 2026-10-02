import { createServer } from 'node:http'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from './store.js'
import { hashToken, sha256Hex } from './crypto.js'
import { requireMaintainer } from './auth.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UPLOAD_DIR = process.env.FEEDBACK_UPLOADS || path.join(__dirname, '..', 'uploads')

export function createApp(store) {
  // 简化路由：[method, pattern(regex), auth]
  const routes = []
  const add = (method, re, handler, opts = {}) => routes.push({ method, re, handler, ...opts })

  // -------- 健康检查 --------
  add('GET', /^\/api\/health$/, () => ({ ok: true, service: 'doc-feedback', time: Date.now() }))

  // -------- 公开：修订摘要（只含已核实事实） --------
  add('GET', /^\/api\/public\/revision-summary$/, () => ({ summaries: store.publicSummaries() }))
  add('GET', /^\/api\/public\/releases$/, () => ({ releases: store.stmts.listReleases.all() }))

  // -------- 公开：页面位置解析（旧定位 + 已确认迁移后的新位置） --------
  add('GET', /^\/api\/public\/locations\/resolve$/, (req, body, q) => {
    const r = store.resolveLocation(q.get('version'), q.get('path'), q.get('anchor'))
    return r
  })

  // -------- 公开：某页面的反馈（最小披露视图） --------
  add('GET', /^\/api\/public\/tickets$/, (req, body, q) => ({
    tickets: store.ticketsForLocation(q.get('path') || '/')
  }))

  // -------- 公开：按工单编号查询（不泄露身份与附件细节） --------
  add('GET', /^\/api\/tickets\/([\w-]+)$/, (req, body, q, m) => {
    const token = q.get('token')
    if (token) {
      const view = store.getTicketByReceipt(m[1], token)
      if (!view) throw err(404, 'ticket_or_token_invalid')
      return view
    }
    const view = store.getTicketPublic(m[1])
    if (!view) throw err(404, 'ticket_not_found')
    return view
  })

  // -------- 访客提交工单（幂等键 + 页面版/锚点/环境声明） --------
  add('POST', /^\/api\/tickets$/, (req, body) => {
    const required = ['idempotencyKey', 'category', 'title', 'body', 'pageVersion', 'pagePath']
    for (const k of required) {
      if (!body || body[k] === undefined || body[k] === '') throw err(400, `missing_${k}`)
    }
    if (!['example_failure', 'content_question', 'other'].includes(body.category)) {
      throw err(400, 'invalid_category')
    }
    if (body.title.length > 200 || body.body.length > 10000) throw err(400, 'content_too_long')
    if (typeof body.idempotencyKey !== 'string' || body.idempotencyKey.length < 8) {
      throw err(400, 'bad_idempotency_key')
    }
    const result = store.createTicket({
      idempotencyKey: body.idempotencyKey,
      category: body.category,
      title: body.title,
      body: body.body,
      contact: body.contact || null,
      contactDisplay: body.contactDisplay,
      pageVersion: body.pageVersion,
      pagePath: body.pagePath,
      pageAnchor: body.pageAnchor || null,
      headingSnapshot: body.headingSnapshot || null,
      affectedVersions: body.affectedVersions || null,
      uploadIds: body.uploadIds || [],
      env: {
        userAgent: req.headers['user-agent'] || null,
        language: body.env?.language || null,
        viewport: body.env?.viewport || null,
        url: body.env?.url || null,
        extra: body.env?.extra || null
      }
    })
    if (result.idempotent_replay === false) {
      const meta = new Map((body.attachments || []).map((a) => [a.uploadId, a]))
      for (const uploadId of body.uploadIds || []) {
        const visibility = meta.get(uploadId)?.visibility
        try {
          store.attachToTicket(result.ticket.id, uploadId, {
            visibility: visibility === 'public' ? 'public' : 'maintainer_only'
          })
        } catch (e) {
          if (e.code !== 'upload_not_ready') throw e
        }
      }
      result.ticket = store.getTicketPublic(result.ticket.id)
    }
    return result
  })

  // -------- 分片上传（可恢复；未提交工单也可先传） --------
  add('POST', /^\/api\/uploads$/, (req, body, q, m, raw) => {
    const hash = body.viewerToken ? hashToken(body.viewerToken) : null
    return store.createUpload({
      filename: body.filename,
      contentType: body.contentType,
      totalSize: body.totalSize,
      chunkSize: body.chunkSize,
      viewerTokenHash: hash
    })
  })

  add('GET', /^\/api\/uploads\/([\w-]+)$/, (req, body, q, m) =>
    store.getUploadStatus(m[1]))

  add('PUT', /^\/api\/uploads\/([\w-]+)\/chunks\/(\d+)$/, async (req, body, q, m, buf) => {
    const up = store.stmts.getUpload.get(m[1])
    if (!up) throw err(404, 'upload_not_found')
    const idx = parseInt(m[2], 10)
    if (idx < 0 || idx >= up.total_chunks) throw err(400, 'chunk_index_out_of_range')
    // 已落库分片直接幂等响应（重复网络回执/中断后续传不重写）
    const existed = store.db
      .prepare('SELECT 1 FROM upload_chunks WHERE upload_id=? AND chunk_index=?')
      .get(m[1], idx)
    if (existed) return { uploadId: m[1], index: idx, duplicate: true, received: true }
    const expected = parseInt((q.get('size') || '0'), 10)
    if (expected && buf.length !== expected) throw err(400, 'chunk_size_mismatch')
    await writeFile(chunkPath(m[1], idx), buf)
    const hash = q.get('sha256') === '1' ? sha256Hex(buf) : null
    return store.putChunk(m[1], idx, buf, hash)
  }, { rawBody: true })

  add('POST', /^\/api\/uploads\/([\w-]+)\/complete$/, async (req, body, q, m) => {
    const up = store.stmts.getUpload.get(m[1])
    if (!up) throw err(404, 'upload_not_found')
    const res = store.completeUpload(m[1], body?.sha256 || null)
    if (!res.idempotent_replay) await concatChunks(up)
    return { ...res, attachmentReady: true }
  })

  add('POST', /^\/api\/uploads\/([\w-]+)\/abort$/, (req, body, q, m) => {
    store.abortUpload(m[1])
    return { ok: true }
  })

  // -------- 维护者：工单列表 --------
  add('GET', /^\/api\/maintainer\/tickets$/, (req) => {
    requireMaintainer(req, store)
    return { tickets: store.listMaintainerTickets() }
  }, { auth: true })

  // -------- 维护者：工单详情 --------
  add('GET', /^\/api\/maintainer\/tickets\/([\w-]+)$/, (req, body, q, m) => {
    requireMaintainer(req, store)
    const view = store.getTicketMaintainer(m[1])
    if (!view) throw err(404, 'ticket_not_found')
    return view
  }, { auth: true })

  // -------- 维护者：追加受影响版本 --------
  add('POST', /^\/api\/maintainer\/tickets\/([\w-]+)\/affected$/, (req, body, q, m) => {
    const actor = requireMaintainer(req, store).username
    return store.addAffectedVersion(m[1], body.docVersion, actor, idem(req, body))
  }, { auth: true })

  // -------- 维护者：登记修复证据 --------
  add('POST', /^\/api\/maintainer\/tickets\/([\w-]+)\/fix$/, (req, body, q, m) => {
    const actor = requireMaintainer(req, store).username
    return store.submitFix(m[1], {
      docVersion: body.docVersion, fixVersion: body.fixVersion, evidence: body.evidence
    }, actor, idem(req, body))
  }, { auth: true })

  // -------- 维护者：在新版本验证有效（修复完成必须指出新版本） --------
  add('POST', /^\/api\/maintainer\/tickets\/([\w-]+)\/verify$/, (req, body, q, m) => {
    const actor = requireMaintainer(req, store).username
    return store.verifyFix(m[1], {
      docVersion: body.docVersion, verifiedVersion: body.verifiedVersion
    }, actor, idem(req, body))
  }, { auth: true })

  // -------- 维护者：复开 --------
  add('POST', /^\/api\/maintainer\/tickets\/([\w-]+)\/reopen$/, (req, body, q, m) => {
    const actor = requireMaintainer(req, store).username
    return store.reopen(m[1], { docVersion: body.docVersion, reason: body.reason }, actor, idem(req, body))
  }, { auth: true })

  // -------- 维护者：直接改状态（落事件、带原因） --------
  add('POST', /^\/api\/maintainer\/tickets\/([\w-]+)\/status$/, (req, body, q, m) => {
    const actor = requireMaintainer(req, store).username
    return store.manualStatusChange(m[1], { status: body.status, reason: body.reason }, actor, idem(req, body))
  }, { auth: true })

  // -------- 维护者：评论 --------
  add('POST', /^\/api\/maintainer\/tickets\/([\w-]+)\/comments$/, (req, body, q, m) => {
    const actor = requireMaintainer(req, store).username
    return store.addComment(m[1], actor, body.text, idem(req, body))
  }, { auth: true })

  // -------- 维护者：合并工单（幂等，来源不丢失） --------
  add('POST', /^\/api\/maintainer\/merge$/, (req, body) => {
    const actor = requireMaintainer(req, store).username
    return store.mergeTickets(body.sourceId, body.targetId, actor, idem(req, body), body.reason || null)
  }, { auth: true })

  // -------- 维护者：迁移提案列表 / 确认 / 拒绝 --------
  add('GET', /^\/api\/maintainer\/migrations$/, (req) => {
    requireMaintainer(req, store)
    return { migrations: store.listPendingMigrations() }
  }, { auth: true })

  add('POST', /^\/api\/maintainer\/migrations$/, (req, body) => {
    requireMaintainer(req, store)
    return store.proposeMigration(body)
  }, { auth: true })

  add('POST', /^\/api\/maintainer\/migrations\/(\d+)\/confirm$/, (req, body, q, m) => {
    const actor = requireMaintainer(req, store).username
    return store.confirmMigration(parseInt(m[1], 10), actor, idem(req, body))
  }, { auth: true })

  add('POST', /^\/api\/maintainer\/migrations\/(\d+)\/reject$/, (req, body, q, m) => {
    const actor = requireMaintainer(req, store).username
    return store.rejectMigration(parseInt(m[1], 10), actor, idem(req, body))
  }, { auth: true })

  // -------- 维护者：文档删段 --------
  add('POST', /^\/api\/maintainer\/sections\/deleted$/, (req, body) => {
    const actor = requireMaintainer(req, store).username
    return store.markSectionDeleted({
      pageVersion: body.pageVersion, pagePath: body.pagePath, pageAnchor: body.pageAnchor
    }, actor, idem(req, body))
  }, { auth: true })

  // -------- 维护者：发布版本 --------
  add('POST', /^\/api\/maintainer\/releases$/, (req, body) => {
    requireMaintainer(req, store)
    return store.upsertRelease(body.version, body.notes || null)
  }, { auth: true })

  // -------- 维护者：创建/发布公开修订摘要 --------
  add('POST', /^\/api\/maintainer\/revision-summaries$/, (req, body) => {
    const actor = requireMaintainer(req, store).username
    return store.createSummary({
      ticketId: body.ticketId, docVersion: body.docVersion,
      fixedVersion: body.fixedVersion, summary: body.summary
    }, actor, idem(req, body))
  }, { auth: true })

  add('POST', /^\/api\/maintainer\/revision-summaries\/(\d+)\/publish$/, (req, body, q, m) => {
    const actor = requireMaintainer(req, store).username
    return store.publishSummary(parseInt(m[1], 10), actor, idem(req, body))
  }, { auth: true })

  // -------- 维护者：附件下载（默认不公开；公开附件走 public 接口） --------
  add('GET', /^\/api\/maintainer\/attachments\/([\w-]+)\/download$/, async (req, body, q, m) => {
    requireMaintainer(req, store)
    const att = store.stmts.getAttachment.get(m[1])
    if (!att) throw err(404, 'attachment_not_found')
    return serveAttachment(att, store)
  }, { auth: true, binaryResponse: true })

  add('GET', /^\/api\/public\/attachments\/([\w-]+)\/download$/, async (req, body, q, m) => {
    const att = store.stmts.getAttachment.get(m[1])
    if (!att) throw err(404, 'attachment_not_found')
    if (att.visibility !== 'public') throw err(403, 'attachment_not_public')
    return serveAttachment(att, store)
  }, { binaryResponse: true })

  const server = createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://localhost')
      if (u.pathname === '/' || u.pathname === '/console') {
        const html = await readFile(path.join(__dirname, '..', 'console.html'), 'utf-8')
        if (u.pathname === '/') {
          res.writeHead(302, { Location: '/console' })
          return res.end()
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        return res.end(html)
      }
      const q = u.searchParams
      const route = routes.find((r) => r.method === req.method && r.re.test(u.pathname))
      if (!route) return sendJson(res, 404, { error: 'not_found' })

      // auth 标记的路由若未提供凭据，handler 内自行抛 401
      let parsedBody
      let rawBuf = Buffer.alloc(0)
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        rawBuf = await readBody(req)
        if (route.rawBody) {
          parsedBody = {}
        } else if (rawBuf.length) {
          try {
            parsedBody = JSON.parse(rawBuf.toString('utf8'))
          } catch {
            throw err(400, 'invalid_json')
          }
        } else {
          parsedBody = {}
        }
      }

      const match = u.pathname.match(route.re)
      const result = await route.handler(req, parsedBody, q, match, rawBuf)
      if (route.binaryResponse) {
        const { status = 200, headers = {}, body: outBuf } = result
        res.writeHead(status, headers)
        res.end(outBuf)
      } else {
        sendJson(res, 200, result)
      }
    } catch (e) {
      const status = e.status || 500
      if (status === 401) {
        res.setHeader('WWW-Authenticate', 'Basic realm="doc-feedback-maintainer"')
      }
      sendJson(res, status, { error: e.code || 'internal_error', message: e.message, details: e.details })
    }
  })

  return server
}

function idem(req, body) {
  return body?.idempotencyKey || req.headers['x-idempotency-key'] ||
    `auto-${req.method}-${req.url}-${JSON.stringify(body)}`
}

function err(status, code) {
  const e = new Error(code)
  e.status = status
  e.code = code
  return e
}

function chunkPath(uploadId, idx) {
  return path.join(UPLOAD_DIR, `${uploadId}.part${idx}`)
}

async function concatChunks(up) {
  const { createWriteStream } = await import('node:fs')
  const final = path.join(UPLOAD_DIR, `${up.upload_id}.bin`)
  // 简化：逐块拼接（测试文件较小）
  const { appendFile } = await import('node:fs/promises')
  await rm(final, { force: true })
  for (let i = 0; i < up.total_chunks; i++) {
    const p = chunkPath(up.upload_id, i)
    if (!existsSync(p)) throw Object.assign(new Error('chunk_file_missing'), { status: 409, code: 'chunks_missing' })
    const data = await readFile(p)
    await appendFile(final, data)
  }
  return final
}

async function serveAttachment(att, store) {
  const up = store.stmts.getUpload.get(att.upload_id)
  const file = path.join(UPLOAD_DIR, `${att.upload_id}.bin`)
  if (!existsSync(file)) throw err(404, 'attachment_file_missing')
  const data = await readFile(file)
  return {
    status: 200,
    headers: {
      'Content-Type': att.content_type || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(att.filename)}"`,
      'X-Attachment-Visibility': att.visibility
    },
    body: data
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > 50 * 1024 * 1024) {
        reject(Object.assign(new Error('payload_too_large'), { status: 413, code: 'payload_too_large' }))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function sendJson(res, status, obj) {
  const json = JSON.stringify(obj)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store'
  })
  res.end(json)
}
