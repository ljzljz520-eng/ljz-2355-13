import { db, requirePage, rebuildAffectedFromEvents, deriveEffectiveStatus } from './db.js'
import { HttpError, addEvent, actorOf, idempotent } from './util.js'
import { resolveLocation } from './publicApi.js'

const findTicket = (code) => {
  const t = db.prepare('SELECT * FROM tickets WHERE code=?').get(code)
  if (!t) throw new HttpError(404, 'ticket not found')
  return t
}

const VERSION_STATES = new Set(['open', 'fix_proposed', 'resolved'])

function assertVersionsExist(versions) {
  for (const v of versions) {
    if (!db.prepare('SELECT 1 FROM docs_releases WHERE version=?').get(v)) {
      throw new HttpError(400, `unknown docs release: ${v}（请先登记版本）`)
    }
  }
}

/** POST /api/maintainer/tickets/:code/affected  追加受影响版本（一问题多版本） */
export function addAffected(code, body, login) {
  const t = findTicket(code)
  const versions = [...new Set(body.versions || [])]
  if (!versions.length) throw new HttpError(400, 'versions[] required')
  assertVersionsExist(versions)
  const exist = new Set(
    db.prepare('SELECT version FROM ticket_affected_versions WHERE ticket_id=?').all(t.id).map((r) => r.version)
  )
  const fresh = versions.filter((v) => !exist.has(v))
  if (fresh.length) addEvent(t.id, 'affected_added', actorOf(login), { versions: fresh })
  const rows = rebuildAffectedFromEvents(t.id)
  return { code, affected_versions: rows, effective_status: deriveEffectiveStatus(rows) }
}

/** POST /api/maintainer/tickets/:code/fix-proposed  维护者提出修复（尚未验证，不算解决） */
export function fixProposed(code, body, login) {
  const t = findTicket(code)
  const versions = body.versions?.length ? body.versions : rowsOf(t).map((r) => r.version)
  if (!body.fix_version) throw new HttpError(400, 'fix_version required（指出预计修复的新版本）')
  if (!db.prepare('SELECT 1 FROM docs_releases WHERE version=?').get(body.fix_version)) {
    throw new HttpError(400, `fix_version 未登记: ${body.fix_version}`)
  }
  addEvent(t.id, 'fix_proposed', actorOf(login), {
    versions, fix_version: body.fix_version, note: body.note || null
  })
  const rows = rebuildAffectedFromEvents(t.id)
  return { code, effective_status: deriveEffectiveStatus(rows), affected_versions: rows }
}

/**
 * POST /api/maintainer/tickets/:code/fix-verified
 * 闭环的唯一合法路径：指出在“哪个新版本”验证有效 + 证据。
 */
export function fixVerified(code, body, login) {
  const t = findTicket(code)
  const versions = body.versions?.length ? body.versions : rowsOf(t).map((r) => r.version)
  if (!versions.length) throw new HttpError(400, 'versions[] required')
  const evidence = String(body.evidence || '').trim()
  if (evidence.length < 10) throw new HttpError(400, 'evidence required（提交记录/预览链接/验证步骤）')
  if (!body.fix_version) throw new HttpError(400, 'fix_version required（必须指出验证有效的新版本）')
  const release = db.prepare('SELECT * FROM docs_releases WHERE version=?').get(body.fix_version)
  if (!release) throw new HttpError(400, `fix_version 未登记: ${body.fix_version}`)

  const at = new Date().toISOString()
  addEvent(t.id, 'fix_verified', actorOf(login), {
    versions, fix_version: body.fix_version, evidence,
    released: !!release.released, verified_by: login, at
  })
  const rows = rebuildAffectedFromEvents(t.id)
  // 未发布版本不会公开显示为“已上线”，仅返回标记供界面提示
  return {
    code,
    effective_status: deriveEffectiveStatus(rows),
    affected_versions: rows,
    fix_version_released: !!release.released
  }
}

/** POST /api/maintainer/tickets/:code/reopen  按版本复开（旧版本仍有问题） */
export function reopen(code, body, login) {
  const t = findTicket(code)
  const rowsNow = rowsOf(t)
  let versions = body.versions?.length ? body.versions : rowsNow.map((r) => r.version)
  const resolvable = new Set(rowsNow.filter((r) => r.state !== 'open').map((r) => r.version))
  const canReopen = versions.filter((v) => resolvable.has(v))
  if (!canReopen.length) throw new HttpError(409, '所选版本均为 open，无需复开')
  addEvent(t.id, 'reopened', actorOf(login), {
    versions: canReopen, reason: body.reason || null, at: new Date().toISOString()
  })
  const rows = rebuildAffectedFromEvents(t.id)
  return {
    code,
    reopened_versions: canReopen,
    still_resolved_versions: rows.filter((r) => r.state === 'resolved').map((r) => r.version),
    effective_status: deriveEffectiveStatus(rows)
  }
}

/**
 * POST /api/maintainer/tickets/:code/status  直接改状态（与证据推导对照）
 * 只记录审计字段，effective_status 仍然只由证据推导。
 */
export function statusOverride(code, body, login) {
  const t = findTicket(code)
  if (!['open', 'resolved', 'wont_fix', 'duplicate'].includes(body.status)) {
    throw new HttpError(400, 'unsupported override status')
  }
  db.prepare('UPDATE tickets SET status_override=?, override_by=?, override_reason=? WHERE id=?').run(
    body.status, login, body.reason || null, t.id
  )
  addEvent(t.id, 'status_override', actorOf(login), {
    forced_status: body.status, reason: body.reason || null, at: new Date().toISOString()
  })
  const rows = rebuildAffectedFromEvents(t.id)
  return {
    code,
    status_override: body.status,
    effective_status: deriveEffectiveStatus(rows),
    note: '直接改状态仅作审计记录；有效状态仍由修复证据推导'
  }
}

/**
 * POST /api/maintainer/merge  {source, target, idempotency_key}
 * 两个维护者合并同一对工单：唯一约束 + 幂等键保证只有一条关系；
 * 来源工单与其全部事件/附件保留，不丢来源。
 */
export function mergeTickets(body, login) {
  const source = findTicket(body.source)
  const target = findTicket(body.target)
  if (source.id === target.id) throw new HttpError(400, 'cannot merge ticket into itself')
  // 防环：target 是否已在 source 的下游链上
  let cur = target
  for (let i = 0; i < 100 && cur; i++) {
    if (cur.id === source.id) throw new HttpError(400, 'merge would create a cycle')
    cur = cur.merged_into ? db.prepare('SELECT * FROM tickets WHERE id=?').get(cur.merged_into) : null
  }
  const key = body.idempotency_key || `merge:${source.code}:${target.code}`
  return idempotent('merge', key, () => {
    return db.transaction(() => {
      const exists = db
        .prepare('SELECT * FROM ticket_merges WHERE source_ticket_id=? AND target_ticket_id=?')
        .get(source.id, target.id)
      if (exists) return { merged: true, reused: true, source: source.code, target: target.code }
      // 反向已存在 -> 冲突，不静默翻转
      const reverse = db
        .prepare('SELECT * FROM ticket_merges WHERE source_ticket_id=? AND target_ticket_id=?')
        .get(target.id, source.id)
      if (reverse) throw new HttpError(409, 'tickets already merged in opposite direction')

      db.prepare(
        'INSERT INTO ticket_merges (source_ticket_id, target_ticket_id, merged_by, idempotency_key) VALUES (?,?,?,?)'
      ).run(source.id, target.id, login, key)
      db.prepare('UPDATE tickets SET merged_into=? WHERE id=?').run(target.id, source.id)
      addEvent(source.id, 'merged', actorOf(login), {
        target_ticket: target.code, at: new Date().toISOString()
      })
      addEvent(target.id, 'commented', actorOf(login), {
        note: `合并入重复工单 ${source.code}（来源完整保留）`,
        source_ticket: source.code, at: new Date().toISOString()
      })
      // 合并不改变任何一方的版本状态；只做版本并集到主工单，仍逐版本独立
      const srcVers = db.prepare('SELECT version FROM ticket_affected_versions WHERE ticket_id=?').all(source.id)
      const fresh = srcVers.map((r) => r.version).filter((v) =>
        !db.prepare('SELECT 1 FROM ticket_affected_versions WHERE ticket_id=? AND version=?').get(target.id, v))
      if (fresh.length) addEvent(target.id, 'affected_added', actorOf(login), { versions: fresh, from_merge: source.code })
      const rows = rebuildAffectedFromEvents(target.id)
      return { merged: true, source: source.code, target: target.code, effective_status: deriveEffectiveStatus(rows) }
    })()
  })
}

/** POST /api/maintainer/pages/migrate  迁移提案（需要后续人工确认才公开生效） */
export function proposeMigration(body, login) {
  if (!body.from_path?.startsWith('/') || !body.to_path?.startsWith('/')) {
    throw new HttpError(400, 'from_path/to_path required')
  }
  return db.transaction(() => {
    const page = requirePage(body.from_path)
    const r = db
      .prepare(
        `INSERT INTO page_migrations (page_id, from_path, from_anchor, to_path, to_anchor, reason, proposed_by)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(from_path, from_anchor, to_path, to_anchor) DO UPDATE SET
           reason=excluded.reason, proposed_by=excluded.proposed_by`
      )
      .run(page.id, body.from_path, body.from_anchor || null, body.to_path, body.to_anchor || null, body.reason || null, login)
    const row = db
.prepare(
        "SELECT * FROM page_migrations WHERE from_path=? AND COALESCE(from_anchor,'')=? AND to_path=? AND COALESCE(to_anchor,'')=?"
      )
      .get(body.from_path, body.from_anchor || '', body.to_path, body.to_anchor || '')
    const tickets = db.prepare("SELECT id, code FROM tickets WHERE page_path=?").all(body.from_path)
    for (const tk of tickets) {
      addEvent(tk.id, 'migration_proposed', actorOf(login), {
        to_path: body.to_path, to_anchor: body.to_anchor || null, at: new Date().toISOString()
      })
    }
    db.prepare("UPDATE doc_pages SET current_path=?, updated_at=datetime('now') WHERE id=?")
      .run(body.to_path, page.id)
    return { migration_id: row.id, confirmed: false, affected_tickets: tickets.map((t) => t.code) }
  })()
}

/** POST /api/maintainer/pages/migrate/:id/confirm  人工确认：确认后公开访客才看到新定位 */
export function confirmMigration(id, body, login) {
  const m = db.prepare('SELECT * FROM page_migrations WHERE id=?').get(id)
  if (!m) throw new HttpError(404, 'migration proposal not found')
  if (m.confirmed_at) return { migration_id: m.id, confirmed: true, reused: true }
  db.prepare("UPDATE page_migrations SET confirmed_by=?, confirmed_at=datetime('now') WHERE id=?")
    .run(login, id)
  db.prepare("UPDATE doc_pages SET anchor_status='moved', updated_at=datetime('now') WHERE id=?").run(m.page_id)
  const tickets = db.prepare('SELECT id, code FROM tickets WHERE page_path=?').all(m.from_path)
  for (const tk of tickets) {
    addEvent(tk.id, 'migration_confirmed', actorOf(login), {
      to_path: m.to_path, to_anchor: m.to_anchor, at: new Date().toISOString()
    })
  }
  return { migration_id: id, confirmed: true, by: login, confirmed_tickets: tickets.map((t) => t.code) }
}

/** POST /api/maintainer/pages/section-deleted  文档删段：旧反馈保留原定位，仅标记段已删 */
export function sectionDeleted(body, login) {
  if (!body.page_path?.startsWith('/') || !body.anchor) throw new HttpError(400, 'page_path + anchor required')
  return db.transaction(() => {
    const page = requirePage(body.page_path)
    db.prepare(
      `INSERT INTO doc_anchors (page_id, anchor, status, deleted_text, updated_at)
       VALUES (?,?, 'deleted', ?, datetime('now'))
       ON CONFLICT(page_id, anchor) DO UPDATE SET status='deleted', deleted_text=excluded.deleted_text, updated_at=datetime('now')`
    ).run(page.id, body.anchor, body.deleted_text || null)
    const tickets = db.prepare('SELECT id, code FROM tickets WHERE page_path=? AND anchor=?')
      .all(body.page_path, body.anchor)
    for (const tk of tickets) {
      addEvent(tk.id, 'section_deleted', actorOf(login), {
        anchor: body.anchor, reason: body.reason || null, at: new Date().toISOString()
      })
    }
    return { marked: true, anchor: body.anchor, retained_tickets: tickets.map((t) => t.code) }
  })()
}

/** POST /api/maintainer/releases  登记/发布版本（修复上线的依据） */
export function upsertRelease(body) {
  if (!body.version) throw new HttpError(400, 'version required')
  db.prepare(
    `INSERT INTO docs_releases (version, released, released_at) VALUES (?,?,?)
     ON CONFLICT(version) DO UPDATE SET
       released=excluded.released,
       released_at=COALESCE(docs_releases.released_at, excluded.released_at)`
  ).run(body.version, body.released ? 1 : 0, body.released ? new Date().toISOString() : null)
  return db.prepare('SELECT * FROM docs_releases WHERE version=?').get(body.version)
}

/**
 * GET /api/feedback/changelog?version=
 * 公开修订摘要：只取“已核实(fix_verified)”且“修复版本已发布(released=1)”的事实。
 * 未发布修复绝不显示为已上线。
 */
export function publicChangelog(query) {
  const args = []
  let where = 'r.released=1 AND av.state=\'resolved\' AND av.fix_version=r.version'
  if (query.version) {
    where += ' AND av.fix_version=?'
    args.push(query.version)
  }
  const rows = db
    .prepare(
      `SELECT av.*, t.code, t.kind, t.title, t.page_path, t.anchor, r.version AS release_version, r.released_at
       FROM ticket_affected_versions av
       JOIN tickets t ON t.id=av.ticket_id
       JOIN docs_releases r ON r.version=av.fix_version
       WHERE ${where} AND (t.merged_into IS NULL)
       ORDER BY r.released_at DESC, av.verified_at DESC`
    )
    .all(...args)

  const grouped = {}
  for (const row of rows) {
    // 二次校验：确实有 fix_verified 事件，且当时记录的版本一致（防止脏数据混入公开摘要）
    const verifiedEvents = db
      .prepare("SELECT payload_json FROM ticket_events WHERE ticket_id=? AND type='fix_verified'")
      .all(row.ticket_id)
    const confirmed = verifiedEvents.some((e) => {
      const p = JSON.parse(e.payload_json)
      return p.fix_version === row.fix_version && (p.versions || []).includes(row.version)
    })
    if (!confirmed) continue

    const loc = resolveLocation(row.page_path, row.anchor, 'public')
    const entry = {
      ticket: row.code,
      kind: row.kind,
      title: row.title,
      affected_version: row.version,
      fixed_in: row.fix_version,
      released_at: row.released_at,
      location: loc.confirmed_new_location
        ? { path: loc.confirmed_new_location.path, anchor: loc.confirmed_new_location.anchor, redirected: true }
        : { path: row.page_path, anchor: row.anchor, section_deleted: !!loc.section_deleted }
    }
    ;(grouped[row.fix_version] ||= []).push(entry)
  }
  return { source: 'verified_events + released_versions', versions: grouped }
}

/** GET /api/maintainer/tickets  维护者列表（含 override/effective 对照） */
export function listTickets(query) {
  const rows = db.prepare('SELECT * FROM tickets ORDER BY id DESC LIMIT 200').all()
  return rows.map((t) => {
    const av = db.prepare('SELECT * FROM ticket_affected_versions WHERE ticket_id=?').all(t.id)
    return {
      code: t.code, kind: t.kind, title: t.title,
      effective_status: deriveEffectiveStatus(av),
      status_override: t.status_override,
      merged_into: t.merged_into
        ? db.prepare('SELECT code FROM tickets WHERE id=?').get(t.merged_into)?.code
        : null,
      created_at: t.created_at
    }
  })
}

function rowsOf(t) {
  return db.prepare('SELECT * FROM ticket_affected_versions WHERE ticket_id=?').all(t.id)
}
