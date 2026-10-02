import { openDb } from './db.js'
import { newId, uuid, hashPassword, verifyPassword, hashToken, generateViewerToken } from './crypto.js'

const now = () => Date.now()

// 工单“整体状态”由事件流推导：直接改状态与修复证据驱动的状态都只是事件
// 优先级规则（取最新的关键事件），复开可覆盖解决，人工改状态不抹证据链。
const STATUS_EVENTS = new Set(['manual_status_change', 'fix_submitted', 'fix_verified', 'reopened'])

export function deriveStatus(events) {
  let status = 'open'
  for (const e of events) {
    if (!STATUS_EVENTS.has(e.event_type)) continue
    switch (e.event_type) {
      case 'manual_status_change':
        status = e.to_value
        break
      case 'fix_submitted':
        status = 'fix_submitted'
        break
      case 'fix_verified':
        status = 'resolved'
        break
      case 'reopened':
        status = 'open'
        break
    }
  }
  // 合并后工单以目标工单为准，源工单标记 merged（来源仍可查）
  if (events.some((e) => e.event_type === 'merged_into')) status = 'merged'
  return status
}

export class Store {
  constructor(filename) {
    this.db = openDb(filename)
    this.#prepare()
  }

  #spSeq = 0

  #prepare() {
    const d = this.db
    this.stmts = {
      insertTicket: d.prepare(`INSERT INTO tickets
        (id,idempotency_key,category,title,body,contact,contact_display,viewer_token_hash,
         page_version,page_path,page_anchor,heading_snapshot,
         env_user_agent,env_language,env_viewport,env_url,env_extra,created_at,updated_at)
        VALUES (@id,@idempotency_key,@category,@title,@body,@contact,@contact_display,@viewer_token_hash,
         @page_version,@page_path,@page_anchor,@heading_snapshot,
         @env_user_agent,@env_language,@env_viewport,@env_url,@env_extra,@created_at,@updated_at)`),
      getTicketByIdemKey: d.prepare('SELECT * FROM tickets WHERE idempotency_key = ?'),
      getTicket: d.prepare('SELECT * FROM tickets WHERE id = ?'),
      getTicketByToken: d.prepare('SELECT * FROM tickets WHERE id = ? AND viewer_token_hash = ?'),
      listTickets: d.prepare('SELECT * FROM tickets ORDER BY created_at DESC'),
      insertEvent: d.prepare(`INSERT INTO ticket_events
        (ticket_id,event_type,actor,from_value,to_value,doc_version,payload_json,created_at)
        VALUES (@ticket_id,@event_type,@actor,@from_value,@to_value,@doc_version,@payload_json,@created_at)`),
      listEvents: d.prepare('SELECT * FROM ticket_events WHERE ticket_id = ? ORDER BY id ASC'),
      addAffected: d.prepare(`INSERT INTO ticket_affected_versions
        (ticket_id,doc_version,status,created_at,updated_at) VALUES (?,?,?,?,?)
        ON CONFLICT(ticket_id, doc_version) DO NOTHING`),
      getAffected: d.prepare('SELECT * FROM ticket_affected_versions WHERE ticket_id = ?'),
      getAffectedOne: d.prepare('SELECT * FROM ticket_affected_versions WHERE ticket_id = ? AND doc_version = ?'),
      updateAffectedFix: d.prepare(`UPDATE ticket_affected_versions
        SET status='fix_submitted', fix_version=?, fix_evidence=?, updated_at=?
        WHERE ticket_id=? AND doc_version=?`),
      updateAffectedVerified: d.prepare(`UPDATE ticket_affected_versions
        SET status='resolved', verified_version=?, updated_at=? WHERE ticket_id=? AND doc_version=?`),
      reopenAffected: d.prepare(`UPDATE ticket_affected_versions
        SET status='open', updated_at=? WHERE ticket_id=? AND doc_version=? AND status != 'open'`),
      insertMerge: d.prepare(`INSERT OR IGNORE INTO ticket_merges
        (source_ticket_id,target_ticket_id,merged_by,reason,created_at) VALUES (?,?,?,?,?)`),
      wasMerged: d.prepare('SELECT 1 FROM ticket_merges WHERE source_ticket_id=? AND target_ticket_id=?'),
      listMergeSources: d.prepare('SELECT * FROM ticket_merges WHERE target_ticket_id = ?'),
      listMergeTargets: d.prepare('SELECT * FROM ticket_merges WHERE source_ticket_id = ?'),
      findLocation: d.prepare('SELECT * FROM page_locations WHERE page_version=? AND page_path=? AND COALESCE(page_anchor,\'\')=COALESCE(?,\'\')'),
      insertLocation: d.prepare(`INSERT INTO page_locations
        (page_version,page_path,page_anchor,heading_snapshot,status) VALUES (?,?,?,?,'active')
        ON CONFLICT(page_version,page_path,page_anchor) DO NOTHING`),
      markLocation: d.prepare(`UPDATE page_locations SET status=?
        WHERE page_version=? AND page_path=? AND COALESCE(page_anchor,'')=COALESCE(?,'')`),
      insertMigration: d.prepare(`INSERT INTO page_migrations
        (source_version,source_path,source_anchor,target_version,target_path,target_anchor,
         status,proposed_by,created_at) VALUES (?,?,?,?,?,?,'pending','system',?)`),
      findPendingMigration: d.prepare(`SELECT * FROM page_migrations
        WHERE source_version=? AND source_path=? AND COALESCE(source_anchor,'')=COALESCE(?,'')
        AND target_version=? AND target_path=? AND COALESCE(target_anchor,'')=COALESCE(?,'') AND status='pending'`),
      getMigration: d.prepare('SELECT * FROM page_migrations WHERE id=?'),
      confirmMigration: d.prepare(`UPDATE page_migrations SET status='confirmed', confirmed_by=?, confirmed_at=? WHERE id=? AND status='pending'`),
      listPendingMigrations: d.prepare("SELECT * FROM page_migrations WHERE status='pending' ORDER BY id"),
      confirmedMigrationFor: d.prepare(`SELECT * FROM page_migrations
        WHERE source_version=? AND source_path=? AND COALESCE(source_anchor,'')=COALESCE(?,'') AND status='confirmed'
        ORDER BY confirmed_at DESC LIMIT 1`),
      insertUpload: d.prepare(`INSERT INTO upload_sessions
        (upload_id,filename,content_type,total_size,chunk_size,total_chunks,viewer_token_hash,created_at)
        VALUES (?,?,?,?,?,?,?,?)`),
      getUpload: d.prepare('SELECT * FROM upload_sessions WHERE upload_id=?'),
      insertChunk: d.prepare(`INSERT OR IGNORE INTO upload_chunks
        (upload_id,chunk_index,size_bytes,sha256,received_at) VALUES (?,?,?,?,?)`),
      listChunks: d.prepare('SELECT chunk_index FROM upload_chunks WHERE upload_id=? ORDER BY chunk_index'),
      completeUploadRow: d.prepare(`UPDATE upload_sessions SET status='completed', ticket_id=?, completed_at=? WHERE upload_id=? AND status='open'`),
      bindUploadTicket: d.prepare('UPDATE upload_sessions SET ticket_id=? WHERE upload_id=?'),
      abortUpload: d.prepare("UPDATE upload_sessions SET status='aborted' WHERE upload_id=? AND status='open'"),
      insertAttachment: d.prepare(`INSERT INTO attachments
        (id,ticket_id,upload_id,filename,content_type,size_bytes,sha256,visibility,uploaded_by,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`),
      listAttachments: d.prepare('SELECT * FROM attachments WHERE ticket_id=? ORDER BY created_at'),
      getAttachment: d.prepare('SELECT * FROM attachments WHERE id=?'),
      upsertMaintainer: d.prepare(`INSERT INTO maintainers (username,password_hash,display_name,role,created_at)
        VALUES (?,?,?,?,?) ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash, display_name=excluded.display_name`),
      getMaintainer: d.prepare('SELECT * FROM maintainers WHERE username=?'),
      getRelease: d.prepare('SELECT * FROM doc_releases WHERE version=?'),
      upsertRelease: d.prepare(`INSERT INTO doc_releases (version,released_at,notes,is_published) VALUES (?,?,?,1)
        ON CONFLICT(version) DO UPDATE SET released_at=excluded.released_at, notes=excluded.notes, is_published=1`),
      listReleases: d.prepare('SELECT * FROM doc_releases WHERE is_published=1 ORDER BY released_at DESC'),
      insertSummary: d.prepare(`INSERT INTO revision_summaries
        (ticket_id,doc_version,fixed_version,summary,status,verified_at,created_by,created_at)
        VALUES (?,?,?,?,'draft',?,?,?)`),
      getSummary: d.prepare('SELECT * FROM revision_summaries WHERE id=?'),
      publishSummary: d.prepare(`UPDATE revision_summaries SET status='published', published_at=?
        WHERE id=? AND status='draft'`),
      listPublicSummaries: d.prepare(`SELECT rs.* FROM revision_summaries rs
        WHERE rs.status='published' ORDER BY rs.published_at DESC`),
      getIdemAction: d.prepare('SELECT * FROM action_idempotency WHERE idempotency_key=?'),
      putIdemAction: d.prepare(`INSERT OR IGNORE INTO action_idempotency
        (idempotency_key,actor,action,result_json,created_at) VALUES (?,?,?,?,?)`),
      ticketsByPath: d.prepare('SELECT * FROM tickets WHERE page_path=? ORDER BY created_at DESC'),
      searchTicketsPath: d.prepare(`SELECT DISTINCT page_path, page_version, page_anchor FROM tickets
        WHERE page_path LIKE ? ORDER BY page_version DESC`)
    }
  }

  #event(ticket_id, event_type, actor, { from = null, to = null, docVersion = null, payload = null } = {}) {
    this.stmts.insertEvent.run({
      ticket_id, event_type, actor,
      from_value: from, to_value: to, doc_version: docVersion,
      payload_json: payload ? JSON.stringify(payload) : null,
      created_at: now()
    })
    this.db.prepare('UPDATE tickets SET updated_at=? WHERE id=?').run(now(), ticket_id)
  }

  // -- 维护者幂等包装：重复回执（网络重试/两个维护者重复操作）返回同一结果 --------
  #withIdempotency(key, actor, action, fn) {
    const existing = this.stmts.getIdemAction.get(key)
    if (existing) return { idempotent_replay: true, result: JSON.parse(existing.result_json) }
    const sp = `sp_${Date.now().toString(36)}_${(this.#spSeq++).toString(36)}`
    this.db.exec(`SAVEPOINT ${sp}`)
    try {
      const result = fn(sp)
      this.stmts.putIdemAction.run(key, actor, action, JSON.stringify(result), now())
      this.db.exec(`RELEASE SAVEPOINT ${sp}`)
      return { idempotent_replay: false, result }
    } catch (err) {
      this.db.exec(`ROLLBACK TO SAVEPOINT ${sp}`)
      this.db.exec(`RELEASE SAVEPOINT ${sp}`)
      throw err
    }
  }

  // ===========================================================================
  // 访客提交（幂等键；保存页面版、锚点、环境声明）
  // ===========================================================================
  createTicket(input) {
    const d = this.stmts.getTicketByIdemKey.get(input.idempotencyKey)
    if (d) {
      return { idempotent_replay: true, ticket: this.#ticketView(d), receipt: this.#receiptFor(d) }
    }
    const id = this.#nextTicketId()
    const { token, hash } = generateViewerToken()
    const ts = now()
    const t = {
      id,
      idempotency_key: input.idempotencyKey,
      category: input.category,
      title: input.title,
      body: input.body,
      contact: input.contact || null,
      contact_display: input.contactDisplay === 'public' ? 'public' : 'private',
      viewer_token_hash: hash,
      page_version: input.pageVersion,
      page_path: input.pagePath,
      page_anchor: input.pageAnchor || null,
      heading_snapshot: input.headingSnapshot || null,
      env_user_agent: input.env?.userAgent || null,
      env_language: input.env?.language || null,
      env_viewport: input.env?.viewport || null,
      env_url: input.env?.url || null,
      env_extra: input.env?.extra ? JSON.stringify(input.env.extra) : null,
      created_at: ts,
      updated_at: ts
    }
    const savepoint = this.db.transaction(() => {
      this.stmts.insertTicket.run(t)
      this.#event(id, 'created', 'visitor', {
        payload: { page_version: t.page_version, page_path: t.page_path, page_anchor: t.page_anchor }
      })
      const versions = input.affectedVersions?.length ? input.affectedVersions : [t.page_version]
      for (const v of versions) this.stmts.addAffected.run(id, v, 'open', ts, ts)
      // 登记/更新页面定位
      this.stmts.insertLocation.run(t.page_version, t.page_path, t.page_anchor, t.heading_snapshot)
    })
    savepoint()
    const row = this.stmts.getTicket.get(id)
    return { idempotent_replay: false, ticket: this.#ticketView(row), receipt: { ticketId: id, viewerToken: token } }
  }

  #nextTicketId() {
    const row = this.db.prepare("SELECT id FROM tickets WHERE id LIKE 'TKT-%' ORDER BY id DESC LIMIT 1").get()
    const n = row ? parseInt(row.id.slice(4), 10) + 1 : 1
    return `TKT-${String(n).padStart(6, '0')}`
  }

  // ===========================================================================
  // 受影响版本：同一问题跨多个版本，逐版本跟踪，不能简单合成一条“已解决”
  // ===========================================================================
  addAffectedVersion(ticketId, docVersion, actor, idemKey) {
    return this.#withIdempotency(idemKey, actor, 'affected_added', () => {
      const t = this.stmts.getTicket.get(ticketId)
      if (!t) throw httpError(404, 'ticket_not_found')
      const ts = now()
      this.stmts.addAffected.run(ticketId, docVersion, 'open', ts, ts)
      this.#event(ticketId, 'affected_added', actor, { to: docVersion })
      return { ticketId, docVersion, affected: this.stmts.getAffected.all(ticketId) }
    })
  }

  // 登记修复证据（指出声称修复的新版本）—— 依据证据生成状态，而非手改
  submitFix(ticketId, { docVersion, fixVersion, evidence }, actor, idemKey) {
    return this.#withIdempotency(idemKey, actor, 'fix_submitted', () => {
      const t = this.stmts.getTicket.get(ticketId)
      if (!t) throw httpError(404, 'ticket_not_found')
      const aff = this.stmts.getAffectedOne.get(ticketId, docVersion)
      if (!aff) throw httpError(409, 'affected_version_not_found')
      if (!fixVersion) throw httpError(400, 'fix_version_required')
      const ts = now()
      this.stmts.updateAffectedFix.run(fixVersion, evidence || null, ts, ticketId, docVersion)
      this.#event(ticketId, 'fix_submitted', actor, {
        docVersion, to: fixVersion, payload: { evidence: evidence || null }
      })
      return this.#ticketView(this.stmts.getTicket.get(ticketId))
    })
  }

  // 修复完成：必须指出“在哪个新版本验证有效”，且该新版本必须已发布才算核实
  verifyFix(ticketId, { docVersion, verifiedVersion }, actor, idemKey) {
    return this.#withIdempotency(idemKey, actor, 'fix_verified', () => {
      const t = this.stmts.getTicket.get(ticketId)
      if (!t) throw httpError(404, 'ticket_not_found')
      const aff = this.stmts.getAffectedOne.get(ticketId, docVersion)
      if (!aff) throw httpError(409, 'affected_version_not_found')
      if (!verifiedVersion) throw httpError(400, 'verified_version_required')
      const release = this.stmts.getRelease.get(verifiedVersion)
      if (!release || !release.is_published) {
        throw httpError(409, 'verified_version_not_released')
      }
      const ts = now()
      this.stmts.updateAffectedVerified.run(verifiedVersion, ts, ticketId, docVersion)
      this.#event(ticketId, 'fix_verified', actor, {
        docVersion, to: verifiedVersion,
        payload: { released_at: release.released_at }
      })
      return this.#ticketView(this.stmts.getTicket.get(ticketId))
    })
  }

  // 复开（旧版仍有问题）：重新打开指定受影响版本，并把工单整体状态拉回 open
  reopen(ticketId, { docVersion, reason }, actor, idemKey) {
    return this.#withIdempotency(idemKey, actor, 'reopened', () => {
      const t = this.stmts.getTicket.get(ticketId)
      if (!t) throw httpError(404, 'ticket_not_found')
      const info = this.stmts.reopenAffected.run(now(), ticketId, docVersion)
      if (info.changes === 0) throw httpError(409, 'version_not_resolved_or_unknown')
      this.#event(ticketId, 'reopened', actor, {
        docVersion, to: 'open', payload: { reason: reason || null }
      })
      return this.#ticketView(this.stmts.getTicket.get(ticketId))
    })
  }

  // 直接改工单状态：允许，但必须落事件 + 原因，证据链与历史不丢失
  manualStatusChange(ticketId, { status, reason }, actor, idemKey) {
    return this.#withIdempotency(idemKey, actor, 'manual_status_change', () => {
      const t = this.stmts.getTicket.get(ticketId)
      if (!t) throw httpError(404, 'ticket_not_found')
      if (!['open', 'fix_submitted', 'resolved', 'wont_fix', 'invalid'].includes(status)) {
        throw httpError(400, 'invalid_status')
      }
      if (!reason || !reason.trim()) throw httpError(400, 'reason_required')
      const current = deriveStatus(this.stmts.listEvents.all(ticketId))
      this.#event(ticketId, 'manual_status_change', actor, {
        from: current, to: status, payload: { reason }
      })
      return this.#ticketView(this.stmts.getTicket.get(ticketId))
    })
  }

  // 合并：来源工单保留、可追溯；重复合并幂等
  mergeTickets(sourceId, targetId, actor, idemKey, reason = null) {
    return this.#withIdempotency(idemKey, actor, 'merge', () => {
      if (sourceId === targetId) throw httpError(400, 'cannot_merge_self')
      const src = this.stmts.getTicket.get(sourceId)
      const tgt = this.stmts.getTicket.get(targetId)
      if (!src || !tgt) throw httpError(404, 'ticket_not_found')
      const already = this.stmts.wasMerged.get(sourceId, targetId)
      if (!already) {
        this.stmts.insertMerge.run(sourceId, targetId, actor, reason, now())
        this.#event(sourceId, 'merged_into', actor, { to: targetId, payload: { reason } })
        this.#event(targetId, 'merge_source', actor, { from: sourceId, payload: { reason } })
      }
      return { sourceId, targetId, merged: !already }
    })
  }

  // ===========================================================================
  // 页面迁移：旧反馈保留原定位；迁移关系需人工确认
  // ===========================================================================
  proposeMigration(m, actor = 'system') {
    const ts = now()
    const existing = this.stmts.findPendingMigration.get(
      m.sourceVersion, m.sourcePath, m.sourceAnchor ?? null,
      m.targetVersion, m.targetPath, m.targetAnchor ?? null
    )
    if (existing) return { id: existing.id, idempotent_replay: true }
    const info = this.stmts.insertMigration.run(
      m.sourceVersion, m.sourcePath, m.sourceAnchor ?? null,
      m.targetVersion, m.targetPath, m.targetAnchor ?? null, ts
    )
    return { id: info.lastInsertRowid, idempotent_replay: false }
  }

  confirmMigration(migrationId, actor, idemKey) {
    return this.#withIdempotency(idemKey, actor, 'confirm_migration', () => {
      const mig = this.stmts.getMigration.get(migrationId)
      if (!mig) throw httpError(404, 'migration_not_found')
      if (mig.status !== 'pending') throw httpError(409, `migration_${mig.status}`)
      const ts = now()
      const info = this.stmts.confirmMigration.run(actor, ts, migrationId)
      if (info.changes === 0) throw httpError(409, 'migration_not_pending')
      // 旧定位标记 moved（不改写工单快照）；定位到旧位置的工单追加“人工确认”事件
      this.stmts.markLocation.run('moved', mig.source_version, mig.source_path, mig.source_anchor ?? null)
      const affected = this.stmts.ticketsByPath.all(mig.source_path)
      for (const t of affected) {
        const sameVersion = t.page_version === mig.source_version &&
          (t.page_anchor ?? null) === (mig.source_anchor ?? null)
        if (!sameVersion) continue
        this.#event(t.id, 'page_migration_confirmed', actor, {
          from: `${mig.source_version}:${mig.source_path}${mig.source_anchor || ''}`,
          to: `${mig.target_version}:${mig.target_path}${mig.target_anchor || ''}`,
          payload: { migrationId }
        })
      }
      return this.stmts.getMigration.get(migrationId)
    })
  }

  rejectMigration(migrationId, actor, idemKey) {
    return this.#withIdempotency(idemKey, actor, 'reject_migration', () => {
      this.db.prepare("UPDATE page_migrations SET status='rejected' WHERE id=? AND status='pending'").run(migrationId)
      return this.stmts.getMigration.get(migrationId)
    })
  }

  // 文档删段：原锚点失效，保留快照，事件说明，不把工单错误关闭
  markSectionDeleted({ pageVersion, pagePath, pageAnchor }, actor, idemKey) {
    return this.#withIdempotency(idemKey, actor, 'section_deleted', () => {
      this.stmts.markLocation.run('section_deleted', pageVersion, pagePath, pageAnchor ?? null)
      const affected = this.stmts.ticketsByPath.all(pagePath)
      for (const t of affected) {
        if (t.page_version === pageVersion && (t.page_anchor ?? null) === (pageAnchor ?? null)) {
          this.#event(t.id, 'section_deleted', actor, {
            payload: { page_version: pageVersion, page_path: pagePath, page_anchor: pageAnchor ?? null }
          })
        }
      }
      return { ok: true }
    })
  }

  // ===========================================================================
  // 可恢复上传
  // ===========================================================================
  createUpload({ filename, contentType, totalSize, chunkSize, viewerTokenHash = null }) {
    const uploadId = newId('UPL')
    if (!Number.isInteger(totalSize) || totalSize <= 0) throw httpError(400, 'bad_total_size')
    if (!Number.isInteger(chunkSize) || chunkSize <= 0) throw httpError(400, 'bad_chunk_size')
    const totalChunks = Math.ceil(totalSize / chunkSize)
    this.stmts.insertUpload.run(uploadId, filename, contentType || null, totalSize, chunkSize,
      totalChunks, viewerTokenHash, now())
    return { uploadId, chunkSize, totalChunks, receivedChunks: [] }
  }

  getUploadStatus(uploadId) {
    const up = this.stmts.getUpload.get(uploadId)
    if (!up) throw httpError(404, 'upload_not_found')
    return { ...up, receivedChunks: this.stmts.listChunks.all(uploadId).map((r) => r.chunk_index) }
  }

  putChunk(uploadId, index, buf, hash) {
    const up = this.stmts.getUpload.get(uploadId)
    if (!up) throw httpError(404, 'upload_not_found')
    if (up.status !== 'open') throw httpError(409, `upload_${up.status}`)
    if (index < 0 || index >= up.total_chunks) throw httpError(400, 'chunk_index_out_of_range')
    // 幂等：重复网络回执/重传同一分片直接返回成功，不重复落库
    const existed = this.db.prepare('SELECT 1 FROM upload_chunks WHERE upload_id=? AND chunk_index=?').get(uploadId, index)
    this.stmts.insertChunk.run(uploadId, index, buf.length, hash, now())
    return { uploadId, index, size: buf.length, duplicate: !!existed }
  }

  completeUpload(uploadId, hash = null) {
    const up = this.stmts.getUpload.get(uploadId)
    if (!up) throw httpError(404, 'upload_not_found')
    const received = new Set(this.stmts.listChunks.all(uploadId).map((r) => r.chunk_index))
    const missing = []
    for (let i = 0; i < up.total_chunks; i++) if (!received.has(i)) missing.push(i)
    if (missing.length) {
      throw Object.assign(httpError(409, 'chunks_missing'), { details: { missing } })
    }
    if (up.status === 'completed') return { idempotent_replay: true, upload: up }
    this.db.prepare('UPDATE upload_sessions SET status=?, sha256=?, completed_at=? WHERE upload_id=?')
      .run('completed', hash, now(), uploadId)
    return { idempotent_replay: false, upload: this.stmts.getUpload.get(uploadId) }
  }

  // 上传完成且工单提交后：落附件记录（默认 maintainer_only，最小披露）
  attachToTicket(ticketId, uploadId, { visibility = 'maintainer_only', sha256 = null }) {
    const up = this.stmts.getUpload.get(uploadId)
    if (!up) throw httpError(404, 'upload_not_found')
    // 会话必须已完成；ticket_id 允许为空（先传附件后提交），绑定后不得再改挂
    if (up.status !== 'completed') throw httpError(409, 'upload_not_ready')
    if (up.ticket_id && up.ticket_id !== ticketId) throw httpError(409, 'upload_bound_elsewhere')
    const existing = this.db.prepare('SELECT * FROM attachments WHERE upload_id=?').get(uploadId)
    if (existing) return { idempotent_replay: true, attachment: existing }
    const attId = newId('ATT')
    const tx = this.db.transaction(() => {
      this.stmts.insertAttachment.run(attId, ticketId, uploadId, up.filename, up.content_type,
        up.total_size, sha256 || up.sha256, visibility, 'visitor', now())
      this.stmts.bindUploadTicket.run(ticketId, uploadId)
    })
    tx()
    return { idempotent_replay: false, attachment: this.stmts.getAttachment.get(attId) }
  }

  // ===========================================================================
  // 发布与公开修订摘要（只取已核实事实）
  // ===========================================================================
  upsertRelease(version, notes = null) {
    this.stmts.upsertRelease.run(version, now(), notes)
    return this.stmts.getRelease.get(version)
  }

  createSummary({ ticketId, docVersion, fixedVersion, summary }, actor, idemKey) {
    return this.#withIdempotency(idemKey, actor, 'create_summary', () => {
      const aff = this.stmts.getAffectedOne.get(ticketId, docVersion)
      if (!aff) throw httpError(409, 'affected_version_not_found')
      if (aff.status !== 'resolved' || !aff.verified_version) throw httpError(409, 'fix_not_verified')
      const release = this.stmts.getRelease.get(fixedVersion)
      if (!release || !release.is_published) throw httpError(409, 'fixed_version_not_released')
      if (aff.verified_version !== fixedVersion) throw httpError(409, 'fixed_version_mismatch_verified')
      const info = this.stmts.insertSummary.run(ticketId, docVersion, fixedVersion, summary, now(), actor, now())
      return this.stmts.getSummary.get(info.lastInsertRowid)
    })
  }

  publishSummary(summaryId, actor, idemKey) {
    return this.#withIdempotency(idemKey, actor, 'publish_summary', () => {
      const s = this.stmts.getSummary.get(summaryId)
      if (!s) throw httpError(404, 'summary_not_found')
      if (s.status === 'published') return { idempotent_replay_draft: true, summary: s }
      this.stmts.publishSummary.run(now(), summaryId)
      return this.stmts.getSummary.get(summaryId)
    })
  }

  // ===========================================================================
  // 查询视图：公开最小披露
  // ===========================================================================
  #receiptFor(t) {
    return { ticketId: t.id, viewerToken: null /* token 仅在创建响应出现一次 */ }
  }

  #ticketView(t) {
    if (!t) return null
    const events = this.stmts.listEvents.all(t.id)
    const affected = this.stmts.getAffected.all(t.id)
    const attachments = this.stmts.listAttachments.all(t.id)
    return {
      id: t.id,
      category: t.category,
      title: t.title,
      body: t.body,
      contactDisplay: t.contact_display,
      status: deriveStatus(events),
      page: {
        version: t.page_version,
        path: t.page_path,
        anchor: t.page_anchor,
        headingSnapshot: t.heading_snapshot
      },
      environment: {
        language: t.env_language,
        viewport: t.env_viewport,
        // 公开视图不回传完整 UA / URL / contact
        url: undefined
      },
      affectedVersions: affected.map((a) => ({
        docVersion: a.doc_version,
        status: a.status,
        fixVersion: a.fix_version,
        verifiedVersion: a.verified_version,
        // 只有 verified_version 已发布，才对公开侧标记 live=true
        live: a.verified_version
          ? !!(this.stmts.getRelease.get(a.verified_version)?.is_published)
          : false
      })),
      attachments: attachments.map((a) => ({
        id: a.id,
        filename: a.filename,
        contentType: a.content_type,
        size: a.size_bytes,
        visibility: a.visibility
        // 不返回 uploaded_by：对公开访客不披露提交者
      })),
      events: events.map((e) => ({
        type: e.event_type,
        actor: e.actor,
        from: e.from_value,
        to: e.to_value,
        docVersion: e.doc_version,
        payload: e.payload_json ? JSON.parse(e.payload_json) : null,
        at: e.created_at
      })),
      createdAt: t.created_at,
      updatedAt: t.updated_at
    }
  }

  // 公开/回执查询：不泄露 contact、viewer token、完整环境指纹
  getTicketPublic(id) {
    return this.#ticketView(this.stmts.getTicket.get(id))
  }

  // 凭回执令牌查询（提交者本人）：仍不回显 contact 以外的身份信息
  getTicketByReceipt(id, token) {
    const row = this.stmts.getTicketByToken.get(id, hashToken(token))
    if (!row) return null
    const view = this.#ticketView(row)
    view.contact = row.contact || null
    return view
  }

  // 维护者视图：包含全部内部字段
  getTicketMaintainer(id) {
    const t = this.stmts.getTicket.get(id)
    if (!t) return null
    const view = this.#ticketView(t)
    view.contact = t.contact || null
    view.environment = {
      userAgent: t.env_user_agent,
      language: t.env_language,
      viewport: t.env_viewport,
      url: t.env_url,
      extra: t.env_extra ? JSON.parse(t.env_extra) : null
    }
    view.attachments = view.attachments.map((a, i) => ({
      ...a, uploadedBy: this.stmts.listAttachments.all(id)[i].uploaded_by
    }))
    const sources = this.stmts.listMergeSources.all(id).map((m) => ({
      ticketId: m.source_ticket_id, mergedBy: m.merged_by, reason: m.reason, at: m.created_at
    }))
    const targets = this.stmts.listMergeTargets.all(id).map((m) => ({
      ticketId: m.target_ticket_id, mergedBy: m.merged_by, reason: m.reason, at: m.created_at
    }))
    view.merges = { sources, targets }
    return view
  }

  listMaintainerTickets() {
    return this.stmts.listTickets.all().map((t) => this.getTicketMaintainer(t.id))
  }

  listPendingMigrations() {
    return this.stmts.listPendingMigrations.all()
  }

  publicSummaries() {
    // 已核实事实 = status published，且修复版本仍处于已发布状态
    return this.stmts.listPublicSummaries.all()
      .filter((s) => this.stmts.getRelease.get(s.fixed_version)?.is_published)
      .map((s) => ({
        docVersion: s.doc_version,
        fixedVersion: s.fixed_version,
        summary: s.summary,
        verifiedAt: s.verified_at,
        publishedAt: s.published_at
      }))
  }

  // 页面查询：跟随“已确认”迁移关系解析到新位置；旧定位仍保留
  resolveLocation(pageVersion, pagePath, pageAnchor) {
    const mig = this.stmts.confirmedMigrationFor.get(pageVersion, pagePath, pageAnchor ?? null)
    const current = mig
      ? { version: mig.target_version, path: mig.target_path, anchor: mig.target_anchor }
      : null
    return {
      original: { version: pageVersion, path: pagePath, anchor: pageAnchor ?? null },
      current,
      migrated: !!mig
    }
  }

  ticketsForLocation(pagePath) {
    return this.stmts.ticketsByPath.all(pagePath).map((t) => this.#ticketView(t.id))
  }

  authenticateMaintainer(username, password) {
    const m = this.stmts.getMaintainer.get(username)
    if (!m || !verifyPassword(password, m.password_hash)) return null
    return { username: m.username, displayName: m.display_name, role: m.role }
  }

  ensureMaintainer(username, password, displayName, role = 'maintainer') {
    this.stmts.upsertMaintainer.run(username, hashPassword(password), displayName, role, now())
  }

  addComment(ticketId, actor, text, idemKey) {
    return this.#withIdempotency(idemKey, actor, 'comment', () => {
      if (!this.stmts.getTicket.get(ticketId)) throw httpError(404, 'ticket_not_found')
      this.#event(ticketId, 'comment', actor, { payload: { text } })
      return this.#ticketView(this.stmts.getTicket.get(ticketId))
    })
  }
}

export function httpError(status, code) {
  const err = new Error(code)
  err.status = status
  err.code = code
  return err
}
