# 任务：将 dsh-acp-agent 的 UI 功能拆分为独立前端插件

## 背景

`@threadharbor/dsh-acp-agent` 是 ACP（Agent Communication Protocol）代理的宿主侧插件包，负责在 DSH 中驱动外部 agent。它目前包含了一些与 UI 相关的功能，这些功能应该拆分为独立的前端插件，使得：

1. 每个功能的前后端属于同一个插件，而不是前端插件依赖后端一堆插件
2. 前端插件可以独立安装、独立禁用
3. 后端插件只负责 agent 协议和模型调用，不混入 UI 逻辑

## 需要拆分的 UI 功能

以下功能当前在 `dsh-acp-agent`（或其关联的 `dsh-preset-dispatch`）中，需要拆分到独立的前端插件：

### 1. 配额胶囊（quota-pill）

**当前位置：**
- 宿主侧路由：`dsh-preset-dispatch` 中的 `zcode-quota.ts`、`minimaxi-quota.ts`、`usage-codex.ts`、`usage-claude.ts`
- 前端注册：`dsh-client/src/quota-pill.ts`

**拆分目标：**
- 创建新插件包 `@threadharbor/quota-pill-client`（前端）
- 宿主侧路由保留在 `dsh-acp-agent` 或 `dsh-preset-dispatch` 中（后端）
- 前端插件通过 `conversation.composer.dock` 插槽注册配额胶囊

**前端插件需要：**
- `package.json` 中声明 `dsh.client.inject`: `["slots", "modelDirectories", "sessions"]`
- `dsh.client.platform`: `"web"`
- 依赖：`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`react`
- 注册到 `conversation.composer.dock` 插槽（list 类型，session 作用域）
- 使用 `ctx.inject` 等待 `modelDirectories` 和 `sessions` 服务就绪

### 2. Mermaid 图表渲染（mermaid）

**当前位置：**
- 宿主侧静态资源路由：`dsh-acp-agent/src/mermaid-asset.ts`（在 `/threadharbor/mermaid.js` 提供 mermaid.min.js）
- 前端渲染：`dsh-client/src/mermaid.ts`

**拆分目标：**
- 创建新插件包 `@threadharbor/mermaid-client`（前端）
- 宿主侧静态资源路由保留在 `dsh-acp-agent` 中（后端，因为它依赖 `node:fs`、`node:crypto`、`node:http`）
- 前端插件负责识别 markdown 中的 mermaid 代码块、注入 script 标签、渲染图表

**前端插件需要：**
- `package.json` 中声明 `dsh.client.inject`: `["slots"]`
- `dsh.client.platform`: `"web"`
- 依赖：`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`react`
- 不需要注册插槽——通过 DOM 层拦截 markdown 渲染输出
- 从同源 `/threadharbor/mermaid.js` 懒加载 mermaid 运行时

### 3. ACP 可见性过滤（acp-visibility）

**当前位置：**
- 前端：`dsh-client/src/acp-visibility.ts`、`acp-visibility-panel.tsx`、`acp-visibility-filter.ts`、`acp-visibility-catalog.ts`

**拆分目标：**
- 创建新插件包 `@threadharbor/acp-visibility-client`（前端）
- 纯前端功能，无需后端配套
- 注册到 `settings.section` 插槽（设置面板）
- 通过 filter 覆盖 `modelDirectories.directoryFor` 来隐藏 provider/model

**前端插件需要：**
- `package.json` 中声明 `dsh.client.inject`: `["slots", "remote", "remote.session"]`
- `dsh.client.platform`: `"web"`
- 依赖：`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`react`、`immer` 或 `zustand`
- 注册到 `settings.section` 插槽

### 4. 切换进度条（switch-progress）

**当前位置：**
- 前端：`dsh-client/src/switch-progress.ts`

**拆分目标：**
- 创建新插件包 `@threadharbor/switch-progress-client`（前端）
- 纯前端功能，无需后端配套
- 注册到 `shell.overlay` 插槽（全局浮层）

**前端插件需要：**
- `package.json` 中声明 `dsh.client.inject`: `["slots", "sessions"]`
- `dsh.client.platform`: `"web"`
- 依赖：`@deepseek-ai/dsh-client-ui-slots`、`react`
- 注册到 `shell.overlay` 插槽

### 5. 切换移交卡片（handover-card）

**当前位置：**
- 前端：`dsh-client/src/handover-card.ts`
- 后端配合：`dsh-acp-agent` 中的 `handover.ts`（产出 `agent-switch/handover` 回合结束原因）

**拆分目标：**
- 创建新插件包 `@threadharbor/handover-client`（前端）
- 后端（`dsh-acp-agent`）保留产出 `TurnEndReasonMap` 中 `agent-switch/handover` 的逻辑
- 前端插件注册 `ConversationNodeDefinition` 和 `conversation.chat.node` 键控渲染器

**前端插件需要：**
- `package.json` 中声明 `dsh.client.inject`: `["slots", "uiConversation", "uiWorkspace"]`
- `dsh.client.platform`: `"web"`
- 依赖：`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-conversation`、`@deepseek-ai/dsh-client-ui-chat`、`react`
- 注册 `agent-switch/handover` 节点定义

### 6. 失败回合恢复（lost-input）

**当前位置：**
- 前端：`dsh-client/src/lost-input.ts`

**拆分目标：**
- 创建新插件包 `@threadharbor/lost-input-client`（前端）
- 纯前端功能，无需后端配套

**前端插件需要：**
- `package.json` 中声明 `dsh.client.inject`: `["slots", "uiConversation", "sessions"]`
- `dsh.client.platform`: `"web"`
- 依赖：`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-conversation`、`@deepseek-ai/dsh-client-ui-chat`、`react`

### 7. 被打断轮次找回（interrupted-turn-recovery）

**当前位置：**
- 前端：`dsh-client/src/interrupted-turn-recovery.ts`

**拆分目标：**
- 创建新插件包 `@threadharbor/interrupted-recovery-client`（前端）
- 纯前端功能，无需后端配套

**前端插件需要：**
- `package.json` 中声明 `dsh.client.inject`: `["slots"]`
- `dsh.client.platform`: `"web"`
- 依赖：`@deepseek-ai/dsh-client-ui-slots`、`react`
- 注册到 `conversation.chat.turnTail` 插槽

### 8. Markdown 文件展开（markdown-turn）

**当前位置：**
- 前端：`dsh-client/src/markdown-turn.tsx`、`markdown-turn-sources.ts`、`markdown-turn-open.tsx`、`markdown-turn-active-bar.tsx`、`markdown-turn-active.ts`

**拆分目标：**
- 创建新插件包 `@threadharbor/markdown-turn-client`（前端）
- 纯前端功能，无需后端配套

**前端插件需要：**
- `package.json` 中声明 `dsh.client.inject`: `["slots", "remote"]`
- `dsh.client.platform`: `"web"`
- 依赖：`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`react`、`shiki`（代码高亮）
- 注册到 `conversation.chat.turnTail` 插槽

### 9. ACP 过程视图增强（acp-process-surface）

**当前位置：**
- 前端：`dsh-client/src/acp-process-surface.tsx`、`acp-process-segments.ts`、`acp-process-view.ts`、`answer-card.tsx`、`link-open.ts`

**拆分目标：**
- 创建新插件包 `@threadharbor/acp-process-client`（前端）
- 纯前端功能，无需后端配套

**前端插件需要：**
- `package.json` 中声明 `dsh.client.inject`: `["slots", "uiConversation"]`
- `dsh.client.platform`: `"web"`
- 依赖：`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-conversation`、`@deepseek-ai/dsh-client-ui-chat`、`@deepseek-ai/dsh-client-ui-primitives`、`react`

### 10. 模型标签增强（model-label）

**当前位置：**
- 前端：`dsh-client/src/model-label.tsx`

**拆分目标：**
- 创建新插件包 `@threadharbor/model-label-client`（前端）
- 纯前端功能，无需后端配套

**前端插件需要：**
- `package.json` 中声明 `dsh.client.inject`: `["slots"]`
- `dsh.client.platform`: `"web"`
- 依赖：`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`react`
- 注册到 `conversation.input.model.label` 子插槽

### 11. 会话编号栏（session-id-bar）

**当前位置：**
- 前端：`dsh-client/src/session-id-bar.ts`

**拆分目标：**
- 创建新插件包 `@threadharbor/session-id-bar-client`（前端）
- 纯前端功能，无需后端配套

**前端插件需要：**
- `package.json` 中声明 `dsh.client.inject`: `["slots"]`
- `dsh.client.platform`: `"web"`
- 依赖：`@deepseek-ai/dsh-client-ui-slots`、`react`
- 注册到 `conversation.session.header.utilities` 插槽

### 12. 会话区文件阅读与编辑（markdown-turn-client）

**当前位置：**
- 文件展开/预览：`dsh-client/src/markdown-turn.tsx`
- 文件数据来源：`dsh-client/src/markdown-turn-sources.ts`
- 共享文件操作栏：`dsh-client/src/markdown-turn-active-bar.tsx`
- 当前作用文件状态：`dsh-client/src/markdown-turn-active.ts`
- 打开方式选择：`dsh-client/src/markdown-turn-open.tsx`
- 内联样式：`dsh-client/src/markdown-turn.module.css`
- 答案卡编辑（answer-card）：`dsh-client/src/answer-card.tsx`

**拆分目标：**
- 创建独立仓库 `github.com/threadharbor/dsh-conversation-files`
- 包含完整的文件阅读、编辑、打开方式选择功能

**功能范围：**
- 从轮次产出/交付/改动中提取文件路径，在 `conversation.chat.turnTail` 注册展开面板
- 点击文件后展开：Markdown 文件渲染排版，其他文本按原文显示
- 文件编辑：点击「编辑」按钮，文件内容变为 textarea，可修改后「发送」（发到当前会话）或「新会话」（发到新会话）
- 打开方式：默认应用、指定应用、在文件管理器中显示
- 共享文件操作栏（ActiveFileBar）：显示当前作用文件，所有操作停在会话区
- 行号定位：路径中的 `:行号` 和 `#L行号` 用于定位
- 选中行发送：选中一段文本后点发送按钮，连同行号一起发到会话

**宿主依赖（通过 `remote` 命名空间）：**
- `remote.workspaceFiles.read` — 读取文件内容（分页）
- `remote.workspaceFiles.stat` — 获取文件绝对路径
- `remote.session.openWorkspacePath` — 用桌面应用打开文件
- `remote.session.canOpenWorkspacePath` — 查询桌面是否支持打开文件
- `fetch` 同源 `/api/changes.summary` — 获取改动清单摘要

**前端插件需要：**
- `package.json` 中声明 `dsh.client.inject`: `["slots", "remote"]`
- `dsh.client.platform`: `"web"`
- 依赖：`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`react`
- 可选依赖：`shiki`（代码高亮）、`diff`（改动对比）
- 注册到 `conversation.chat.turnTail` 插槽（list 类型，session 作用域）

**独立仓库要求：**
- 作为独立的 npm 包发布，可被 DSH 以外的项目复用
- 有自己的 `README.md`、许可证、CI 配置
- 不依赖 `@threadharbor/` 下的任何内部包（所有类型从 DSH 的公开 API 导入）
- 宿主接口通过 `remote` 命名空间的结构类型定义，不直接 import DSH 内部包

---

## 补充：会话区文件操作与官方右侧预览的关系

DSH 官方已经提供了右侧文件预览面板（`rightbar` 插槽），由 `@deepseek-ai/dsh-client-ui-workspace` 包提供。它的能力是：
- 点击会话中的文件链接，在右侧打开预览
- 支持图片、PDF、Office 文档的官方预览
- 标题栏有「显示文件位置」按钮

`markdown-turn-client` 补充的是官方右侧预览**没有**的能力：
- 在会话区内部展开文本文件（不离开会话）
- 编辑文件内容并作为消息发送到会话
- 从轮次产出/交付/改动中自动提取文件列表
- 打开方式选择（默认应用 / 指定应用 / 文件管理器）
- 选中行发送（连同行号）

两者是互补关系，不冲突。`markdown-turn-client` 注册在 `turnTail`，官方右侧预览注册在文件链接的点击行为上。

---

## 不需要拆分的（保留在 dsh-acp-agent 中）

| 功能 | 原因 |
|---|---|
| ACP 传输层（transport.ts） | 纯后端，无 UI |
| 会话管理（registry.ts、session-lifecycle.ts） | 纯后端 |
| 模型目录注册（catalog-registration.ts） | 纯后端，注册到 DSH 的 modelDirectories 服务 |
| 审批桥接（approval-bridge.ts） | 纯后端 |
| 问题桥接（question-bridge.ts） | 纯后端 |
| 切换机制（switch-*.ts） | 纯后端，会话级别的 agent 切换 |
| 网关（gateway.ts、gateway-feed.ts） | 纯后端 |
| 内容写入（content-writer.ts） | 纯后端 |
| 步骤定位（step-position.ts） | 纯后端 |
| 分段器（segmentation.ts） | 纯后端 |
| Mermaid 静态资源路由（mermaid-asset.ts） | 纯后端，依赖 node:fs |
| 配额路由（zcode-quota.ts 等） | 纯后端，宿主 HTTP 路由 |
| 预设分发（dispatch.ts、plugin.ts） | 纯后端，preset 注册 |
| 主机过滤（host-filter.ts） | 纯后端 |
| 名册过滤（roster-filter.ts） | 纯后端，修改 agentPresets 服务 |

---

## 拆分后的插件关系

```
dsh-acp-agent（后端，保留）
  ├── 提供 ACP agent 协议实现
  ├── 提供模型目录注册
  ├── 提供 Mermaid 静态资源路由 (/threadharbor/mermaid.js)
  ├── 提供配额 HTTP 路由 (/threadharbor/*/quota)
  └── 产出 agent-switch/handover 回合结束原因

新前端插件（各自独立安装）
  ├── @threadharbor/quota-pill-client     → 读宿主配额路由，注册 dock 胶囊
  ├── @threadharbor/mermaid-client        → 读宿主 mermaid.js 路由，渲染图表
  ├── @threadharbor/acp-visibility-client → 设置面板 + 模型目录过滤
  ├── @threadharbor/switch-progress-client → shell.overlay 进度条
  ├── @threadharbor/handover-client        → 切换移交通知卡片
  ├── @threadharbor/lost-input-client      → 失败回合恢复
  ├── @threadharbor/interrupted-recovery-client → 被打断轮次找回
  ├── @threadharbor/markdown-turn-client   → Markdown 文件展开
  ├── @threadharbor/acp-process-client     → ACP 过程视图增强
  ├── @threadharbor/model-label-client     → 模型标签 provider 前缀
  └── @threadharbor/session-id-bar-client  → 会话编号栏
```

---

## 实施注意事项

1. **`dsh-client` 中的角色变化**：拆分后 `dsh-client` 变为一个「容器插件」，负责安装所有子插件。或者，如果你希望完全独立，可以去掉 `dsh-client`，让用户单独安装需要的功能插件。

2. **`package.json` 的 `dsh` 字段**：每个前端插件的 `package.json` 必须有正确的 `dsh.client.inject` 和 `dsh.client.platform` 声明。`inject` 只列该插件真正需要的服务——这样缺少某个服务时，DSH 会等它，而不是让整个插件链崩溃。

3. **插槽类型安全**：每个插件需要 import `@deepseek-ai/dsh-client-ui-slots` 并声明 `SlotMap` 的模块合并，以获得插槽名的类型检查。参考现有 `dsh-client/src/client/index.ts` 中的 import type 模式。

4. **降级策略**：每个插件应该用 `slots.inject` 等待插槽声明（而不是立即注册），这样插槽不存在时插件只是不注册，不报错。对于服务依赖，使用 `ctx.inject` 或防御性 `ctx.get`。

5. **工作树开发**：按仓库守则，在 `.worktrees/` 下开工作树开发，完成后合并回 `main` 并重建。

6. **测试**：每个拆出的插件需要有独立的测试文件，验证注册逻辑和降级行为。
