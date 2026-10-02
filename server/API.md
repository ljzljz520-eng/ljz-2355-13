# 反馈工单 HTTP API

默认端口 `8790`（`PORT` 可改）。维护者接口需 `Authorization: Bearer <token>`。
种子账号：`alice / tok_alice_demo`、`bob / tok_bob_demo`（可用环境变量覆盖）。

## 公开接口

| 方法 | 路径 | 说明 |
| :-- | :-- | :-- |
| POST | `/api/feedback/tickets` | 提交工单；建议带 `idempotency_key`。返回 `code` 与一次性 `reporter_token` |
| GET | `/api/feedback/tickets/:code?token=` | 查询；无 token=公开视图（裁剪字段），带本人 token=提交者视图 |
| GET | `/api/feedback/changelog?version=` | 公开修订摘要（仅已核实+已发布） |
| GET | `/api/feedback/lookup?path=&anchor=` | 解析旧定位（仅返回已人工确认的迁移） |
| POST | `/api/feedback/uploads/init` | 初始化分片上传 |
| PUT | `/api/feedback/uploads/:id/chunks/:i?sha256=&reporter_token=` | 上传分片（原始字节） |
| GET | `/api/feedback/uploads/:id/status?reporter_token=` | 缺片查询（断点恢复） |
| POST | `/api/feedback/uploads/:id/complete` | 合并分片（幂等，整文件 sha256 校验） |
| GET | `/api/feedback/attachments/:id/download?ticket=&token=` | 附件下载（公开访客 403） |

### 提交体示例

```json
{
  "kind": "example_failure",
  "title": "Button basic 示例点击报错",
  "body": "复现步骤……",
  "page_path": "/components/button",
  "anchor": "basic-usage",
  "docs_version": "1.2.0",
  "affected_versions": ["1.0.0", "1.1.0"],
  "contact": "reader@example.com",
  "attachments": ["<sha256 from complete>"],
  "env": { "user_agent": "...", "viewport": "1440x900", "language": "zh-CN", "timezone": "Asia/Shanghai" },
  "idempotency_key": "clt_..."
}
```

## 维护者接口

| 方法 | 路径 | 说明 |
| :-- | :-- | :-- |
| GET | `/api/maintainer/tickets` | 列表（含 effective 与 override 对照） |
| GET | `/api/maintainer/tickets/:code` | 详情（含环境快照/掩码联系方式） |
| POST | `/api/maintainer/tickets/:code/affected` | 追加受影响版本 |
| POST | `/api/maintainer/tickets/:code/fix-proposed` | 提出修复（`fix_version`，未验证） |
| POST | `/api/maintainer/tickets/:code/fix-verified` | **唯一合法闭环**：`fix_version` + `evidence` |
| POST | `/api/maintainer/tickets/:code/reopen` | 按版本复开（`versions[]` + reason） |
| POST | `/api/maintainer/tickets/:code/status` | 直接改状态（仅审计，不影响推导） |
| POST | `/api/maintainer/merge` | 合并重复工单（幂等，防环） |
| POST | `/api/maintainer/pages/migrate` | 页面迁移提案 |
| POST | `/api/maintainer/pages/migrate/:id/confirm` | 人工确认迁移 |
| POST | `/api/maintainer/pages/section-deleted` | 登记文档删段 |
| POST | `/api/maintainer/releases` | 登记/发布文档版本 |

## 运行

```bash
npm run feedback:dev          # 启动 API（首次自动建库+种子数据）
PORT=9000 npm run feedback:dev
FEEDBACK_DB=/path/to.db ...   # 自定义 SQLite 文件
MAX_UPLOAD_MB=20 ...          # 附件大小上限
```

VitePress 开发服务器已在 `docs/.vitepress/config.ts` 中把 `/api` 代理到本服务。
