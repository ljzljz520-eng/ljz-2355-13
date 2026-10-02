import Database from 'better-sqlite3'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, '..', 'data')
export const UPLOAD_DIR = path.resolve(__dirname, '..', 'uploads')
fs.mkdirSync(DATA_DIR, { recursive: true })
fs.mkdirSync(UPLOAD_DIR, { recursive: true })

const DB_PATH = process.env.FEEDBACK_DB || path.join(DATA_DIR, 'feedback.db')
export const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'))

export function sha256(input) {
  // Buffer/Uint8Array 按二进制哈希；字符串按 utf8（token 等文本）
  const h = createHash('sha256')
  return (Buffer.isBuffer(input) || input instanceof Uint8Array
    ? h.update(input)
    : h.update(String(input), 'utf8')
  ).digest('hex')
}
export function randomToken(bytes = 24) {
  return randomBytes(bytes).toString('hex')
}
export function maskContact(contact) {
  if (!contact) return null
  const c = String(contact).trim()
  if (c.includes('@')) {
    const [u, d] = c.split('@')
    return `${u.slice(0, 2)}***@${d}`
  }
  return c.replace(/.(?=.{2})/g, '*')
}

/**
 * 状态推导：只依据“证据事件”。
 * status_override 永远不参与计算，仅在审计字段中回显。
 *
 * @param rows ticket_affected_versions rows of one ticket
 * @returns 'open' | 'fix_in_review' | 'partially_resolved' | 'resolved'
 */
export function deriveEffectiveStatus(rows) {
  if (!rows.length) return 'open'
  const states = rows.map((r) => r.state)
  if (states.every((s) => s === 'resolved')) return 'resolved'
  if (states.every((s) => s === 'fix_proposed')) return 'fix_in_review'
  if (states.some((s) => s === 'resolved')) return 'partially_resolved'
  return 'open'
}

/**
 * 从事件流重放重建单个工单的受影响版本状态。
 * 保证即使派生表写坏，状态仍可由事件溯源恢复。
 */
export function rebuildAffectedFromEvents(ticketId) {
  const events = db
    .prepare('SELECT type, payload_json FROM ticket_events WHERE ticket_id=? ORDER BY id')
    .all(ticketId)
  const versions = new Map() // version -> state record
  const ensure = (v) => {
    if (!versions.has(v)) versions.set(v, { version: v, state: 'open' })
    return versions.get(v)
  }
  for (const e of events) {
    const p = JSON.parse(e.payload_json || '{}')
    switch (e.type) {
      case 'created':
        ;(p.versions || []).forEach(ensure)
        break
      case 'affected_added':
        ;(p.versions || []).forEach(ensure)
        break
      case 'fix_proposed':
        for (const v of p.versions || []) {
          const r = ensure(v)
          r.state = 'fix_proposed'
          r.fix_version = p.fix_version ?? r.fix_version
        }
        break
      case 'fix_verified':
        for (const v of p.versions || []) {
          const r = ensure(v)
          r.state = 'resolved'
          r.fix_version = p.fix_version
          r.evidence = p.evidence
          r.verified_by = p.verified_by
          r.verified_at = p.at
        }
        break
      case 'reopened':
        // 只复开指定版本：其它已解决版本保持已解决 —— “不能简单合并为一条已解决”
        for (const v of p.versions || []) {
          const r = ensure(v)
          r.state = 'open'
          r.fix_version = null
          r.evidence = null
          r.verified_by = null
          r.verified_at = null
        }
        break
      default:
        break
    }
  }
  const del = db.prepare('DELETE FROM ticket_affected_versions WHERE ticket_id=?')
  const ins = db.prepare(
    `INSERT INTO ticket_affected_versions
       (ticket_id, version, state, fix_version, evidence, verified_by, verified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ticket_id, version) DO UPDATE SET
       state=excluded.state, fix_version=excluded.fix_version,
       evidence=excluded.evidence, verified_by=excluded.verified_by, verified_at=excluded.verified_at`
  )
  const tx = db.transaction((id, recs) => {
    del.run(id)
    for (const r of recs) {
      ins.run(id, r.version, r.state, r.fix_version ?? null, r.evidence ?? null, r.verified_by ?? null, r.verified_at ?? null)
    }
  })
  tx(ticketId, [...versions.values()])
  return db
    .prepare('SELECT * FROM ticket_affected_versions WHERE ticket_id=? ORDER BY version')
    .all(ticketId)
}

// ---- 种子数据 ----
const seed = db.transaction(() => {
  const count = db.prepare('SELECT COUNT(*) c FROM maintainers').get().c
  if (count === 0) {
    const ins = db.prepare('INSERT INTO maintainers (login, bearer_token) VALUES (?, ?)')
    ins.run('alice', process.env.MAINTAINER_TOKEN_ALICE || 'tok_alice_demo')
    ins.run('bob', process.env.MAINTAINER_TOKEN_BOB || 'tok_bob_demo')
  }
  for (const v of ['1.0.0', '1.1.0', '1.2.0']) {
    db.prepare('INSERT OR IGNORE INTO docs_releases (version, released) VALUES (?, ?)').run(
      v,
      v === '1.2.0' ? 0 : 1
    )
  }
  db.prepare("UPDATE docs_releases SET released=1, released_at=COALESCE(released_at, datetime('now')) WHERE version IN ('1.0.0','1.1.0')").run()
})
seed()

export function requirePage(pagePath) {
  let page = db.prepare('SELECT * FROM doc_pages WHERE page_path=?').get(pagePath)
  if (!page) {
    db.prepare(
      'INSERT INTO doc_pages (page_path, current_path) VALUES (?, ?)'
    ).run(pagePath, pagePath)
    page = db.prepare('SELECT * FROM doc_pages WHERE page_path=?').get(pagePath)
  }
  return page
}
