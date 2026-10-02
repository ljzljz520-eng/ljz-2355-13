-- ============================================================================
-- 文档站反馈工单系统 数据库结构
-- 设计要点：
--   1. 工单状态是 *派生值*：ticket_events 是事实来源(single source of truth)，
--      status_override 只做审计记录，绝不参与 effective status 计算。
--   2. 同一问题影响多版本：ticket_affected_versions 每版本独立状态行，
--      一条版本已修复不代表其它版本解决；复开也按版本进行。
--   3. 页面迁移：提交时 page_path/anchor 快照永久保留；迁移需要人工确认。
--   4. 附件按 visibility 授权；公开访客拿不到任何附件字节。
-- ============================================================================

-- 文档版本（维护者发布；修复必须落在某个新版本上）
CREATE TABLE IF NOT EXISTS docs_releases (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  version      TEXT NOT NULL UNIQUE,
  released     INTEGER NOT NULL DEFAULT 0,   -- 0=未发布, 1=已上线
  released_at  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 文档页面（规范化，便于迁移与删段管理）
CREATE TABLE IF NOT EXISTS doc_pages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  page_path       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  current_path    TEXT NOT NULL COLLATE NOCASE,  -- 当前位置；迁移后改变，提交快照不变
  anchor_status   TEXT NOT NULL DEFAULT 'active', -- active|moved|deleted|stale
  deleted_section TEXT,                            -- 被删除的锚点原文（删段时由维护者登记）
  note            TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 页面迁移关系：必须 confirmed_at 非空（人工确认）后才作为公开重定向生效
CREATE TABLE IF NOT EXISTS page_migrations (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id             INTEGER NOT NULL REFERENCES doc_pages(id),
  from_path           TEXT NOT NULL COLLATE NOCASE,
  from_anchor         TEXT,
  to_path             TEXT NOT NULL COLLATE NOCASE,
  to_anchor           TEXT,
  reason              TEXT,
  proposed_by         TEXT,
  proposed_at         TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_by        TEXT,
  confirmed_at        TEXT,           -- 人工确认时间；NULL = 未确认，不公开生效
  UNIQUE(from_path, from_anchor, to_path, to_anchor)
);

CREATE TABLE IF NOT EXISTS tickets (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  code              TEXT NOT NULL UNIQUE,       -- 对外工单号 FB-000001
  kind              TEXT NOT NULL,              -- example_failure | content_question
  title             TEXT NOT NULL,
  body              TEXT NOT NULL,
  -- 提交时的不可变定位快照（页面迁移/删段都不改这里）
  page_path         TEXT NOT NULL,
  anchor            TEXT,
  docs_version      TEXT,
  env_snapshot      TEXT NOT NULL DEFAULT '{}', -- JSON: UA/视口/语言/时区/OS 等
  lang              TEXT,
  -- 公开/半公开身份：只存哈希与掩码，不存原始 IP
  reporter_hash     TEXT NOT NULL,              -- reporter_token 的 sha256（查询凭证）
  reporter_label    TEXT NOT NULL,              -- 公开掩码，如 anon-9f3a2c
  contact_masked    TEXT,                       -- 掩码联系方式，仅维护者接口可见
  status_override   TEXT,                       -- 维护者“直接改状态”的记录（审计用，不参与推导）
  override_by       TEXT,
  override_reason   TEXT,
  merged_into       INTEGER REFERENCES tickets(id), -- 被合并到的主工单（不删数据）
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tickets_page     ON tickets(page_path);
CREATE INDEX IF NOT EXISTS idx_tickets_reporter ON tickets(reporter_hash);
CREATE INDEX IF NOT EXISTS idx_tickets_merged   ON tickets(merged_into);

-- 受影响版本：同一工单关联多个版本，每版本独立状态
-- state: open | fix_proposed | resolved
CREATE TABLE IF NOT EXISTS ticket_affected_versions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id          INTEGER NOT NULL REFERENCES tickets(id),
  version            TEXT NOT NULL,
  state              TEXT NOT NULL DEFAULT 'open',
  -- 修复闭环：在“哪个新版本”验证有效 + 证据
  fix_version        TEXT,
  evidence           TEXT,
  verified_by        TEXT,
  verified_at        TEXT,
  UNIQUE(ticket_id, version)
);
CREATE INDEX IF NOT EXISTS idx_av_ticket ON ticket_affected_versions(ticket_id);
CREATE INDEX IF NOT EXISTS idx_av_version ON ticket_affected_versions(version, state);

-- 工单事件流（唯一事实来源，仅追加，永不更新/删除）
-- type: created | affected_added | commented | fix_proposed | fix_verified |
--       reopened | merged | status_override | migration_proposed | migration_confirmed | section_deleted
CREATE TABLE IF NOT EXISTS ticket_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id     INTEGER NOT NULL REFERENCES tickets(id),
  type          TEXT NOT NULL,
  actor         TEXT NOT NULL DEFAULT 'reporter', -- reporter|maintainer:<login>|system
  payload_json  TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_ticket ON ticket_events(ticket_id, id);

-- 合并关系：合并只追加关系；来源工单完整保留（含事件与附件）
CREATE TABLE IF NOT EXISTS ticket_merges (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  source_ticket_id     INTEGER NOT NULL REFERENCES tickets(id),
  target_ticket_id     INTEGER NOT NULL REFERENCES tickets(id),
  merged_by            TEXT,
  idempotency_key      TEXT UNIQUE,               -- 两个维护者同时合并同对工单 -> 幂等
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_ticket_id, target_ticket_id)
);

-- 附件：visibility 授权。private 仅提交者查询码 + 维护者可见；internal 仅维护者
CREATE TABLE IF NOT EXISTS attachments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id       INTEGER REFERENCES tickets(id), -- 分片上传完成时可能尚未关联工单
  filename        TEXT NOT NULL,
  mime            TEXT,
  size            INTEGER NOT NULL,
  sha256          TEXT NOT NULL UNIQUE,
  storage_path    TEXT NOT NULL,
  visibility      TEXT NOT NULL DEFAULT 'private', -- private | internal
  owner_hash      TEXT NOT NULL,                   -- 上传者 reporter_hash（绑定鉴权）
  complete        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 断点续传分片登记（上传中断后可凭 upload_id 续传/核验）
CREATE TABLE IF NOT EXISTS upload_chunks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  upload_id    TEXT NOT NULL,
  filename     TEXT NOT NULL,
  mime         TEXT,
  total_chunks INTEGER NOT NULL,
  chunk_size   INTEGER NOT NULL,
  total_size   INTEGER,
  owner_hash   TEXT NOT NULL,
  chunk_index  INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  UNIQUE(upload_id, chunk_index)
);

-- 幂等键（离线提交 / 重复网络回执）
CREATE TABLE IF NOT EXISTS idempotency (
  idempotency_key TEXT PRIMARY KEY,
  scope           TEXT NOT NULL,         -- create_ticket | upload_complete | merge ...
  response_json   TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 维护者（简单 Bearer Token；演示用，生产应对接 SSO）
CREATE TABLE IF NOT EXISTS maintainers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  login         TEXT NOT NULL UNIQUE,
  bearer_token  TEXT NOT NULL UNIQUE,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 锚点级状态：删段/失效按 (页面, 锚点) 记录；工单快照不变，仅影响对外定位解析
CREATE TABLE IF NOT EXISTS doc_anchors (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id       INTEGER NOT NULL REFERENCES doc_pages(id),
  anchor        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active', -- active | stale | deleted
  deleted_text  TEXT,                            -- 被删除段落原文（维护者登记）
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(page_id, anchor)
);
