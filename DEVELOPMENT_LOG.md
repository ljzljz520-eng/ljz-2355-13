# 项目开发记录：基于 VitePress 的 Element Plus 风格文档系统

## 1. 核心思考与规划

### 1.1 需求本质分析
用户需求的核心在于构建一个不仅能看（文档），还能跑（组件示例），且长得像 Element Plus 的系统。关键技术挑战在于：
- **Markdown 与 Vue 的融合**：如何让 Markdown 中的代码块既能作为源码展示，又能作为实时组件运行。
- **自动化**：减少开发者的重复工作，实现“写一个 Vue 文件，出一份 Demo 文档”。

### 1.2 技术选型
- **基础引擎**：VitePress 1.x（目前最先进的 Vue 文档工具）。
- **Demo 方案**：采用 `markdown-it-container` 拦截 `::: demo` 块，配合 Vite 的 `import.meta.glob` 实现动态渲染。
- **样式方案**：Sass + CSS Variables，便于定制 Element 风格。

## 2. 执行过程记录

### 第一阶段：基础搭建
1. 初始化项目，安装 `vitepress`, `vue`, `sass`。
2. 配置多语言结构（zh/en），设置侧边栏和导航栏基础路由。

### 第二阶段：核心组件开发
1. 开发 `VpDemo.vue`：模仿 Element Plus 的代码卡片，包含预览区、描述区和折叠代码区。
2. 开发 `VpApi.vue`：用于展示组件参数，使用 Element 标志性的表格样式。

### 第三阶段：自动化插件实现
1. 编写 Markdown 插件逻辑：
   - 监听 `::: demo` 容器。
   - 从容器内容中提取 Vue 示例文件路径。
   - 读取文件源码，通过 `markdown-it` 再次渲染为代码块。
   - 渲染自定义组件 `<demo-xxx />`。
2. 实现自动注册：在 `theme/index.ts` 中利用 `glob` 自动扫码并注册所有示例。

### 第四阶段：问题排查与修复
1. **ESM 冲突**：修复了 `package.json` 中 `type` 字段冲突导致的启动失败。
2. **解析报错**：修复了 Markdown 与 Vue 模板混合时由于换行符导致的 Token 偏移错误。
3. **本地搜索**：在配置文件中一键开启内置本地搜索。

## 3. 设计亮点
- **零手动注册**：开发者只需在 `examples/` 文件夹下添加 `.vue` 文件，即可在任何 Markdown 中引用，极大提升了开发效率。
- **极致还原**：不仅是颜色，在代码折叠交互、API 表格间距等细节上均贴合 Element Plus 规范。

---

# 反馈工单系统开发记录（第二轮迭代）

## 1. 需求拆解中的关键判断

- **“接口保存页面版、锚点和环境声明”** → 提交瞬间快照化（`page_version/path/anchor/heading_snapshot` + env 列），
  页面后续迁移或删段都不能改写它。
- **“同一问题跨多个版本不能简单合并为一条已解决”** → 工单整体状态之外，引入 1:N 的
  `ticket_affected_versions`，修复证据与验证按版本独立记录；修复完成必须给出
  `verified_version`，且该版本必须已在 `doc_releases` 发布。
- **“直接改状态 vs 依据修复证据生成状态”** → 采用事件溯源：`ticket_events` 只追加，
  `manual_status_change`（强制 reason）与 `fix_submitted/fix_verified/reopened` 同为事件，
  状态由事件流 `deriveStatus()` 推导，历史永远可回放。
- **“合并后来源不丢失”** → 源工单不物理删除，追加 `merged_into` 事件并保留可查；
  目标工单记录 `merge_source`；合并关系唯一约束 + 维护者操作幂等表双保险。
- **“旧反馈保留原定位 + 人工确认关系”** → 迁移分 `pending/confirmed/rejected`，
  确认动作单独落事件，定位解析接口跟随 confirmed 关系跳新位置。
- **“公开修订摘要只取已核实事实”** → 摘要建草稿即强制“已发布 + 已验证 + 版本一致”，
  发布后还会在读取时复检版本仍处于已发布状态。
- **“离线幂等、最小披露、上传中断”** → 前端入队即生成 UUID 幂等键持久化；
  附件分片 256KB、服务端分片幂等，中断后查 `receivedChunks` 只补缺失分片；
  contact/UA 不进公开视图，附件默认 `maintainer_only`。

## 2. 工程过程

1. SQL 模型先行（`server/schema.sql`：9 张表 + 幂等表），再做事件溯源仓储 `store.js`。
2. 原生 Node HTTP 服务零 Web 框架依赖；维护者控制台为单文件 HTML + Basic Auth。
3. VitePress 侧通过 `layout-bottom` 插槽全局挂载反馈浮标；构建期 `__DOC_VERSION__`
   注入页面版，dev server 配置 `/feedback-api` 代理。
4. Node 内置 test runner 编写 17 个验收用例（临时库、临时上传目录、随机端口）。

## 3. 踩坑记录

- better-sqlite3 v13 的预编译二进制在本机 Node 20.20.2（N-API 仅到 9，aarch64）下段错误；
  降到 12.4.1 并用真实 `/usr/bin/gcc`（环境里 `/usr/local/bin/cc` 是拦截参数的包装脚本）
  从源码编译后稳定。
- better-sqlite3 v12 无 `db.savepoint()`，改为原生 `SAVEPOINT` SQL 实现幂等事务。
- 附件先传后提交时，会话已 `completed` 不能再用 `WHERE status='open'` 绑工单，
  改为独立 `bindUploadTicket` 与附件插入同事务。
