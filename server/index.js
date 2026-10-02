import http from 'node:http'
import { URL } from 'node:url'
import { send, readJson, HttpError, authMaintainer } from './lib/util.js'
import { sha256 } from './lib/db.js'
import { createTicket, viewTicket, lookupLocation, authenticateViewer } from './lib/publicApi.js'
import { initUpload, putChunk, status as uploadStatus, completeUpload, downloadAttachment } from './lib/attachmentApi.js'
import {
  addAffected, fixProposed, fixVerified, reopen, statusOverride, mergeTickets,
  proposeMigration, confirmMigration, sectionDeleted, upsertRelease, publicChangelog, listTickets
} from './lib/maintainerApi.js'

const PORT = Number(process.env.PORT || 8790)

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const p = u.pathname
  const q = Object.fromEntries(u.searchParams)
  try {
    // ---------- 公开接口 ----------
    if (p === '/api/health' && req.method === 'GET') {
      return send(res, 200, { ok: true })
    }
    if (p === '/api/feedback/tickets' && req.method === 'POST') {
      const body = await readJson(req)
      return send(res, 201, createTicket(body))
    }
    const ticketGet = p.match(/^\/api\/feedback\/tickets\/(FB-\d+)$/)
    if (ticketGet && req.method === 'GET') {
      const { viewer, hash } = authenticateViewer(q, req.headers)
      return send(res, 200, viewTicket(ticketGet[1], viewer, hash))
    }
    if (p === '/api/feedback/lookup' && req.method === 'GET') {
      return send(res, 200, lookupLocation(q))
    }
    if (p === '/api/feedback/changelog' && req.method === 'GET') {
      return send(res, 200, publicChangelog(q))
    }

    // 附件：分片上传（公开访客可匿名上传，但只由自己的 token 管理）
    if (p === '/api/feedback/uploads/init' && req.method === 'POST') {
      return send(res, 200, initUpload(await readJson(req)))
    }
    const chunk = p.match(/^\/api\/feedback\/uploads\/([^/]+)\/chunks\/(\d+)$/)
    if (chunk && req.method === 'PUT') {
      const token = q.reporter_token || req.headers['x-reporter-token']
      return send(res, 200, await putChunk(req, chunk[1], chunk[2], q, token))
    }
    const up = p.match(/^\/api\/feedback\/uploads\/([^/]+)\/(status|complete)$/)
    if (up && req.method === 'GET' && up[2] === 'status') {
      return send(res, 200, uploadStatus(up[1], q.reporter_token))
    }
    if (up && req.method === 'POST' && up[2] === 'complete') {
      return send(res, 200, await completeUpload(await readJson(req), up[1]))
    }
    const dl = p.match(/^\/api\/feedback\/attachments\/(\d+)\/download$/)
    if (dl && req.method === 'GET') {
      const { viewer, hash } = authenticateViewer({ ticket: q.ticket || '', token: q.token }, req.headers)
      // 维护者 token 优先
      let login = null
      try { login = authMaintainer(req) } catch {}
      return await downloadAttachment(req, res, Number(dl[1]), login ? 'maintainer' : viewer, hash, login)
    }

    // ---------- 维护者接口 ----------
    const mTicket = p.match(/^\/api\/maintainer\/tickets\/(FB-\d+)\/(affected|fix-proposed|fix-verified|reopen|status)$/)
    if (mTicket && req.method === 'POST') {
      const login = authMaintainer(req)
      const body = await readJson(req)
      const [, code, action] = mTicket
      const fn = {
        affected: addAffected,
        'fix-proposed': fixProposed,
        'fix-verified': fixVerified,
        reopen,
        status: statusOverride
      }[action]
      return send(res, 200, fn(code, body, login))
    }
    if (p === '/api/maintainer/merge' && req.method === 'POST') {
      const login = authMaintainer(req)
      return send(res, 200, mergeTickets(await readJson(req), login))
    }
    if (p === '/api/maintainer/pages/migrate' && req.method === 'POST') {
      const login = authMaintainer(req)
      return send(res, 200, proposeMigration(await readJson(req), login))
    }
    const conf = p.match(/^\/api\/maintainer\/pages\/migrate\/(\d+)\/confirm$/)
    if (conf && req.method === 'POST') {
      const login = authMaintainer(req)
      return send(res, 200, confirmMigration(Number(conf[1]), await readJson(req), login))
    }
    if (p === '/api/maintainer/pages/section-deleted' && req.method === 'POST') {
      const login = authMaintainer(req)
      return send(res, 200, sectionDeleted(await readJson(req), login))
    }
    if (p === '/api/maintainer/releases' && req.method === 'POST') {
      authMaintainer(req)
      return send(res, 200, upsertRelease(await readJson(req)))
    }
    if (p === '/api/maintainer/tickets' && req.method === 'GET') {
      authMaintainer(req)
      return send(res, 200, listTickets(q))
    }
    const mGet = p.match(/^\/api\/maintainer\/tickets\/(FB-\d+)$/)
    if (mGet && req.method === 'GET') {
      authMaintainer(req)
      return send(res, 200, viewTicket(mGet[1], 'maintainer'))
    }

    send(res, 404, { error: 'not found', path: p })
  } catch (err) {
    if (err instanceof HttpError) {
      if (res.headersSent) return req.destroy()
      return send(res, err.status, { error: err.message, details: err.details || undefined })
    }
    console.error('[server error]', err)
    if (!res.headersSent) send(res, 500, { error: 'internal error' })
  }
})

server.listen(PORT, () => {
  console.log(`feedback api listening on http://localhost:${PORT}`)
})

export { server }
