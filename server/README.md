# 文档反馈工单服务

文档站“💬 反馈”功能的后端：保存页面版/锚点/环境声明、SQL 事件溯源维护工单与附件权限、
分片可恢复上传、幂等提交、维护者控制台与公开修订摘要。

## 启动

```bash
# 默认端口 8788，SQLite 数据落在 server/data/feedback.db
npm run server

# 可选环境变量
PORT=8788
FEEDBACK_DB=/var/lib/feedback/feedback.db      # SQL 数据库
FEEDBACK_UPLOADS=/var/lib/feedback/uploads     # 分片与合并后的附件
FEEDBACK_ADMIN_USER=admin
FEEDBACK_ADMIN_PASS='请修改为强密码'
```

打开 `http://localhost:8788/console` 进入维护者控制台。
种子维护者（**生产务必改密码或删除**）：

| 用户 | 密码 |
| --- | --- |
| admin | admin-123456 |
| mona | mona-pass-123 |
| rafa | rafa-pass-123 |

## 与文档站对接

- 本地开发：VitePress 已配置代理 `/feedback-api → http://localhost:8788/api`（见 `docs/.vitepress/config.ts`）。
- 生产部署（静态站 + 本服务同域），Nginx 示例：

```nginx
location /feedback-api/ {
    proxy_pass http://127.0.0.1:8788/api/;
    proxy_request_buffering off;          # 分片直传，避免大文件缓冲
    proxy_read_timeout 300s;
    client_max_body_size 50m;
}
```

前端 API 基址可在构建时通过 `VITE_FEEDBACK_API` 覆盖（默认 `/feedback-api`）。
页面版通过构建环境变量 `DOC_VERSION=2026.10.1 npm run docs:build` 注入。

## 数据模型要点（见 schema.sql）

- `tickets`：页面版、路径、锚点、标题快照、环境声明、提交者联系方式（公开接口不返回）。
- `ticket_affected_versions`：工单 1:N 受影响版本，各自 `open/fix_submitted/resolved`，
  修复证据与“在哪个新版本验证有效”逐版本记录。
- `ticket_events`：**只追加**的事件流。直接改状态（`manual_status_change`，必须带原因）
  与证据驱动（`fix_submitted/fix_verified/reopened`）都落事件，复开与合并后来源不丢失。
- `ticket_merges` + `merged_into/merge_source` 事件：合并可追溯，重复合并幂等。
- `page_locations/page_migrations`：旧反馈永久保留原定位；迁移先 `pending`，
  维护者人工确认后才 `confirmed` 并给相关工单追加事件；删段落 `section_deleted` 而非关单。
- `upload_sessions/upload_chunks/attachments`：分片上传可中断续传；附件 ACL
  默认 `maintainer_only`，公开访客只看得到附件数量/文件名（无上传者）。
- `doc_releases/revision_summaries`：只有已发布版本才能作为验证版；公开摘要只发布
  “已发布 + 已验证”的条目，未发布修复不显示为已上线。
- `action_idempotency`：维护者写操作的幂等回执。

## 维护者 API（Basic Auth，写操作建议带 `Idempotency-Key` 头或 body 字段）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/maintainer/tickets` | 工单列表（含内部字段） |
| POST | `/api/maintainer/tickets/:id/affected` | 追加受影响版本 |
| POST | `/api/maintainer/tickets/:id/fix` | 登记修复证据（fixVersion） |
| POST | `/api/maintainer/tickets/:id/verify` | 在已发布新版本验证有效 |
| POST | `/api/maintainer/tickets/:id/reopen` | 复开（旧版仍有问题等） |
| POST | `/api/maintainer/tickets/:id/status` | 直接改状态（reason 必填） |
| POST | `/api/maintainer/merge` | 合并工单（来源保留） |
| GET/POST | `/api/maintainer/migrations` | 迁移提案 |
| POST | `/api/maintainer/migrations/:id/confirm` | 人工确认迁移 |
| POST | `/api/maintainer/sections/deleted` | 文档删段 |
| POST | `/api/maintainer/releases` | 登记版本发布 |
| POST | `/api/maintainer/revision-summaries` | 建修订摘要草稿（须已核实） |
| POST | `/api/maintainer/revision-summaries/:id/publish` | 发布摘要 |
| GET | `/api/maintainer/attachments/:id/download` | 维护者下载附件 |

## 公开 API（无需登录，最小披露）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/tickets` | 提交工单（幂等键必填） |
| GET | `/api/tickets/:id` | 公开查询（无身份/UA） |
| GET | `/api/tickets/:id?token=` | 凭回执令牌查询 |
| POST | `/api/uploads` · `PUT /api/uploads/:id/chunks/:i` · `POST .../complete` | 可恢复上传 |
| GET | `/api/public/revision-summary` | 只含已核实事实的公开摘要 |
| GET | `/api/public/locations/resolve` | 旧定位 → 已确认新位置 |
| GET | `/api/public/attachments/:id/download` | 仅 `public` 附件可取 |

## 测试

```bash
npm run test:feedback
```

覆盖：重复网络回执、两个维护者合并同工单、旧版仍有问题复开、页面迁移与删段、
附件上传中断续传与权限、直接改状态 vs 证据驱动、公开修订摘要只取已核实事实。
