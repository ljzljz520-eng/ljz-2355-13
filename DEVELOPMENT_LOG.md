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

## 4. 反馈工单系统（2026-10-02 追加）

### 4.1 关键取舍
- **事件溯源而非可变状态**：`ticket_events` 只追加，受影响版本状态可整体重放，杜绝“直接改状态”污染事实。
- **逐版本状态行**：天然支持“一问题跨多版本”“旧版本仍有问题”，整体状态用聚合（含 `partially_resolved`）表达。
- **迁移两步确认**：提案与确认分离，未确认关系不进任何公开响应；提交定位用快照表冻结。
- **幂等贯穿三层**：客户端 UUID 键 → 服务端 `idempotency` 表 → 附件 complete/合并唯一约束。

### 4.2 排查记录
1. `sha256(String(buf))` 破坏二进制分片 → 改为按 Buffer 哈希（否则每片 422）。
2. `upload_chunks.upload_id` 单字段唯一约束与多分片冲突 → 改联合唯一 `(upload_id, chunk_index)`。
3. 下载处理器未 `await`，鉴权异常逃逸 try/catch 导致进程崩溃（fetch failed）→ 鉴权前置并 await。
4. 内部 `status()` 把已是哈希的值二次哈希导致误 403 → 显式区分 token/hashed 入参。
5. upsert 后误用 `lastInsertRowid` 取迁移单 → 改按唯一键查询。
