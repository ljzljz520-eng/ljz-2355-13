-- ============================================================================
-- 文档站反馈工单系统 · SQL 模型
--
-- 设计原则：
--   1. 事件溯源：工单状态不直接被覆盖，所有生命周期动作只追加 immutable event，
--      状态由事件流推导。直接改状态（manual_status_change）与
--      依据修复证据生成状态（fix_submitted / fix_verified / reopened）
--      都以事件落库，历史与来源不丢失。
--   2. 同一问题跨多版本：工单与“受影响版本”是 1:N；修复证据逐版本登记，
--      修复完成必须指出在哪个新版本验证有效，不得简单合并为一条“已解决”。
--   3. 页面迁移不改写旧定位：工单永久保存提交时的 (page_version, path, anchor,
--      heading_snapshot)，迁移关系单独建表，需人工确认才生效。
--   4. 附件最小披露：上传走分片可恢复，附件的公开/维护者可见由独立 ACL 控制；
--      公开访客默认只看到附件数量与文件名（文件名可隐藏），不暴露提交者身份。
--   5. 幂等：所有可能重试的写操作携带 idempotency_key，重复网络回执返回同一结果。
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ----------------------------------------------------------------------------
-- 工单主表：保存提交时的页面版、锚点与环境声明（定位快照，永不被迁移改写）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tickets (
  id                  TEXT PRIMARY KEY,                 -- 工单编号，如 TKT-000001
  idempotency_key     TEXT NOT NULL UNIQUE,             -- 提交幂等键（客户端 UUID，离线也生成）
  category            TEXT NOT NULL CHECK (category IN ('example_failure','content_question','other')),
  title               TEXT NOT NULL,
  body                TEXT NOT NULL,
  -- 提交者标识：对公开访客最小化披露；公开 API 永不返回该字段
  contact             TEXT,                             -- 可选邮箱/昵称
  contact_display     TEXT NOT NULL DEFAULT 'private' CHECK (contact_display IN ('private','public')),
  viewer_token_hash   TEXT NOT NULL,                    -- 提交者回执令牌哈希，凭回执可私密查询
  -- 页面定位快照（提交那一刻的值，迁移后也保留原值）
  page_version        TEXT NOT NULL,                    -- 页面版（文档版本/构建版，如 2026.10.0）
  page_path           TEXT NOT NULL,                    -- 页面版路径，如 /components/button
  page_anchor         TEXT,                             -- 锚点，如 #basic-usage（可空）
  heading_snapshot    TEXT,                             -- 锚点对应标题文本快照（删段后仍可辨认定位）
  -- 环境声明（接口原样保存，不做信任推断）
  env_user_agent      TEXT,
  env_language        TEXT,
  env_viewport        TEXT,
  env_url             TEXT,
  env_extra           TEXT,                             -- JSON：其他环境键值
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tickets_page ON tickets(page_path, page_version);

-- ----------------------------------------------------------------------------
-- 工单 × 受影响版本（1:N）
-- 同一问题跨多个版本出现时不能合并成一条“已解决”：每个受影响版本各自跟踪修复/验证。
-- status 是“该版本维度”的状态，独立于工单整体事件流。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ticket_affected_versions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id         TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  doc_version       TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','fix_submitted','resolved')),
  fix_version       TEXT,                               -- 声称修复的新版本
  verified_version  TEXT,                               -- 验证有效所基于的新版本（必须实际发布）
  fix_evidence      TEXT,                               -- 修复证据说明/链接
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  UNIQUE(ticket_id, doc_version)
);

-- ----------------------------------------------------------------------------
-- 不可变工单事件流（追加写，不更新不删除）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ticket_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id       TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL CHECK (event_type IN (
                    'created',                -- 工单创建
                    'manual_status_change',   -- 维护者直接改状态（带原因，不抹掉证据链）
                    'fix_submitted',          -- 依据修复证据：登记修复版本
                    'fix_verified',           -- 依据修复证据：在某新版本验证有效
                    'reopened',               -- 复开（旧版仍有问题等）
                    'merged_into',            -- 被合并到目标工单（来源不丢失）
                    'merge_source',           -- 收到来源工单（来源不丢失）
                    'affected_added',         -- 追加受影响版本
                    'page_migration_confirmed', -- 人工确认：旧定位 -> 新定位
                    'section_deleted',        -- 文档删段，原锚点失效
                    'comment'
                  )),
  actor           TEXT NOT NULL,                      -- 'visitor' 或维护者名
  from_value      TEXT,                               -- 状态/定位的旧值
  to_value        TEXT,                               -- 状态/定位/版本的新值
  doc_version     TEXT,                               -- 事件针对的具体受影响版本
  payload_json    TEXT,                               -- 结构化附加数据（证据、原因等）
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_ticket ON ticket_events(ticket_id, id);

-- ----------------------------------------------------------------------------
-- 合并关系（两个维护者合并同一工单也要可追溯；合并幂等，来源不丢失）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ticket_merges (
  source_ticket_id  TEXT NOT NULL REFERENCES tickets(id),
  target_ticket_id  TEXT NOT NULL REFERENCES tickets(id),
  merged_by         TEXT NOT NULL,
  reason            TEXT,
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (source_ticket_id, target_ticket_id),
  CHECK (source_ticket_id <> target_ticket_id)
);

-- ----------------------------------------------------------------------------
-- 页面定位与迁移关系
--   旧反馈保留原定位（tickets 中的快照不变）；
--   迁移记录初始 status='pending'，需人工确认后才 'confirmed' 并追加工单事件。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS page_locations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  page_version      TEXT NOT NULL,
  page_path         TEXT NOT NULL,
  page_anchor       TEXT,
  heading_snapshot  TEXT,
  status            TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','moved','section_deleted')),
  UNIQUE(page_version, page_path, page_anchor)
);

CREATE TABLE IF NOT EXISTS page_migrations (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  source_version        TEXT NOT NULL,
  source_path           TEXT NOT NULL,
  source_anchor         TEXT,
  target_version        TEXT NOT NULL,
  target_path           TEXT NOT NULL,
  target_anchor         TEXT,
  status                TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','confirmed','rejected')),
  proposed_by           TEXT NOT NULL DEFAULT 'system',
  confirmed_by          TEXT,
  confirmed_at          INTEGER,
  created_at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_migrations_source
  ON page_migrations(source_version, source_path, source_anchor, status);

-- ----------------------------------------------------------------------------
-- 附件：权限独立控制。公开访客最小化披露（默认不公开，不暴露提交者）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attachments (
  id              TEXT PRIMARY KEY,
  ticket_id       TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  upload_id       TEXT NOT NULL UNIQUE,                 -- 关联可恢复上传会话
  filename        TEXT NOT NULL,
  content_type    TEXT,
  size_bytes      INTEGER NOT NULL,
  sha256          TEXT,
  visibility      TEXT NOT NULL DEFAULT 'maintainer_only'
                  CHECK (visibility IN ('maintainer_only','public')),
  uploaded_by     TEXT NOT NULL,                        -- 提交者（仅维护者侧可见）
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attach_ticket ON attachments(ticket_id);

-- ----------------------------------------------------------------------------
-- 可恢复（分片）上传：中断后凭 upload_id 续传，已传分片不重传
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS upload_sessions (
  upload_id       TEXT PRIMARY KEY,
  ticket_id       TEXT REFERENCES tickets(id) ON DELETE CASCADE, -- 完成时绑定
  filename        TEXT NOT NULL,
  content_type    TEXT,
  total_size      INTEGER NOT NULL,
  chunk_size      INTEGER NOT NULL,
  total_chunks    INTEGER NOT NULL,
  sha256          TEXT,
  status          TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','completed','aborted')),
  viewer_token_hash TEXT,                               -- 未提交工单时凭回执令牌续传
  created_at      INTEGER NOT NULL,
  completed_at    INTEGER
);
CREATE TABLE IF NOT EXISTS upload_chunks (
  upload_id       TEXT NOT NULL REFERENCES upload_sessions(upload_id) ON DELETE CASCADE,
  chunk_index     INTEGER NOT NULL,
  size_bytes      INTEGER NOT NULL,
  sha256          TEXT,
  received_at     INTEGER NOT NULL,
  PRIMARY KEY (upload_id, chunk_index)
);

-- ----------------------------------------------------------------------------
-- 维护者
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS maintainers (
  username        TEXT PRIMARY KEY,
  password_hash   TEXT NOT NULL,                        -- PBKDF2 哈希
  display_name    TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'maintainer'
                    CHECK (role IN ('maintainer','admin')),
  created_at      INTEGER NOT NULL
);

-- ----------------------------------------------------------------------------
-- 文档发布记录：只有出现在此表中的 verified_version 才算“已上线”
-- 未发布修复不得在公开修订摘要中显示为已上线
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS doc_releases (
  version         TEXT PRIMARY KEY,
  released_at     INTEGER NOT NULL,
  notes           TEXT,
  is_published    INTEGER NOT NULL DEFAULT 1
);

-- ----------------------------------------------------------------------------
-- 公开修订摘要：只允许写入“已核实事实”（已发布版本 + 已验证证据）
-- status='draft' 的条目绝不进公开接口
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS revision_summaries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id       TEXT REFERENCES tickets(id) ON DELETE SET NULL,
  doc_version     TEXT NOT NULL,                       -- 受影响版本
  fixed_version   TEXT NOT NULL REFERENCES doc_releases(version), -- 必须已发布
  summary         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','published')),
  verified_at     INTEGER,
  published_at    INTEGER,
  created_by      TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  UNIQUE(ticket_id, doc_version)
);

-- ----------------------------------------------------------------------------
-- 维护者操作幂等：重复网络回执返回同一结果（两个维护者合并同一工单不重复落事件）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS action_idempotency (
  idempotency_key TEXT PRIMARY KEY,
  actor           TEXT NOT NULL,
  action          TEXT NOT NULL,
  result_json     TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
