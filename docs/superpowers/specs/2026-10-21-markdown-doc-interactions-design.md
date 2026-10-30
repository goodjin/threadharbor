# 会话区 Markdown 文档框交互增强 — 设计

日期：2026-10-21
范围：仅 `packages/dsh-client`（threadharbor 覆盖层）。不改宿主 `reference/deepseek-harness`。

## 背景与约束

- 会话区 Markdown 文档框由 `markdown-turn.tsx` 的 `MarkdownDocument` 渲染；
  正文来自编译包 `MarkdownText`（`@deepseek-ai/dsh-client-ui-primitives`），
  **不可改**。因此正文交互一律用「包裹层 + CSS + 事件委托」实现。
- 发送通道复用宿主已有的 `remote.session.prompt`
  （payload `{requestId, sessionId, mode:'queue', content:[{type:'text',text}]}`，
  见 `dsh-preset-dispatch/src/switch-mount.ts:217`）。
- **无法写宿主输入框草稿**：宿主 `SessionInputResolver.setDraft` 在
  `reference/deepseek-harness` 宿主里，threadharbor 拿不到。故不做「写草稿」。
- 宿主底部输入框**没有隐藏接口**。方案 A：打开 compose box 时把宿主底部
  输入框滚动挤出视口，发送后滚回（复用 `markdown-turn.tsx` 已有的
  `conversationScroller` + `scrollTop` 手法）。宿主零改动。
- 宿主底部输入框 DOM 锚点：`[data-composer-seat]` /
  `[data-conversation-region="composer"]`。

## 已确认的行为决策

1. **直接发送**（选区操作条 & 行内按钮 & 编辑发送）：选区/块/编辑框原文
   立即作为一条消息发出。
2. **添加到会话**：在文档框内展开一个自有 compose box（自带输入框 + 发送按钮）；
   同时滚动挤出宿主底部输入框腾空间；发送后 compose box 收起、宿主输入框滚回。
3. **评论**：弹小输入框写评论，可在多处分别评论；每条挂在所评正文段后可单独
   删除；底部出现发送按钮，按引用格式把整篇 md 合成再发。
4. **评论合成格式**（被评正文段与评论之间、评论与下一段之间各加换行）：

   ```
   <被评正文段>

   > 这是用户对此段话的评论：
   <评论文本>

   ```

## 功能设计

### 落点文件

- `markdown-turn.tsx` — `MarkdownDocument` 组件加三块交互。
- `markdown-turn.module.css` — hover 高亮、行内按钮、操作条、compose box 样式。
- `markdown-turn-sources.ts` — `MarkdownTurnReaders` 加 `sendToSession(sessionId, text)`；
  `createMarkdownTurnReaders` 实现，走 `remote()` 解析 `remote.session.prompt`。
- `locales.ts` — 中英文案各补一组键。
- `tests/markdown-turn.spec.ts` — 扩测试。

### 功能一：选中文本操作条

- 正文容器（`[data-markdown-body]` 内的 `.markdown`）监听 `mouseup` /
  `selectionchange`；选区落在 `.markdown` 且非空时，在选区附近浮出操作条：
  **添加到会话 / 直接发送 / 评论**。
- **直接发送**：`sendToSession(sessionId, 选区原文)`。
- **添加到会话**：展开 compose box（见功能一·compose box 小节）。
- **评论**：点开弹小输入框写评论文本；可多处评论；每条挂到所评段后可删除；
  底部发送按钮，按「评论合成格式」把整篇 md（`body.text` + 各段评论）合成后
  `sendToSession`。
- 点空白 / 选区清空时操作条消失。

compose box（「添加到会话」）：

- 文档框内展开自有输入框 + 发送按钮，初值可选为当前选中正文。
- 打开时滚动挤出宿主底部输入框；发送后 compose box 收起、宿主输入框滚回。
- 发送：`sendToSession(sessionId, compose 文本)`。

### 功能二：每行 hover 高亮 + 行内按钮

- `MarkdownText` 输出稳定块级元素（`.markdown > p/li/h1…`）。CSS `:hover`
  给块加背景高亮，只加在块上，不波及链接等内联元素。
- hover 时块右侧浮出 **发送到会话 / 直接发送 / 复制**
  （`IconSendOutline` / `IconEditOutline` / `IconCopyOutline`），半透明底衬
  保证跨主题可见。
- 正文容器挂一个 click 委托监听：按最近的块元素取原文。
  - 直接发送：`sendToSession(sessionId, 块原文)`。
  - 复制：写剪贴板。
- 为避免与「选中文本」冲突，行内按钮点击时 `stopPropagation` 且
  `preventDefault`，不触发选区。

### 功能三：编辑按钮 + 下方发送

- 路径栏右侧（`ExpandButton` 旁）加 `IconEditOutline` **编辑**按钮
  （`markdownTurn.edit`）。
- 点开：正文 `MarkdownText` 切换成可编辑 `textarea`（初值 `body.text`），
  下方出现**发送**按钮（`IconSendOutline`）。
- 点击发送：`sendToSession(sessionId, textarea 值)`。
- 再点编辑（或发送后）切回只读视图。

## 文案（locales.ts 中英各补）

`markdownTurn.send`、`sendToSession`、`edit`、`comment`、`commentPlaceholder`、
`commentSend`、`commentedAs`（"这是用户对此段话的评论"）、
`composePlaceholder`、`sendFailed`、`copyFailed` 等。

## 测试

扩 `markdown-turn.spec.ts`（reader mock 带 `sendToSession`）：

- 选区操作条出现 / 消失；直接发送以选区原文调用 `sendToSession`。
- 评论合成格式：多处评论各挂段后，发送时以正确合成文本调用 `sendToSession`。
- 行内按钮委托：点击块按钮取块原文发送 / 复制。
- 编辑：切 textarea、发送以编辑值调用 `sendToSession`。
- compose box：打开 / 发送 / 收起。

## 非目标

- 不写宿主输入框草稿（无接口）。
- 不真隐藏宿主底部输入框（无接口；用滚动挤出替代）。
- 不改 `MarkdownText` 编译包。
- 不改 `reference/deepseek-harness` 宿主。
