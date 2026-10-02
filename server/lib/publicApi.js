import { db, sha256, randomToken, maskContact, requirePage, rebuildAffectedFromEvents, deriveEffectiveStatus } from './db.js'
import { HttpError, idempotent, addEvent } from './util.js'

function nextCode() {
  const n = db.prepare('SELECT COUNT(*) c FROM tickets').get().c + 1
  return `FB-${String(n).padStart(6, '0')}`
}

const KINDS = new Set(['example_failure', 'content_question'])

/**
 * POST /api/feedback/tickets
 * 公开访客提交。页面版/锚点/环境声明在此固化为不可变快照。
 */
export function createTicket(body) {
  const kind = body.kind
  if (!KINDS.has(kind)) throw new HttpError(400, 'kind must be example_failure | content_question')
  const title = String(body.title || '').trim().slice(0, 160)
  const text = String(body.body || '').trim()
  if (!title || !text) throw new HttpError(400, 'title and body are required')
  const pagePath = String(body.page_path || '').trim()
  if (!pagePath.startsWith('/')) throw new HttpError(400, 'page_path required (e.g. /components/button)')
  const anchor = body.anchor ? String(body.anchor) : null
  const docsVersion = body.docs_version ? String(body.docs_version) : null
  const versions = Array.isArray(body.affected_versions) && body.affected_versions.length
    ? [...new Set(body.affected_versions.map(String))]
    : (docsVersion ? [docsVersion] : [])

  // 环境声明：仅采集用于排查的非个人标识信息
  const env = body.env || {}
  const envSnapshot = {
    user_agent: String(env.user_agent || '').slice(0, 300),
    viewport: env.viewport ? String(env.viewport).slice(0, 40) : null,
    language: env.language ? String(env.language).slice(0, 20) : null,
    timezone: env.timezone ? String(env.timezone).slice(0, 40) : null,
    os: env.os ? String(env.os).slice(0, 80) : null,
    browser: env.browser ? String(env.browser).slice(0, 80) : null,
    url: env.url ? String(env.url).slice(0, 300) : null
  }

  const reporterToken = body.reporter_token || randomToken() // 客户端离线时会自带持久化 token
  const reporterHash = sha256(reporterToken)
  const label = `anon-${sha256(reporterToken + ':label').slice(0, 10)}`
  const contactMasked = maskContact(body.contact || null)

  // 可选：随提交附带已完成的附件 sha256 列表，绑定鉴权
  const attachmentShas = Array.isArray(body.attachments) ? body.attachments : []

  return idempotent('create_ticket', body.idempotency_key || null, () => {
    return db.transaction(() => {
      requirePage(pagePath)
      let code
      for (let i = 0; i < 10; i++) {
        code = nextCode()
        const exists = db.prepare('SELECT 1 FROM tickets WHERE code=?').get(code)
        if (!exists) break
      }
      const r = db
        .prepare(
          `INSERT INTO tickets
             (code, kind, title, body, page_path, anchor, docs_version, env_snapshot, lang,
              reporter_hash, reporter_label, contact_masked)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          code, kind, title, text, pagePath, anchor, docsVersion,
          JSON.stringify(envSnapshot), body.lang ? String(body.lang).slice(0, 8) : null,
          reporterHash, label, contactMasked
        )
      const ticketId = r.lastInsertRowid
      addEvent(ticketId, 'created', 'reporter', {
        kind, title, page_path: pagePath, anchor, docs_version: docsVersion, versions
      })
      if (versions.length) {
        addEvent(ticketId, 'affected_added', 'reporter', { versions })
      }
      // 附件绑定：必须 complete + 同 owner，防止把别人的上传挂到自己工单
      for (const sha of attachmentShas) {
        const a = db.prepare('SELECT * FROM attachments WHERE sha256=? AND complete=1').get(sha)
        if (!a) throw new HttpError(400, `attachment not complete: ${sha}`)
        if (a.owner_hash !== reporterHash) throw new HttpError(403, 'attachment belongs to another reporter')
        db.prepare('UPDATE attachments SET ticket_id=? WHERE id=?').run(ticketId, a.id)
      }
      rebuildAffectedFromEvents(ticketId)
      return {
        code,
        reporter_token: reporterToken, // 仅本次返回；服务端只存哈希
        query_url: `/feedback/?ticket=${code}`,
        attachments_bound: attachmentShas.length
      }
    })()
  })
}

/**
 * GET /api/feedback/tickets/:code
 * viewer: public(未鉴权) | reporter(带查询码) | maintainer
 */
export function viewTicket(code, viewer = 'public', reporterHash = null) {
  const t = db.prepare('SELECT * FROM tickets WHERE code=?').get(code)
  if (!t) throw new HttpError(404, 'ticket not found')

  const follow = db.prepare('SELECT * FROM tickets WHERE id=?')
  let primary = t
  const mergeChain = []
  const chainIds = []
  while (primary.merged_into) {
    mergeChain.push(primary.code) // 记录来源工单号（不丢来源）
    chainIds.push(primary.id)
    const parent = follow.get(primary.merged_into)
    if (!parent) break
    primary = parent
  }

  const rows = db
    .prepare('SELECT * FROM ticket_affected_versions WHERE ticket_id=? ORDER BY version')
    .all(primary.id)
  const effectiveStatus = deriveEffectiveStatus(rows)

  // 定位解析：公开访客只得到“已人工确认”的迁移结果；未确认提案不外泄
  const location = resolveLocation(primary.page_path, primary.anchor, viewer)

  // 事件流：主工单 + 所有被合并来源工单的事件全部保留（合并不丢来源）
  const rawEvents = db
    .prepare(
      `SELECT id, type, actor, payload_json, created_at, ticket_id
       FROM ticket_events WHERE ticket_id IN (${[primary.id, ...chainIds].map(() => '?').join(',')})
       ORDER BY id`
    )
    .all(primary.id, ...chainIds)
    .map((e) => ({
      ...e,
      payload_json: (() => {
        const p = JSON.parse(e.payload_json || '{}')
        if (e.ticket_id !== primary.id) p.source_ticket = db.prepare('SELECT code FROM tickets WHERE id=?').get(e.ticket_id)?.code
        return JSON.stringify(p)
      })()
    }))

  let events
  if (viewer === 'maintainer') {
    events = rawEvents.map((e) => ({ ...e, payload: JSON.parse(e.payload_json) }))
  } else {
    events = rawEvents
      .filter((e) => e.type !== 'status_override')
      .map((e) => {
        const p = JSON.parse(e.payload_json)
        const pub = {}
        for (const k of ['versions', 'fix_version', 'evidence', 'reason', 'at', 'to_path', 'to_anchor', 'source_ticket']) {
          if (p[k] !== undefined) pub[k] = p[k]
        }
        return { id: e.id, type: e.type, at: e.created_at, payload: pub }
      })
  }

  const attachments = db
    .prepare('SELECT id, filename, mime, size, sha256, visibility, ticket_id FROM attachments WHERE ticket_id=? AND complete=1')
    .all(primary.id)
  const visibleAttachments = attachments.map((a) => ({
    id: a.id, filename: a.filename, mime: a.mime, size: a.size,
    // 公开访客拿不到下载句柄；reporter 凭查询码可下自己的
    downloadable: viewer === 'maintainer' || (viewer === 'reporter' && a.visibility === 'private')
  }))

  const base = {
    code: primary.code,
    kind: primary.kind,
    title: primary.title,
    effective_status: effectiveStatus,
    submitted_at: primary.created_at,
    docs_version: primary.docs_version,
    location,
    affected_versions: rows.map((r) => ({
      version: r.version,
      state: r.state,
      fix_version: r.fix_version,
      evidence: viewer === 'public' ? sanitizeEvidence(r.evidence) : r.evidence,
      verified_at: r.verified_at
    })),
    events,
    attachments: visibleAttachments,
    merged_from_chain: mergeChain
  }

  if (viewer === 'maintainer') {
    return {
      ...base,
      body: primary.body,
      page_snapshot: { page_path: primary.page_path, anchor: primary.anchor },
      env_snapshot: JSON.parse(primary.env_snapshot),
      reporter_label: primary.reporter_label,
      contact_masked: primary.contact_masked,
      status_override: primary.status_override,
      override_by: primary.override_by,
      override_reason: primary.override_reason,
      lang: primary.lang
    }
  }
  if (viewer === 'reporter') {
    return { ...base, body: primary.body, own_ticket: true }
  }
  // public
  return {
    ...base,
    body: primary.body,
    reporter: primary.reporter_label,
    note: '未携带查询码：附件下载与联系方式不可见'
  }
}

function sanitizeEvidence(ev) {
  if (!ev) return null
  const s = String(ev)
  // 公开视图剥掉可能内嵌的内部链接，只保留事实描述
  return s.replace(/https?:\/\/[^\s)]+/g, '[link]').slice(0, 500)
}

/**
 * 定位解析：
 *  - 提交快照原定位始终保留（original）
 *  - 仅 confirmed 的迁移关系会对公开访客暴露 (confirmed_new_location)
 *  - 删段：段不存在，但工单仍指向该位置，标 section_deleted
 */
export function resolveLocation(pagePath, anchor, viewer = 'public') {
  const page = db.prepare('SELECT * FROM doc_pages WHERE page_path=?').get(pagePath)
  const result = { original_path: pagePath, original_anchor: anchor, section_status: 'active' }

  if (page) {
    result.current_path = page.current_path
    result.page_status = page.anchor_status
  }

  if (anchor && page) {
    const a = db.prepare('SELECT * FROM doc_anchors WHERE page_id=? AND anchor=?').get(page.id, anchor)
    if (a) {
      result.section_status = a.status
      if (a.status === 'deleted') result.section_deleted = true
    }
  }

  const all = page
    ? db
        .prepare(
          `SELECT m.* FROM page_migrations m WHERE m.page_id=?
           AND (m.from_anchor IS ? OR m.from_anchor = ?) ORDER BY m.id`
        )
        .all(page.id, anchor, anchor)
    : []
  const confirmed = all.find((m) => m.confirmed_at)
  if (confirmed) {
    result.confirmed_new_location = {
      path: confirmed.to_path,
      anchor: confirmed.to_anchor,
      confirmed_by: confirmed.confirmed_by,
      confirmed_at: confirmed.confirmed_at
    }
  } else if (viewer === 'maintainer') {
    const pending = all.find((m) => !m.confirmed_at)
    if (pending) {
      result.pending_migration = {
        path: pending.to_path, anchor: pending.to_anchor,
        proposed_by: pending.proposed_by, proposed_at: pending.proposed_at
      }
    }
  }
  return result
}

/** GET /api/feedback/lookup?path=&anchor= 公开解析旧链接（只返回已确认迁移） */
export function lookupLocation(query) {
  const p = String(query.path || '')
  if (!p.startsWith('/')) throw new HttpError(400, 'path required')
  return resolveLocation(p, query.anchor ? String(query.anchor) : null, 'public')
}

export function authenticateViewer(query, headers) {
  const code = String(query.ticket || '').toUpperCase()
  const token = query.token || (headers['x-reporter-token'] || null)
  if (token) {
    const t = db.prepare('SELECT * FROM tickets WHERE code=?').get(code)
    if (t && t.reporter_hash === sha256(token)) return { viewer: 'reporter', hash: t.reporter_hash }
  }
  return { viewer: 'public', hash: null }
}
