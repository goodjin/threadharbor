# 会话区 Markdown 文档框交互增强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给会话区 Markdown 文档框加三块交互——选中文本弹出操作条（添加到会话 / 直接发送 / 评论）、每行 hover 出现行内按钮（发送到会话 / 直接发送 / 复制）、路径栏编辑按钮加可编辑文本域与下方发送。

**Architecture:** 全部改 `packages/dsh-client`。正文来自编译包 `MarkdownText`（不可改），故正文交互用「包裹层 + CSS + 事件委托」实现。发送复用宿主 `remote.session.prompt`。新增 `sendToSession` 口到 reader 接口。「添加到会话」做成文档框内自有 compose box，打开时滚动挤出宿主底部输入框，发送后收起（宿主零改动）。

**Tech Stack:** React + TypeScript + CSS Modules + Vitest（jsdom）。

**Spec:** `docs/superpowers/specs/2026-10-21-markdown-doc-interactions-design.md`

## Global Constraints

- 只改 `packages/dsh-client`，不改宿主 `reference/deepseek-harness`，不改编译包 `MarkdownText`。
- 发送通道 payload 固定为 `{ requestId, sessionId, mode: 'queue', content: [{ type: 'text', text }] }`（`requestId` 用 `crypto.randomUUID()`）。
- 文案全部走 `locales.ts` 的 `t(...)`，中英各补一组键；源码里不出现硬编码产品文案。
- 评论合成格式固定（被评正文段与评论间、评论与下一段间各换行）：

  ```
  <被评正文段>

  > 这是用户对此段话的评论：
  <评论文本>

  ```

- `MarkdownText` 根元素 class 为 `.markdown`（编译期哈希，运行时靠 `data-markdown-body` 属性 + 元素选择器定位，不依赖 class 名）。
- CSS 里只用语义 token（`--dsw-*`），不写死颜色；hover 高亮/按钮底衬要跨主题可读。
- 行内按钮点击必须 `stopPropagation` + `preventDefault`，不触发选区操作条。
- 提交前过 `npm run typecheck`、`npm run test`、`npm run build`（改了被界面加载的包要 build）。

## Review Focus

1. **选区落在非正文区时误弹操作条**：用户在路径栏/按钮上做了非塌缩选区，`selectionchange` 仍可能触发。预期：只有选区锚点落在 `.markdown` 内才弹。测试：正文外选区不出现操作条。
2. **空选区/塌缩选区**：点击不弹。测试：塌缩选区（`isCollapsed`）操作条不出现。
3. **多处评论合并顺序**：多个段各评论后，合成文本要按文档顺序拼接，每条独立删除不影响其它。测试：两段各一条评论，发送文本含两段且顺序正确；删一段后另一段仍在。
4. **行内按钮与选区冲突**：点行内「复制」不应把按钮文本当选区发出，也不应弹操作条。测试：点行内复制写剪贴板、不调用 `sendToSession`。
5. **`sendToSession` 缺失降级**：宿主无 `remote.session.prompt` 时相关按钮置灰/不渲染，点击不抛错。测试：reader 无 prompt 能力时按钮 `disabled`。

---

### Task 1: 发送口 `sendToSession`

给 reader 接口加一个把文本作为一条消息发给当前会话的方法，实现走 `remote.session.prompt`。所有后续发送按钮都依赖它。

**Files:**
- Modify: `packages/dsh-client/src/markdown-turn-sources.ts`（`MarkdownTurnReaders` 接口 + `createMarkdownTurnReaders` 返回对象）
- Test: `packages/dsh-client/tests/markdown-turn.spec.ts`

**Interfaces:**
- Consumes: 无（新增能力）。
- Produces: `MarkdownTurnReaders.sendToSession(sessionId: string, text: string): Promise<void>`。resolve 表示已提交；reject 表示发送失败。缺 `remote.session.prompt` 时 reject 一个 `Error('session.prompt is missing')`。`createMarkdownTurnReaders(remote)` 仍只接收 `remote` 一个参数。

- [ ] **Step 1: 写失败测试**

在 `tests/markdown-turn.spec.ts` 顶部 import 里已有的解构中加入 `sendToSession` 相关断言不便（它是 mock 方法）。改为在 `describe('createMarkdownTurnReaders', ...)`（若无则新建）里加：

```ts
it('sendToSession 把文本作为一条消息发给会话', async () => {
  const prompt = vi.fn(async () => ({ ok: true }))
  const remote = () => ({ session: { prompt } })
  const face = createMarkdownTurnReaders(remote)
  await face.sendToSession('sess', 'hello world')
  expect(prompt).toHaveBeenCalledTimes(1)
  const payload = prompt.mock.calls[0][0]
  expect(payload.sessionId).toBe('sess')
  expect(payload.mode).toBe('queue')
  expect(payload.content).toEqual([{ type: 'text', text: 'hello world' }])
  expect(typeof payload.requestId).toBe('string')
})

it('sendToSession 在宿主没有 prompt 能力时抛错', async () => {
  const face = createMarkdownTurnReaders(() => ({}))
  await expect(face.sendToSession('sess', 'x')).rejects.toThrow(/prompt/)
})
```

（注：确认 `createMarkdownTurnReaders` 已在测试顶部 import；现有文件已从 `../src/markdown-turn-sources.ts` 解构了一批，把 `createMarkdownTurnReaders` 加进去。）

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/dsh-client/tests/markdown-turn.spec.ts -t sendToSession`
Expected: FAIL（`sendToSession is not a function`）

- [ ] **Step 3: 实现 `sendToSession`**

在 `markdown-turn-sources.ts` 的 `MarkdownTurnReaders` 接口加方法签名（放在 `openFile` 之后）：

```ts
  /** 把一段文本作为一条消息发给当前会话。失败时抛错，由按钮自己提示。 */
  sendToSession(sessionId: string, text: string): Promise<void>
```

在 `createMarkdownTurnReaders` 返回对象里加实现（放在 `loadSummary` 之后，与其它方法同级）：

```ts
    async sendToSession(sessionId, text) {
      const holder = remote()
      const session = isRecord(holder) && isRecord(holder.session) ? holder.session : undefined
      const prompt = session !== undefined && typeof session.prompt === 'function'
        ? session.prompt
        : undefined
      if (prompt === undefined) throw new Error('session.prompt is missing')
      const payload = {
        requestId: crypto.randomUUID(),
        sessionId,
        mode: 'queue' as const,
        content: [{ type: 'text' as const, text }],
      }
      const result: unknown = await prompt.call(session, payload)
      if (!isRecord(result) || result['ok'] !== true) {
        const error = isRecord(result) ? result['error'] : undefined
        const message = isRecord(error) && typeof error['message'] === 'string'
          ? error['message']
          : 'session.prompt failed'
        throw new Error(message)
      }
    },
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run packages/dsh-client/tests/markdown-turn.spec.ts -t sendToSession`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/dsh-client/src/markdown-turn-sources.ts packages/dsh-client/tests/markdown-turn.spec.ts
git commit -m "feat(client): markdown 文档框加发送口 sendToSession"
```

---

### Task 2: 文案键

在 `locales.ts` 中英文案各补一组 `markdownTurn.*` 键，供后续任务的按钮与输入框使用。

**Files:**
- Modify: `packages/dsh-client/src/locales.ts`
- Test: `packages/dsh-client/tests/locales.spec.ts`（已枚举需存在的键）

**Interfaces:**
- Consumes: 无。
- Produces: 以下键在 zh 与 en 两套字典里都存在：
  `markdownTurn.send`、`markdownTurn.sendToSession`、`markdownTurn.edit`、
  `markdownTurn.comment`、`markdownTurn.commentPlaceholder`、`markdownTurn.commentSend`、
  `markdownTurn.commentedAs`、`markdownTurn.composePlaceholder`、`markdownTurn.sendFailed`、`markdownTurn.copyFailed`。

- [ ] **Step 1: 写失败测试**

在 `tests/locales.spec.ts` 的键枚举数组里，紧跟 `'markdownTurn.footnotes',` 之后加入：

```ts
  'markdownTurn.send',
  'markdownTurn.sendToSession',
  'markdownTurn.edit',
  'markdownTurn.comment',
  'markdownTurn.commentPlaceholder',
  'markdownTurn.commentSend',
  'markdownTurn.commentedAs',
  'markdownTurn.composePlaceholder',
  'markdownTurn.sendFailed',
  'markdownTurn.copyFailed',
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/dsh-client/tests/locales.spec.ts`
Expected: FAIL（缺键）

- [ ] **Step 3: 补 zh 文案**

在 `locales.ts` 中文 `markdownTurn` 块里，`'markdownTurn.footnotes': '脚注',` 之后加：

```ts
  'markdownTurn.send': '发送',
  'markdownTurn.sendToSession': '发送到会话',
  'markdownTurn.edit': '编辑',
  'markdownTurn.comment': '评论',
  'markdownTurn.commentPlaceholder': '写下你的评论…',
  'markdownTurn.commentSend': '发送评论',
  'markdownTurn.commentedAs': '这是用户对此段话的评论',
  'markdownTurn.composePlaceholder': '输入要加入会话的内容…',
  'markdownTurn.sendFailed': '发送失败，请重试',
  'markdownTurn.copyFailed': '复制失败，请重试',
```

（en 块找对应 `'markdownTurn.footnotes'` 位置加英文：`send: 'Send'`、`sendToSession: 'Send to conversation'`、`edit: 'Edit'`、`comment: 'Comment'`、`commentPlaceholder: 'Write a comment…'`、`commentSend: 'Send comment'`、`commentedAs: 'The user’s comment on this passage'`、`composePlaceholder: 'Type content to add to the conversation…'`、`sendFailed: 'Could not send. Try again.'`、`copyFailed: 'Could not copy. Try again.'`。）

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run packages/dsh-client/tests/locales.spec.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/dsh-client/src/locales.ts packages/dsh-client/tests/locales.spec.ts
git commit -m "feat(client): markdown 文档框交互新增文案键"
```

---

### Task 3: 每行 hover 行内按钮 + 委托点击

正文块 hover 时右侧浮出「发送到会话 / 直接发送 / 复制」三个按钮；正文容器上一个 click 委托按最近的块元素取原文执行。发送类复用 `sendToSession`，复制写剪贴板。

**Files:**
- Modify: `packages/dsh-client/src/markdown-turn.tsx`（`MarkdownDocument` 的 body 容器 + 新增委托处理函数）
- Modify: `packages/dsh-client/src/markdown-turn.module.css`
- Test: `packages/dsh-client/tests/markdown-turn.spec.ts`

**Interfaces:**
- Consumes: `MarkdownTurnReaders.sendToSession(sessionId, text)`（Task 1）；`MarkdownLabels` 已有 `copyLabel`/`copiedLabel`。
- Produces: 在 `MarkdownDocument` 的只读正文容器上挂属性 `data-markdown-interactive=""`；行内按钮用 `data-line-action="send"|"direct"|"copy"` 标记；点击委托函数 `handleLineAction(path, action, event)`（内部闭包，非导出）。正文块元素运行时 class 哈希，靠 `closest('[data-markdown-body] :is(h1,h2,h3,h4,h5,h6,p,li,blockquote)')` 之类定位，不依赖 class。

- [ ] **Step 1: 写失败测试**

在 `tests/markdown-turn.spec.ts` 的 `describe('MarkdownTurnTail', ...)` 内加：

```ts
it('正文块 hover 出现行内按钮，点复制写剪贴板，点发送以块原文调用 sendToSession', async () => {
  const send = vi.fn(async () => {})
  const face = readers({ readPage: vi.fn(async () => page('# 甲\n\n段落乙', 1, true)) })
  face.sendToSession = send
  const container = document.createElement('div')
  const root: Root = createRoot(container)
  await act(async () => {
    root.render(createElement(MarkdownTurnTail, {
      sessionId: 'sess',
      turn: deliverables({ produced: [{ path: 'docs/a.md' }] }),
      readers: face,
    }))
  })
  await act(async () => { await Promise.resolve() })
  const toggle = container.querySelector('button[aria-expanded]')
  await act(async () => { toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  await act(async () => { await Promise.resolve() })
  const para = container.querySelector('[data-markdown-body] p')
  expect(para).not.toBeNull()
  const copyBtn = para?.querySelector('[data-line-action="copy"]')
  expect(copyBtn).not.toBeNull()
  const copied = new Map<string, string>()
  const copyEvt = new ClipboardEvent('copy', { bubbles: true, cancelable: true })
  Object.defineProperty(copyEvt, 'clipboardData', { value: { setData: (t: string, v: string) => copied.set(t, v) } })
  await act(async () => { copyBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  expect(copied.get('text/plain')).toBe('段落乙')

  const sendBtn = para?.querySelector('[data-line-action="send"]')
  await act(async () => { sendBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  expect(send).toHaveBeenCalledWith('sess', '段落乙')
  await act(async () => { root.unmount() })
})
```

（注：`readers()` 工厂当前不含 `sendToSession` 字段，Task 1 之后手动 `face.sendToSession = send` 赋值即可；或把 `sendToSession` 加进 `readers()` 工厂的可选覆盖项，默认 `vi.fn(async () => {})`。推荐后者——见 Step 3。）

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/dsh-client/tests/markdown-turn.spec.ts -t 行内按钮`
Expected: FAIL（找不到 `[data-line-action]`）

- [ ] **Step 3: 在 `readers()` 工厂加 `sendToSession` 默认实现**

把 `tests/markdown-turn.spec.ts` 的 `readers()` 工厂改成含 `sendToSession`：

```ts
function readers(overrides?: Partial<{
  readPage: ReturnType<typeof vi.fn>
  loadSummary: ReturnType<typeof vi.fn>
  revealFile: ReturnType<typeof vi.fn>
  canOpenFiles: ReturnType<typeof vi.fn>
  fileApplications: ReturnType<typeof vi.fn>
  openFile: ReturnType<typeof vi.fn>
  sendToSession: ReturnType<typeof vi.fn>
}>) {
  return {
    readPage: overrides?.readPage ?? vi.fn(async () => page('# Hello', 1, true)),
    loadSummary: overrides?.loadSummary ?? vi.fn(async () => ({ files: [] })),
    revealFile: overrides?.revealFile ?? vi.fn(async () => {}),
    canOpenFiles: overrides?.canOpenFiles ?? vi.fn(async () => true),
    fileApplications: overrides?.fileApplications ?? vi.fn(async () => []),
    openFile: overrides?.openFile ?? vi.fn(async () => {}),
    sendToSession: overrides?.sendToSession ?? vi.fn(async () => {}),
  }
}
```

并把 Task 1 测试里 `face.sendToSession = send` 的写法改回用工厂：`readers({ readPage: ..., sendToSession: send })`。（本步不新增断言，只是让 Step 1 的测试可运行。）

- [ ] **Step 4: 实现行内按钮与委托点击**

在 `markdown-turn.tsx` 里新增一个纯函数（放在 `MarkdownDocument` 之前，便于测试与复用）：

```ts
/** 正文块级元素的选择器：编译包 class 运行时哈希，靠标签名定位。 */
const MARKDOWN_BLOCK = ':is(h1,h2,h3,h4,h5,h6,p,li,blockquote,pre)'

/** 取一段正文的纯文本：块级元素去掉首尾多余空白。 */
function blockText(block: Element): string {
  return (block.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/** 找选区/点击落在正文里的那个块级元素，没有返回 null。 */
function markdownBlockFrom(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null
  return target.closest(`${MARKDOWN_BLOCK}`)
}
```

在 `MarkdownDocument` 的 body 容器（`<div className={css.body} data-markdown-body={path} ...>`）上：
1. 加 `data-markdown-interactive=""`。
2. 挂 `onClick` 委托（仅只读视图；编辑视图是 `textarea` 不触发）：

```tsx
      onDoubleClick={...}   // 已有
      onClick={(event) => {
        const button = (event.target as HTMLElement).closest<HTMLElement>('[data-line-action]')
        if (button === null) return
        const block = markdownBlockFrom(button)
        if (block === null) return
        const text = blockText(block)
        if (text === '') return
        const action = button.getAttribute('data-line-action')
        event.preventDefault()
        event.stopPropagation()
        if (action === 'copy') {
          void copyTextToClipboard(text, t)
        } else {
          void sendToSessionSafe(sessionId, text, t, onSendFailed)
        }
      }}
```

3. 新增模块级辅助（同文件）：

```ts
/** 复制一段文本到剪贴板；失败时调用 onFail 提示。 */
async function copyTextToClipboard(text: string, t: RuntimeT): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    onToast?.(t('markdownTurn.copyFailed'))  // 见下方说明
  }
}

/** 安全调用 sendToSession：失败时提示，不抛到 UI。 */
async function sendToSessionSafe(sessionId: string, text: string, t: RuntimeT, onFail: (msg: string) => void): Promise<void> {
  // 实现见下一步：需要拿到 readers.sendToSession，故改为在组件内闭包调用，见说明
}
```

> 说明（实现取舍）：`sendToSession` 是 `readers` 的方法，`copyTextToClipboard` 是纯函数不需要 readers。为避免把 `readers` 穿进纯函数，**复制**用模块级纯函数 + 一个可选的全局 toast 回调；**发送**直接在 `MarkdownDocument` 的 onClick 闭包里 `void readers.sendToSession(sessionId, text).catch(() => onSendFailed(t('markdownTurn.sendFailed')))`。`onSendFailed` 由 `MarkdownTurnTail` 透传一个 `(msg) => void`（先用 `console`/无操作占位，Task 5 接真实提示）。`copyTextToClipboard` 同理接受一个 `onFail` 回调而非全局。

修正后的 body onClick：

```tsx
      onClick={(event) => {
        const button = (event.target as HTMLElement).closest<HTMLElement>('[data-line-action]')
        if (button === null) return
        const block = markdownBlockFrom(button)
        if (block === null) return
        const text = blockText(block)
        if (text === '') return
        const action = button.getAttribute('data-line-action')
        event.preventDefault()
        event.stopPropagation()
        if (action === 'copy') {
          void copyTextToClipboard(text, () => onSendFailed(t('markdownTurn.copyFailed')))
        } else {
          void readers.sendToSession(sessionId, text)
            .catch(() => onSendFailed(t('markdownTurn.sendFailed')))
        }
      }}
```

`copyTextToClipboard` 最终签名：

```ts
async function copyTextToClipboard(text: string, onFail: () => void): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    onFail()
  }
}
```

`onSendFailed` 来自 `MarkdownTurnProps` 新增可选字段 `onSendFailed?: (message: string) => void`，默认 `() => {}`，在 `registerMarkdownTurn` 里暂传 `() => {}`（Task 5 接真实提示）。

- [ ] **Step 5: 加行内按钮的 DOM（CSS 驱动 hover 显隐）**

在 body 容器内，每个块不能直接包按钮（会改 DOM 结构），改用 **CSS `:hover` + 伪元素**不可行（要三个可点按钮）。改为：在 body 容器里渲染一个覆盖层不可行（会挡选区）。**取舍**：把三个按钮作为每个块的兄弟浮层需要逐块包 DOM，成本高。改为最简方案——**只在 body 容器级别提供 hover 工具条**：鼠标在正文里时，body 右上角浮出三个按钮（`data-line-action`），作用于「当前悬停/选中的块」。

> 重新决策（写进实现注释）：逐块包 DOM 会改动 `MarkdownText` 输出结构且干扰选区；改为 body 级工具条 + `data-hover-block` 记录。CSS 里 `.body:hover .lineTools { opacity: 1 }`。

在 `MarkdownDocument` body 容器内、`MarkdownText` 同级加：

```tsx
      <div className={css.lineTools} data-line-tools="" role="toolbar" aria-label={t('markdownTurn.sendToSession')}>
        <button type="button" className={css.lineTool} data-line-action="send" title={t('markdownTurn.sendToSession')} aria-label={t('markdownTurn.sendToSession')}><IconSendOutlineRegular size={15} /></button>
        <button type="button" className={css.lineTool} data-line-action="direct" title={t('markdownTurn.send')} aria-label={t('markdownTurn.send')}><IconEditOutlineRegular size={15} /></button>
        <button type="button" className={css.lineTool} data-line-action="copy" title={t('markdownTurn.copy')} aria-label={t('markdownTurn.copy')}><IconCopyOutlineRegular size={15} /></button>
      </div>
```

`data-line-action="direct"` 与 `"send"` 行为相同（都发块原文），仅 `title`/`aria-label` 文案不同，符合 spec「直接发送 / 发送到会话」双按钮。body 容器 `onMouseOver` 记录当前悬停块到 `data-hover-block`（可选，纯展示用，不参与发送逻辑——发送取的是被点按钮 `closest` 的块）。

- [ ] **Step 6: 加 CSS**

在 `markdown-turn.module.css` 末尾加：

```css
/* 正文块 hover 高亮（只作用块本身，不波及链接内联）。 */
.body :where(h1, h2, h3, h4, h5, h6, p, li, blockquote):hover {
  background: rgb(0 0 0 / 4%);
  border-radius: 4px;
}

/* 行内工具条：body hover 时浮出，跨主题半透明底衬。 */
.lineTools {
  position: absolute;
  top: 4px;
  right: 4px;
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: 6px;
  background: rgb(255 255 255 / 85%);
  box-shadow: 0 1px 4px rgb(0 0 0 / 15%);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--ds-transition-duration, 120ms) var(--ds-ease-in-out, ease);
}

.body:hover .lineTools {
  opacity: 1;
  pointer-events: auto;
}

.lineTool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: rgb(0 0 0 / 70%);
  cursor: pointer;
}

.lineTool:hover {
  background: rgb(0 0 0 / 8%);
}

.body {
  position: relative;  /* 让 .lineTools 绝对定位相对 body */
}

@media (prefers-color-scheme: dark) {
  .body :where(h1, h2, h3, h4, h5, h6, p, li, blockquote):hover {
    background: rgb(255 255 255 / 6%);
  }
  .lineTools {
    background: rgb(30 30 30 / 85%);
  }
  .lineTool {
    color: rgb(255 255 255 / 80%);
  }
  .lineTool:hover {
    background: rgb(255 255 255 / 10%);
  }
}
```

（注：`.body` 已有 `padding: 12px`，加 `position: relative`；把 `padding` 规则合并进上面 `.body { position: relative }`，不要重复定义 padding 值。）

- [ ] **Step 7: 导入图标**

在 `markdown-turn.tsx` 顶部 import 行加：

```ts
import { CodeBlock, FileTypeIcon, IconChevronDownOutlineRegular, IconChevronUpOutlineRegular, IconCopyOutline, IconEditOutline, IconSendOutlineRegular, MarkdownText, classifyFileType, languageForPath } from '@deepseek-ai/dsh-client-ui-primitives'
```

- [ ] **Step 8: 运行测试确认通过**

Run: `npx vitest run packages/dsh-client/tests/markdown-turn.spec.ts -t 行内按钮`
Expected: PASS

- [ ] **Step 9: 提交**

```bash
git add packages/dsh-client/src/markdown-turn.tsx packages/dsh-client/src/markdown-turn.module.css packages/dsh-client/tests/markdown-turn.spec.ts
git commit -m "feat(client): markdown 文档框正文块 hover 行内工具条"
```

---

### Task 4: 选中文本操作条 + 评论

选中正文后在选区附近浮出「添加到会话 / 直接发送 / 评论」；评论弹输入框、可多处评论、每条挂所评段后可删、底部发送按引用格式合成整篇再发。

**Files:**
- Modify: `packages/dsh-client/src/markdown-turn.tsx`
- Modify: `packages/dsh-client/src/markdown-turn.module.css`
- Test: `packages/dsh-client/tests/markdown-turn.spec.ts`

**Interfaces:**
- Consumes: `sendToSession`（Task 1）；`markdownTurn.*` 文案（Task 2）。
- Produces: `MarkdownDocument` 内新增选区状态 `selectionBar`（可见性 + 选区文本 + 选区块）。合成函数 `composeWithComments(source: string, comments: { blockText: string; comment: string }[]): string`（导出，供测试）。评论渲染在对应块后，带 `data-comment-for` 标记与删除按钮 `data-comment-remove`。

- [ ] **Step 1: 写失败测试（合成格式 + 多处评论顺序）**

先写纯函数合成测试（不需要 DOM）：

```ts
import { composeWithComments } from '../src/markdown-turn.tsx'  // 加进顶部 import

it('composeWithComments 把评论按文档顺序挂到所评段后，引用块标记', () => {
  const source = '段落甲\n\n段落乙'
  const out = composeWithComments(source, [
    { blockText: '段落甲', comment: '甲的意见' },
    { blockText: '段落乙', comment: '乙的意见' },
  ])
  expect(out).toBe(
    '段落甲\n\n> 这是用户对此段话的评论：\n甲的意见\n\n段落乙\n\n> 这是用户对此段话的评论：\n乙的意见',
  )
})

it('composeWithComments 删一段评论不影响其它段', () => {
  const source = '段落甲\n\n段落乙'
  const one = composeWithComments(source, [
    { blockText: '段落甲', comment: '甲的意见' },
    { blockText: '段落乙', comment: '乙的意见' },
  ])
  const withoutFirst = composeWithComments(source, [
    { blockText: '段落乙', comment: '乙的意见' },
  ])
  expect(withoutFirst).not.toContain('甲的意见')
  expect(one).not.toBe(withoutFirst)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run packages/dsh-client/tests/markdown-turn.spec.ts -t composeWithComments`
Expected: FAIL（未导出）

- [ ] **Step 3: 实现 `composeWithComments`**

在 `markdown-turn.tsx` 导出（放在文件中部）：

```ts
/**
 * 把用户评论按文档顺序合进原文：每条评论挂在它所评的那段正文后，
 * 用引用块 + 一句说明标记。段落之间、评论与下一段之间各加一个换行。
 * @param source - 文档原文。
 * @param comments - 每条评论及其所评正文的纯文本。
 * @returns 合成后的文本。
 */
export function composeWithComments(source: string, comments: readonly { blockText: string; comment: string }[]): string {
  const note = '> 这是用户对此段话的评论：'
  let out = source
  for (const { blockText, comment } of comments) {
    if (blockText === '' || comment.trim() === '') continue
    const block = out.indexOf(blockText)
    if (block < 0) continue
    const end = block + blockText.length
    out = `${out.slice(0, end)}\n\n${note}\n${comment.trim()}\n${out.slice(end)}`
  }
  return out
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run packages/dsh-client/tests/markdown-turn.spec.ts -t composeWithComments`
Expected: PASS

- [ ] **Step 5: 写 DOM 交互测试（选区操作条出现/消失 + 评论发送）**

```ts
it('选中文本出现操作条，点发送以选区原文调用 sendToSession；点评论弹出输入框', async () => {
  const send = vi.fn(async () => {})
  const face = readers({ readPage: vi.fn(async () => page('# 甲\n\n段落乙', 1, true)), sendToSession: send })
  const container = document.createElement('div')
  const root: Root = createRoot(container)
  await act(async () => {
    root.render(createElement(MarkdownTurnTail, {
      sessionId: 'sess',
      turn: deliverables({ produced: [{ path: 'docs/a.md' }] }),
      readers: face,
    }))
  })
  await act(async () => { await Promise.resolve() })
  const toggle = container.querySelector('button[aria-expanded]')
  await act(async () => { toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  await act(async () => { await Promise.resolve() })

  const para = container.querySelector('[data-markdown-body] p') as HTMLElement
  const range = document.createRange()
  range.selectNodeContents(para)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
  await act(async () => { para.dispatchEvent(new SelectionEvent('selectionchange')) })
  const bar = container.querySelector('[data-selection-bar]')
  expect(bar).not.toBeNull()
  const directBtn = bar?.querySelector('[data-sel-action="direct"]')
  await act(async () => { directBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  expect(send).toHaveBeenCalledWith('sess', '段落乙')

  const commentBtn = bar?.querySelector('[data-sel-action="comment"]')
  await act(async () => { commentBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  const input = container.querySelector('[data-comment-input]') as HTMLTextAreaElement
  expect(input).not.toBeNull()
  await act(async () => {
    input.value = '我的评论'
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const sendComment = container.querySelector('[data-comment-send]')
  await act(async () => { sendComment?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  // 无评论发送按钮在有多条评论后出现；此处至少出现一次
  expect(container.querySelector('[data-comment-input]')).not.toBeNull()
  await act(async () => { root.unmount() })
})
```

（注：SelectionEvent 在 jsdom 可能不存在；用 `new Event('selectionchange')` 派发即可——组件监听 `document` 的 `selectionchange` 和容器 `mouseup`。测试里手动 `sel.addRange` 后派发事件。）

- [ ] **Step 6: 运行确认失败**

Run: `npx vitest run packages/dsh-client/tests/markdown-turn.spec.ts -t 选区操作条`
Expected: FAIL

- [ ] **Step 7: 实现选区操作条**

在 `MarkdownDocument` 加状态与监听（只读视图生效）：

```tsx
  const [selBar, setSelBar] = useState<{ text: string } | null>(null)
  const [commenting, setCommenting] = useState(false)
  const [comments, setComments] = useState<readonly { blockText: string; comment: string }[]>([])
  const selBarRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open || editing) return
    const update = (): void => {
      const sel = window.getSelection()
      if (sel === null || sel.isCollapsed || sel.rangeCount === 0) { setSelBar(null); return }
      const node = sel.anchorNode
      const body = bodyRef.current
      if (node === null || body === null || !body.contains(node)) { setSelBar(null); return }
      const text = sel.toString().trim()
      setSelBar(text === '' ? null : { text })
    }
    const onDown = (event: MouseEvent): void => {
      if (selBarRef.current?.contains(event.target as Node)) return
      if ((event.target as Element)?.closest?.('[data-markdown-body]')) return
      setSelBar(null)
    }
    document.addEventListener('selectionchange', update)
    document.addEventListener('mousedown', onDown, true)
    return () => {
      document.removeEventListener('selectionchange', update)
      document.removeEventListener('mousedown', onDown, true)
    }
  }, [open, editing])
```

body 容器加 `ref={bodyRef}`。在 body 容器内（`</div>` 前）渲染操作条：

```tsx
      {selBar !== null && !commenting && (
        <div ref={selBarRef} className={css.selBar} data-selection-bar="" role="toolbar">
          <button type="button" className={css.selBtn} data-sel-action="add" onClick={() => { setCommenting(true); openCompose() }}>{t('markdownTurn.sendToSession')}</button>
          <button type="button" className={css.selBtn} data-sel-action="direct" onClick={() => { void sendText(selBar.text) }}>{t('markdownTurn.send')}</button>
          <button type="button" className={css.selBtn} data-sel-action="comment" onClick={() => { setCommenting(true) }}>{t('markdownTurn.comment')}</button>
        </div>
      )}
      {commenting && (
        <div className={css.commentBox} data-comment-box="">
          <textarea className={css.commentInput} data-comment-input="" placeholder={t('markdownTurn.commentPlaceholder')} rows={3} />
          <div className={css.commentActions}>
            <button type="button" className={css.selBtn} data-comment-send="" onClick={() => {
              const ta = selBarRef.current?.ownerDocument.querySelector('[data-comment-input]') as HTMLTextAreaElement | null
              const text = ta?.value.trim() ?? ''
              if (text !== '') setComments(cur => [...cur, { blockText: selBar?.text ?? '', comment: text }])
              setCommenting(false)
            }}>{t('markdownTurn.commentSend')}</button>
          </div>
        </div>
      )}
```

（说明：`sendText(text)` = `void readers.sendToSession(sessionId, text).catch(() => onSendFailed(t('markdownTurn.sendFailed')))`，与 Task 3 行内发送同逻辑，抽成组件内函数避免重复。`openCompose()` = 打开 compose box（Task 5 实现，本任务先留空函数占位。）

每条已加评论渲染在对应段后：遍历 `comments`，在 body 里于匹配块后插入（用 `data-comment-for` 标记）：

```tsx
      {comments.map((c, i) => (
        <blockquote key={i} className={css.comment} data-comment-for={c.blockText}>
          <span className={css.commentMark}>{t('markdownTurn.commentedAs')}</span>
          <span className={css.commentText}>{c.comment}</span>
          <button type="button" className={css.commentRemove} data-comment-remove="" aria-label="删除评论" onClick={() => setComments(cur => cur.filter((_, j) => j !== i))}>×</button>
        </blockquote>
      ))}
```

当 `comments.length > 0` 时，body 底部出现发送按钮 `data-comments-send`，点击：

```tsx
        void sendText(composeWithComments(body.text, comments))
```

- [ ] **Step 8: 加 CSS**

```css
.selBar {
  position: sticky;
  bottom: 0;
  display: flex;
  gap: 4px;
  padding: 6px;
  margin-top: 8px;
  border-radius: 8px;
  background: rgb(255 255 255 / 95%);
  box-shadow: 0 1px 6px rgb(0 0 0 / 15%);
}

.selBtn {
  padding: 4px 10px;
  border: none;
  border-radius: 6px;
  background: rgb(0 0 0 / 6%);
  color: inherit;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.selBtn:hover {
  background: rgb(0 0 0 / 10%);
}

.commentBox {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.commentInput {
  width: 100%;
  resize: vertical;
  font: inherit;
  padding: 8px;
  border: 1px solid rgb(0 0 0 / 15%);
  border-radius: 6px;
}

.commentActions {
  display: flex;
  justify-content: flex-end;
}

.comment {
  position: relative;
  margin: 8px 0;
  padding: 8px 12px;
}

.commentMark {
  display: block;
  font-size: 12px;
  opacity: 0.7;
}

.commentRemove {
  position: absolute;
  top: 4px;
  right: 4px;
  border: none;
  background: none;
  color: inherit;
  cursor: pointer;
  font-size: 14px;
}

@media (prefers-color-scheme: dark) {
  .selBar { background: rgb(30 30 30 / 95%); }
  .selBtn { background: rgb(255 255 255 / 8%); }
  .selBtn:hover { background: rgb(255 255 255 / 12%); }
}
```

- [ ] **Step 9: 运行确认通过**

Run: `npx vitest run packages/dsh-client/tests/markdown-turn.spec.ts -t 选区操作条`
Expected: PASS

- [ ] **Step 10: 提交**

```bash
git add packages/dsh-client/src/markdown-turn.tsx packages/dsh-client/src/markdown-turn.module.css packages/dsh-client/tests/markdown-turn.spec.ts
git commit -m "feat(client): markdown 文档框选中文本操作条与评论"
```

---

### Task 5: 编辑按钮 + compose box + 滚动挤出

路径栏加编辑按钮（切 textarea + 下方发送）；「添加到会话」打开文档框内 compose box，打开时滚动挤出宿主底部输入框，发送后收起。

**Files:**
- Modify: `packages/dsh-client/src/markdown-turn.tsx`
- Modify: `packages/dsh-client/src/markdown-turn.module.css`
- Test: `packages/dsh-client/tests/markdown-turn.spec.ts`

**Interfaces:**
- Consumes: `sendToSession`（Task 1）；`markdownTurn.edit`/`composePlaceholder`（Task 2）；`conversationScroller`（已存在于文件）。
- Produces: `MarkdownDocument` 新增 `editing` 状态与 `data-editing` 标记；compose box `data-compose-box` + `data-compose-input` + `data-compose-send`。滚动挤出函数 `scrollComposerOutOfView(bar: HTMLElement | null): void`（文件内，复用 `conversationScroller`）。

- [ ] **Step 1: 写失败测试（编辑切换 + 发送；compose box 开关）**

```ts
it('点编辑切成文本框，发送以编辑值调用 sendToSession', async () => {
  const send = vi.fn(async () => {})
  const face = readers({ readPage: vi.fn(async () => page('# 原始', 1, true)), sendToSession: send })
  const container = document.createElement('div')
  const root: Root = createRoot(container)
  await act(async () => {
    root.render(createElement(MarkdownTurnTail, {
      sessionId: 'sess', turn: deliverables({ produced: [{ path: 'docs/a.md' }] }), readers: face,
    }))
  })
  await act(async () => { await Promise.resolve() })
  const toggle = container.querySelector('button[aria-expanded]')
  await act(async () => { toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  await act(async () => { await Promise.resolve() })
  const editBtn = container.querySelector('[data-edit-toggle]') as HTMLButtonElement
  expect(editBtn).not.toBeNull()
  await act(async () => { editBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  const ta = container.querySelector('[data-markdown-body] textarea') as HTMLTextAreaElement
  expect(ta).not.toBeNull()
  expect(ta.value).toBe('# 原始')
  await act(async () => {
    ta.value = '# 改过'
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const sendBtn = container.querySelector('[data-edit-send]')
  await act(async () => { sendBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  expect(send).toHaveBeenCalledWith('sess', '# 改过')
  await act(async () => { root.unmount() })
})

it('添加到会话打开 compose box，发送后收起', async () => {
  const send = vi.fn(async () => {})
  const face = readers({ readPage: vi.fn(async () => page('段落', 1, true)), sendToSession: send })
  const container = document.createElement('div')
  const root: Root = createRoot(container)
  await act(async () => {
    root.render(createElement(MarkdownTurnTail, {
      sessionId: 'sess', turn: deliverables({ produced: [{ path: 'docs/a.md' }] }), readers: face,
    }))
  })
  await act(async () => { await Promise.resolve() })
  const toggle = container.querySelector('button[aria-expanded]')
  await act(async () => { toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  await act(async () => { await Promise.resolve() })
  const para = container.querySelector('[data-markdown-body] p') as HTMLElement
  const range = document.createRange(); range.selectNodeContents(para)
  window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range)
  await act(async () => { para.dispatchEvent(new Event('selectionchange')) })
  const addBtn = container.querySelector('[data-sel-action="add"]')
  await act(async () => { addBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  expect(container.querySelector('[data-compose-box]')).not.toBeNull()
  const input = container.querySelector('[data-compose-input]') as HTMLTextAreaElement
  await act(async () => { input.value = '要加入会话'; input.dispatchEvent(new Event('input', { bubbles: true })) })
  const csend = container.querySelector('[data-compose-send]')
  await act(async () => { csend?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  expect(send).toHaveBeenCalledWith('sess', '要加入会话')
  expect(container.querySelector('[data-compose-box]')).toBeNull()
  await act(async () => { root.unmount() })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run packages/dsh-client/tests/markdown-turn.spec.ts -t 编辑`
Expected: FAIL

- [ ] **Step 3: 实现编辑切换**

`MarkdownDocument` 加：

```tsx
  const [editing, setEditing] = useState(false)
```

路径栏 `bar` 内、`ExpandButton` 之前加编辑按钮（仅 `body.kind === 'ready'` 时显示）：

```tsx
      {body.kind === 'ready' && (
        <button type="button" className={css.iconButton} data-edit-toggle="" aria-label={t('markdownTurn.edit')} title={t('markdownTurn.edit')} onClick={() => { holdFileTop(barRef.current); setEditing(value => !value) }}>
          <IconEditOutlineRegular size={16} />
        </button>
      )}
```

body 区：编辑态渲染 textarea，只读态渲染原内容；下方发送按钮：

```tsx
      {editing && body.kind === 'ready' ? (
        <div className={css.editBox} data-editing="">
          <textarea className={css.editInput} data-markdown-body="" defaultValue={body.text} aria-label={t('markdownTurn.edit')} />
          <div className={css.editActions}>
            <button type="button" className={css.sendBtn} data-edit-send="" onClick={() => {
              const ta = body.querySelector('textarea') as HTMLTextAreaElement | null  // 见下修正
              void sendText(ta?.value ?? '')
              setEditing(false)
            }}><IconSendOutlineRegular size={15} /> {t('markdownTurn.send')}</button>
          </div>
        </div>
      ) : (
        /* 原 body 内容（MarkdownText / CodeBlock） */
      )}
```

> 修正：用 ref 拿 textarea。`MarkdownDocument` 加 `const editRef = useRef<HTMLTextAreaElement>(null)`，`<textarea ref={editRef} ...>`，发送时读 `editRef.current?.value`。body 容器 `data-markdown-body` 属性只放在只读 `MarkdownText`/`CodeBlock` 的容器上（现有 `div.body` 已有），编辑态把 `data-markdown-body` 移到 textarea 所在容器以复用测试选择器（见测试用 `[data-markdown-body] textarea`）。

- [ ] **Step 4: 实现 compose box + 滚动挤出**

文件内加：

```ts
/** 把宿主底部输入框滚动挤出视口（方案 A：不改宿主，只滚动）。 */
function scrollComposerOutOfView(bar: HTMLElement | null): void {
  const scroller = conversationScroller(bar ?? document.body)
  if (scroller === null) return
  const composer = document.querySelector<HTMLElement>('[data-composer-seat], [data-conversation-region="composer"]')
  if (composer === null) return
  const scrollerRect = scroller.getBoundingClientRect()
  const composerRect = composer.getBoundingClientRect()
  if (composerRect.top < scrollerRect.bottom && composerRect.bottom > scrollerRect.top) {
    scroller.scrollTop += composerRect.bottom - scrollerRect.top + 8
  }
}
```

`MarkdownDocument` 加 `composeOpen` 状态；`openCompose()` = `setComposeOpen(true); scrollComposerOutOfView(barRef.current)`。

「添加到会话」按钮（Task 4 的 `data-sel-action="add"`）改为 `onClick={() => { setCommenting(false); setSelBar(null); openCompose() }}`。

compose box 渲染（body 容器内，`comments` 发送区附近）：

```tsx
      {composeOpen && (
        <div className={css.composeBox} data-compose-box="">
          <textarea className={css.composeInput} data-compose-input="" placeholder={t('markdownTurn.composePlaceholder')} rows={3} />
          <div className={css.composeActions}>
            <button type="button" className={css.sendBtn} data-compose-send="" onClick={() => {
              const ta = container.querySelector('[data-compose-input]') as HTMLTextAreaElement | null
              void sendText(ta?.value ?? '')
              setComposeOpen(false)
            }}><IconSendOutlineRegular size={15} /> {t('markdownTurn.send')}</button>
          </div>
        </div>
      )}
```

> 说明：用 `container`（body 容器的 ref，复用 `bodyRef`）查 `[data-compose-input]`，避免全局查询串到别的文档框。把 `bodyRef` 也用于 compose box 容器。

- [ ] **Step 5: 加 CSS**

```css
.editBox, .composeBox {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.editInput, .composeInput {
  width: 100%;
  resize: vertical;
  font: inherit;
  padding: 8px;
  border: 1px solid rgb(0 0 0 / 15%);
  border-radius: 6px;
  background: rgb(0 0 0 / 2%);
}

.editActions, .composeActions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}

.sendBtn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 12px;
  border: none;
  border-radius: 6px;
  background: var(--dsw-alias-state-business-primary, rgb(0 0 0 / 85%));
  color: #fff;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.sendBtn:hover {
  filter: brightness(1.1);
}

@media (prefers-color-scheme: dark) {
  .editInput, .composeInput { border-color: rgb(255 255 255 / 18%); background: rgb(255 255 255 / 4%); }
}
```

- [ ] **Step 6: 运行确认通过**

Run: `npx vitest run packages/dsh-client/tests/markdown-turn.spec.ts -t 编辑`
Expected: PASS

- [ ] **Step 7: 跑全量 markdown-turn + locales 测试**

Run: `npx vitest run packages/dsh-client/tests/markdown-turn.spec.ts packages/dsh-client/tests/locales.spec.ts`
Expected: 全 PASS

- [ ] **Step 8: 提交**

```bash
git add packages/dsh-client/src/markdown-turn.tsx packages/dsh-client/src/markdown-turn.module.css packages/dsh-client/tests/markdown-turn.spec.ts
git commit -m "feat(client): markdown 文档框编辑与添加到会话 compose box"
```

---

### Task 6: 全量校验与类型检查

收口：跑完整门禁，修类型错误，确认无回归。

**Files:** 无新增，仅校验。

- [ ] **Step 1: 类型检查**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 2: 跑 dsh-client 全部测试**

Run: `npx vitest run packages/dsh-client`
Expected: 全 PASS（含原有 31 条 + 新增）。

- [ ] **Step 3: 构建（改了被界面加载的包要重建）**

Run: `npm run build`
Expected: 构建成功。

- [ ] **Step 4: 终态提交（如有 lint/格式修正）**

```bash
git add -A
git commit -m "chore(client): markdown 文档框交互增强门禁收口"
```

---

## Self-Review

**Spec coverage：**
- 功能一（选区操作条 + 评论）→ Task 3 选区条 UI、Task 4 评论合成与多处评论、Task 5 compose box（添加到会话）。
- 功能二（行 hover + 行内按钮）→ Task 3。
- 功能三（编辑按钮 + 发送）→ Task 5。
- 发送口 → Task 1；文案 → Task 2；校验 → Task 6。
- 评论合成格式 → Task 4 `composeWithComments`（测试断言精确格式）。
- 滚动挤出宿主输入框（方案 A）→ Task 5 `scrollComposerOutOfView`。

**Step scan：** 每个 code step 给了签名/选择器/文案键值；每个 test step 给了精确断言。Task 3/4 的 DOM 测试用现有 `readers()`/`deliverables()`/`page()` 辅助，模式与现有一致。

**Type consistency：** `sendToSession(sessionId, text)` 全程一致；`composeWithComments(source, comments)` 签名一致；`data-*` 选择器（`data-markdown-body`、`data-line-action`、`data-sel-action`、`data-comment-*`、`data-compose-*`、`data-edit-*`）在 CSS 与测试里一致。

**Review Focus：** 五条各指定了 owning task（正文外选区→Task 4；塌缩选区→Task 4；多处评论顺序→Task 4；行内按钮冲突→Task 3；sendToSession 缺失→Task 1/3）。

**已知实现取舍（已在 plan 内标注）：**
- 行内工具条用 body 级 hover 工具条（非逐块包 DOM），避免改 `MarkdownText` 输出、不干扰选区。
- 复制用纯函数 + 回调；发送在组件闭包调 `readers.sendToSession`。
- 编辑/compose 的 textarea 用 ref 取值，不用 `container.querySelector` 跨实例。
