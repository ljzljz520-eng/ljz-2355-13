# 文档站反馈工单系统设计说明

> 面向“网页提交示例失败 / 内容疑问”的反馈闭环。本文说明数据模型、状态语义与隐私边界。

## 1. 提交时固化的三类信息

| 信息 | 字段 | 说明 |
| :-- | :-- | :-- |
| 页面版 | `tickets.docs_version` + `ticket_affected_versions` | 构建时注入 `__DOCS_VERSION__`；同一问题可关联多个受影响版本 |
| 锚点 | `tickets.anchor`（快照） | 提交时刻的 URL hash，永不随页面迁移/删段改变 |
| 环境声明 | `tickets.env_snapshot` | UA / 视口 / 语言 / 时区 / OS / browser；仅维护者接口可见，不存 IP |

工单还保存 `page_path` 原定位快照与掩码联系方式（`re***@example.com` 形式）。

## 2. 状态：证据推导，而非直接改写

- **唯一事实来源**是只追加的 `ticket_events` 事件流；`ticket_affected_versions` 是可随时由事件重放重建的派生表。
- 维护者“直接改状态”写入 `tickets.status_override`，仅用于审计，**不参与** `effective_status` 计算；公开视图连该事件都不展示。
- 合法闭环路径：
  `open → fix_proposed（提出修复，指明预计版本）→ fix_verified（必须给出“新版本号 + 验证证据”）→ resolved`
- 修复证据缺失时 `fix-verified` 直接 400，无法把问题标成已解决。

## 3. 多版本与复开

- 一个工单按版本各自独立状态：1.1.0 已解决而 1.0.0 仍复现时，整体状态为 `partially_resolved`，**绝不合并显示为一条“已解决”**。
- `reopen` 只复开指定版本，其余版本保持已解决；修复版本/证据字段随之清空。
- 工单整体状态：全部 resolved → `resolved`；全部 fix_proposed → `fix_in_review`；混合 → `partially_resolved`；否则 `open`。

## 4. 合并不丢来源

- `POST /api/maintainer/merge` 只新增 `ticket_merges` 关系并回填 `merged_into`，来源工单、事件、附件全部保留。
- 合并接口带唯一幂等键：两位维护者同时合并同一对工单，数据库唯一约束 + 幂等表保证只产生一条关系；反向合并会形成环，返回 400，不静默翻转。
- 查看主工单时，事件流聚合所有来源工单事件，并标注来源工单号。

## 5. 页面迁移与删段

- 迁移分两步：维护者**提案** → 另一位维护者**人工确认**。未确认的提案对公开访客不可见。
- 确认后，旧工单仍返回 `original_path/original_anchor` 原定位，另附 `confirmed_new_location`。
- 文档删段通过 `doc_anchors(status=deleted)` 标记：工单保留原定位，公开视图提示“原段落已删除”。

## 6. 离线提交与幂等

- 前端 `feedback/queue.js` 为每条请求生成 `clt_<uuid>` 幂等键并存入 localStorage 离箱；`online`/`visibilitychange` 时重放。
- 服务端 `idempotency(scope,key,fn)` 保证同键返回同一响应（重复网络回执不会重复建工单/重复合并）。
- 访客身份为本地随机查询码，服务端仅存其 sha256。

## 7. 附件权限与断点续传

- 512KB 分片上传，每片带 sha256；`/uploads/:id/status` 返回缺片，中断后可续传；complete 幂等并做整文件校验与内容去重。
- 下载统一在处理器入口鉴权：`internal` 仅维护者；`private` 仅维护者与上传者本人（凭查询码）；公开访客一律 403，且响应不区分“文件是否存在”。
- 绑定附件到工单时再次校验 owner，防止把他人上传挂到自己工单。

## 8. 公开修订摘要（changelog）

`GET /api/feedback/changelog` 只输出同时满足以下条件的条目：

1. 存在与该版本匹配的 `fix_verified` 事件（已核实事实）；
2. 修复版本在 `docs_releases` 中 `released=1`（已上线）。

未发布版本的修复即使已验证也只在工单详情里呈现，摘要页不显示，避免“未发布修复被当作已上线”。
