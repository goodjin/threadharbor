# 侧栏交给原生、主机切换走整页网关 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 插件停止遮蔽 DSH 原生侧栏浏览区，改由侧栏底部的主机切换器整页跳转到目标机器，使每台机器都用自己的原生侧栏。

**Architecture:** 影子树（按优先级 -10 遮蔽 `sidebar.workspaces`）改为默认不注册，开关语义反转为 `threadharbor.sidebarTree=on` 才启用。主机切换器注册进 `sidebar.footer.action`，点某台主机即 `location.assign` 到 `gatewayPagePath(hostId)`；网关在改写对方页面时注入一个「当前主机 + 回本机」入口，并对页面导航请求（`Accept: text/html`）回 HTML 错误页而不是裸文本。跨主机汇总树先只停用、后单独一次提交删除。

**Tech Stack:** TypeScript、React 18（浏览器半边）、vitest（node 与 jsdom 双环境）、DSH Cordis 插槽系统、Node `http`（宿主端转发）。

**Spec:** `docs/superpowers/specs/2026-10-20-sidebar-host-switch-design.md`

## Global Constraints

- 用户可见文案一律走 `packages/dsh-client/src/locales.ts` 的 `zh` 与 `en` 两段词典，键名前缀 `panel.switch.`；`tests/ui-i18n.spec.ts` 会拒绝硬编码文案。源码注释用英文。
- 命名空间常量是 `NAMESPACE = 'threadharborClient'`（见 `packages/dsh-client/src/locales.ts`）。
- 提交信息用中文，与仓库历史一致。
- 单文件测试命令：`npx vitest run <path>`；仓库根已有 vitest。
- `reference/deepseek-harness/` 是被忽略的只读检出，不得修改。
- 本机 DSH Web 测试实例（3081）只经 `~/bin/dsh-web-3081` 起停，不得手敲裸命令；别的端口必须显式指定独立的 `DSH_HOME`。
- 影子树注册**不得**声明任何子插槽：`ui-slots` 对子插槽是先到先得，重复声明会抛 `slot "X" is already declared`，而原生那份注册必定发生（`packages/dsh-client/src/sidebar-tree.ts` 现在不声明，保持这一点）。
- 浏览器半边的状态容器照抄 `packages/dsh-client/src/remote-session-store.ts` 的手写 `createXStore()` 形状（`set`/`get`/`subscribe`），不用 zustand。
- Node 版本 `^22.19.0 || >=24.0.0`。

## Review Focus

以下五类是规格没写、但真实使用中最可能咬人的输入。每条在所属任务里有对应测试。

1. **侧栏收窄成 56px 轨时切换器仍在。** `SidebarRoot` 在两种宽度下都渲染 `sidebar.footer.action`，只多传一个 `wide`。切换器必须跟着 `wide` 变形态，不能把窄轨撑破，也不能在窄轨下留一个点不动的死按钮。
2. **对方机器自己也装了本插件。** 于是远端页面上同时出现网关注入的「回本机」入口和插件自己的切换器。两者的去向必须一致，不允许出现两个语义打架的入口（网关注入的入口在插件选择器存在时应让位或被抑制）。
3. **地址栏被手工编辑或浏览器后退到未登记主机的网关路径。** 此时必须有可读的错误页，且同时给出「回本机」和「去设置」两个出口，不是白屏也不是裸文本。
4. **切主机时当前机器上正在跑回合。** 导航离开页面不等于停掉会话（会话跑在那台机器上），但入口处必须能看出这一点，不能让人以为回合被中断。
5. **登记簿里有主机但没有打开地址。** 这种主机不可点（没有可导航的路径），但要在列表里出现并说明原因，不能静默消失。

---

### Task 1: 影子树默认不注册

**Files:**
- Modify: `packages/dsh-client/src/sidebar-tree.ts:30-81`（开关语义）
- Modify: `packages/dsh-client/src/client/index.ts:413-416`（调用点上方那段注释）
- Test: `packages/dsh-client/tests/sidebar-tree.spec.ts:54-74`

**Interfaces:**
- Consumes: 无
- Produces: `TREE_STORAGE_KEY`（已有，值不变）；`maybeRegisterSidebarTree(slots, ctx, registry)` 行为改为「仅当 `localStorage[TREE_STORAGE_KEY] === 'on'` 才注册」。

- [ ] **Step 1: 把开关测试改成新语义**

在 `tests/sidebar-tree.spec.ts` 的 `describe('maybeRegisterSidebarTree（遮蔽注册与开关）')` 里，把前两个用例替换为：

```ts
it('默认不注册：原生浏览区照常', () => {
  const slots = makeSlots()
  maybeRegisterSidebarTree(slots, { get: () => undefined })
  expect(slots.registered).toEqual([])
})

it('开关 on：以更低优先级数值与 locale 声明注册 sidebar.workspaces', () => {
  localStorage.setItem(TREE_STORAGE_KEY, 'on')
  const slots = makeSlots()
  maybeRegisterSidebarTree(slots, { get: () => undefined })
  expect(slots.registered).toEqual([{ name: 'sidebar.workspaces', priority: -10, locale: 'threadharborClient' }])
})
```

第三个用例（同槽位重复注册静默跳过）保留，但要在前面加 `localStorage.setItem(TREE_STORAGE_KEY, 'on')`，否则它会在「默认不注册」分支里空过。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/dsh-client/tests/sidebar-tree.spec.ts`
Expected: FAIL，「默认不注册」用例实际注册了一次。

- [ ] **Step 3: 改开关语义**

在 `sidebar-tree.ts` 的 `maybeRegisterSidebarTree` 里，把读开关那段改成「只有显式 `'on'` 才启用」，并把该函数上方的 JSDoc 改成描述新语义（默认让位、开关是回到旧行为的实验位）。注册逻辑、优先级 `-10`、locale 传参一律不动。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/dsh-client/tests/sidebar-tree.spec.ts`
Expected: PASS。

- [ ] **Step 5: 改调用点注释**

`client/index.ts:413-415` 那段中文注释现在写的是「遮蔽原生工作区列表」与「开关=off 时跳过注册」，改成描述默认不注册、`=on` 才遮蔽；并在注释里点明 `registerRemoteConversation`（下一段）此时没有入口、留给 Task 6 删除。

- [ ] **Step 6: 提交**

```bash
git add packages/dsh-client/src/sidebar-tree.ts packages/dsh-client/src/client/index.ts packages/dsh-client/tests/sidebar-tree.spec.ts
git commit -m "侧栏：影子树默认不注册，开关反转为 =on 才遮蔽原生"
```

---

### Task 2: 主机切换器

**Files:**
- Create: `packages/dsh-client/src/host-switcher.tsx`
- Create: `packages/dsh-client/src/host-switcher-store.ts`
- Create: `packages/dsh-client/src/host-switcher.module.css`
- Modify: `packages/dsh-client/src/client/index.ts`（注册 `sidebar.footer.action`）
- Modify: `packages/dsh-client/src/locales.ts`（`zh` 与 `en` 各加一组 `panel.switch.*`）
- Test: `packages/dsh-client/tests/host-switcher.spec.ts`

**Interfaces:**
- Consumes: `HostListRow`（`packages/dsh-client/src/panel.tsx:245`，字段 `hostId`/`name`/`self`/`online`/`connection`/`address?`/`launchUrl?`）；`mergeHostRows(hosts, registrations)`（`panel.tsx:402`，后两个参数可选）；`HostRegistration`（`hostId`/`hostTitle`/`address`/`launchUrl?`，来自 `@threadharbor/dsh-host-federation`）；`gatewayPagePath(hostId)`（`packages/dsh-host-federation/src/index.ts:62` 转出）；`RuntimeT`/`NAMESPACE`/`fallbackT`（`locales.ts`）；`HostStatus`（`packages/dsh-client/src/host-state.ts:33`）。
- Produces:
  - `export type SwitchEntry = { readonly hostId: string; readonly label: string; readonly self: boolean; readonly online: boolean; readonly launchable: boolean; readonly status: HostStatus; readonly path: string }`，其中 `path` 对本机为 `''`，对远端是 `gatewayPagePath(hostId)`。
  - `export function switchEntries(rows: readonly HostListRow[], registrations: readonly HostRegistration[]): readonly SwitchEntry[]`——纯函数，本机排第一，其余按 `rows` 原序；`launchable = self || (registration?.launchUrl 非空)`。
  - `export function createHostSwitcherStore(): { entries(): readonly SwitchEntry[]; set(next: readonly SwitchEntry[]): void; subscribe(l: () => void): () => void }`，形状照抄 `remote-session-store.ts`。
  - 注册：`slots.inject('sidebar.footer.action', () => slots.register({ name: 'sidebar.footer.action', id: 'host-switcher', locale: NAMESPACE }, HostSwitcher))`，组件 props 是该槽的 owner props `{ readonly wide: boolean }`。

- [ ] **Step 1: 写纯函数测试**

`tests/host-switcher.spec.ts` 顶部加 `@vitest-environment jsdom`（渲染用例需要），先只测纯函数：

```ts
it('本机排第一且不可跨机跳转：path 为空', () => { ... })
it('没有打开地址的登记主机 launchable 为 false，仍出现在列表里', () => { ... })
it('有打开地址的主机 path 是 gatewayPagePath(hostId)', () => { ... })
```

数据用 `makeRegistry()`（照抄 `sidebar-tree.spec.ts:27`）造真登记簿，`mergeHostRows` 造行。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/dsh-client/tests/host-switcher.spec.ts`
Expected: FAIL，`switchEntries` 尚未导出。

- [ ] **Step 3: 实现 `switchEntries` 与 store**

在 `host-switcher-store.ts` 放 store；在 `host-switcher.tsx` 放类型与纯函数。组件本任务先不写。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/dsh-client/tests/host-switcher.spec.ts`
Expected: 三个纯函数用例 PASS。

- [ ] **Step 5: 写组件渲染测试**

用 `createRoot` + `act` 渲染 `HostSwitcher({ wide: true })`，断言：
- 收起状态下按钮读出的是当前主机名（`panel.switch.current`，文案「本机」起）；
- 展开后每个 `SwitchEntry` 有一行，标签取 `entry.label`；
- `launchable` 为 false 的行 `aria-disabled="true"` 且点击不导航（Review Focus 5）；
- `wide: false` 时只渲染一个图标按钮，不渲染展开列表（Review Focus 1）；
- 点击任一可用项后，除了 `window.location.assign` 之外没有任何别的调用——用一个会记录调用的假 `assign` 断言没有触发停止/归档/分叉一类动作（Review Focus 4）。

- [ ] **Step 6: 跑测试确认失败**

Run: `npx vitest run packages/dsh-client/tests/host-switcher.spec.ts`
Expected: FAIL，`HostSwitcher` 尚未导出。

- [ ] **Step 7: 实现组件与样式**

`HostSwitcher` 从 store 读 `entries()`，用 `useSyncExternalStore` 订阅（这是插件内已有的读法；若 `remote-session-poll.ts` 之外没有先例，就照该 store 的 `subscribe` 契约写一个本地 `useEffect` 订阅）。点击可用的远端项时 `window.location.assign(entry.path)`；点击本机项时 `window.location.assign('/')`。点击不可用项不导航。

- [ ] **Step 8: 跑测试确认通过**

Run: `npx vitest run packages/dsh-client/tests/host-switcher.spec.ts`
Expected: PASS。

- [ ] **Step 9: 加文案**

`locales.ts` 的 `zh` 与 `en` 各加：`panel.switch.label`（切换主机 / Switch host）、`panel.switch.current`（本机 / This machine）、`panel.switch.offline`（离线 / Offline）、`panel.switch.unreachable`（未部署 / Not deployed）、`panel.switch.noLaunchUrl`（没有打开地址，请到 设置 → 各主机 补上 / No open address — add it under Settings → Hosts）、`panel.switch.open`（在这台主机上打开 / Open on this host）。

- [ ] **Step 10: 注册并接线**

在 `client/index.ts` 里，紧接 `maybeRegisterSidebarTree(...)` 之后注册 `sidebar.footer.action`。数据刷新复用已有的 `hostStore.subscribe` 与 `section.hosts()`：每次变化时 `set(switchEntries(mergeHostRows(section.hosts(), registry.list()), registry.list()))`。整段放进 `ctx.effect` 以便卸载时清理。

- [ ] **Step 11: 跑本包全量测试**

Run: `npx vitest run packages/dsh-client/tests`
Expected: PASS，含新增的 `ui-i18n.spec.ts`（文案都走了词典）与 `runtime-locale.spec.ts`。

- [ ] **Step 12: 提交**

```bash
git add packages/dsh-client/src/host-switcher.tsx packages/dsh-client/src/host-switcher-store.ts packages/dsh-client/src/host-switcher.module.css packages/dsh-client/src/client/index.ts packages/dsh-client/src/locales.ts packages/dsh-client/tests/host-switcher.spec.ts
git commit -m "侧栏：底部主机切换器，点击整页跳到目标主机"
```

---

### Task 3: 网关注入回本机入口

**Files:**
- Modify: `packages/dsh-host-federation/src/host-gateway-path.ts:183-219`（`rewriteHtml`、`rewriteBody`、`gatewayClientScript` 增参数）
- Modify: `packages/dsh-host-federation/src/host-gateway.ts`（调用处传标题）
- Test: `packages/dsh-host-federation/tests/host-gateway.spec.ts`

**Interfaces:**
- Consumes: `LaunchTarget`（`host-gateway-path.ts:30`，`ok` 为真时含 `origin`/`token`，需在同处补 `hostTitle`）
- Produces:
  - `gatewayClientScript(hostId: string, hostTitle: string): string`（多一个必填参数）
  - `rewriteHtml(html: string, hostId: string, hostTitle: string): string`
  - `rewriteBody(kind: RewriteKind, body: string, hostId: string, hostTitle: string): string`
  - 注入 DOM 的选择器约定：元素 id `th-host-bar`，其内「回本机」链接 id `th-back-home`。

**注意：不要为远端建任何目录浏览接口。** 规格决策 5 说的「与本机一致」，在本设计下由「那台机器用自己的原生选择器」自然满足——网关本来就是把登记主机的整条接口按路径转发，目录相关调用已经在转发范围内。本任务只注入入口，不新增 op、不加白名单。

- [ ] **Step 1: 写失败测试**

在 `host-gateway.spec.ts` 的「页面被改写到网关前缀」用例之后加一条：

```ts
it('注入脚本带上当前主机名与回本机入口', () => {
  const html = rewriteHtml('<html><head></head><body>REMOTE</body></html>', 'mini', '小机器')
  expect(html).toContain('小机器')
  expect(gatewayClientScript('mini', '小机器')).toContain('th-host-bar')
  expect(gatewayClientScript('mini', '小机器')).toContain('th-back-home')
  expect(() => { new Function(gatewayClientScript('mini', '小机器')) }).not.toThrow()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/dsh-host-federation/tests/host-gateway.spec.ts`
Expected: FAIL，参数个数不匹配。

- [ ] **Step 3: 改签名并传标题**

`resolveLaunch` 成功分支带上登记簿条目的 `hostTitle`；`rewriteHtml` 把标题透给 `gatewayClientScript`。

- [ ] **Step 4: 注入入口 DOM**

在 `gatewayClientScript` 追加一段：DOM 就绪后在页面顶部插入一个 `id="th-host-bar"` 的条，内含主机名文本与一个指向本机根路径的链接（`href="/"`，id `th-back-home`）。样式写进注入脚本的内联样式，不依赖对方样式表。链接上挂一个委托监听，点击时若页面上已存在插件自己的切换器（以 Task 2 的选择器为标记）则不重复插条（Review Focus 2）——具体判据用「页面上是否已有 `[data-host-switcher]`」。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run packages/dsh-host-federation/tests/host-gateway.spec.ts`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add packages/dsh-host-federation/src/host-gateway-path.ts packages/dsh-host-federation/src/host-gateway.ts packages/dsh-host-federation/tests/host-gateway.spec.ts
git commit -m "网关：改写对方页面时注入当前主机名与回本机入口"
```

---

### Task 4: 页面导航的错误页

**Files:**
- Modify: `packages/dsh-host-federation/src/host-gateway.ts:424-428`（`text` 助手）
- Test: `packages/dsh-host-federation/tests/host-gateway.spec.ts`

**Interfaces:**
- Consumes: 现有的失败分支措辞——路径不合法、未登记主机、令牌失效（`host-gateway-path.ts:61,80,101`；`host-gateway.ts:146,172,176`）
- Produces: `gatewayErrorPage(message: string, t: { back: string; settings: string }): string`（新导出，供 `text` 使用）；`text()` 在 `Accept` 含 `text/html` 时以它为正文，否则维持现有纯文本。

- [ ] **Step 1: 写失败测试**

加一条：带 `Accept: text/html` 请求一个未登记主机的网关路径，断言响应 `content-type` 是 `text/html`、正文含原文案与两个出口（回本机、去设置）；同一路径不带该头时仍是 `text/plain`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/dsh-host-federation/tests/host-gateway.spec.ts`
Expected: FAIL，正文仍是纯文本。

- [ ] **Step 3: 实现内容协商**

`text()` 先看 `res.req.headers.accept`；含 `text/html` 时改用 `gatewayErrorPage`，`content-type` 改成 `text/html; charset=utf-8`。错误页自带内联样式与两个链接：「回本机」指向 `/`，「去设置」指向本机根路径下插件的设置入口（用 `/` 即可，设置入口在页面内）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/dsh-host-federation/tests/host-gateway.spec.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/dsh-host-federation/src/host-gateway.ts packages/dsh-host-federation/tests/host-gateway.spec.ts
git commit -m "网关：页面导航的失败回错误页，不再甩裸文本"
```

---

### Task 5: 真机两台验收

**Files:** 无代码改动；只在 `docs/superpowers/specs/2026-10-20-sidebar-host-switch-design.md` 的「可行性验证」一节把结论从「高度可能成立」改成实测结果。

- [ ] **Step 1: 起本机测试实例**

Run: `~/bin/dsh-web-3081`
Expected: 打印访问地址。

- [ ] **Step 2: 侧栏回归检查**

打开该地址，确认：顶栏有「添加工作区」入口（插件不再遮蔽）；会话行悬停出现归档与置顶按钮；定时任务的时钟标记若该机有定时任务则出现。

- [ ] **Step 3: 起第二台实例**

另起一台，显式指定独立的 `DSH_HOME` 与端口；在第一台的「设置 → 各主机」里登记它并填打开地址。

- [ ] **Step 4: 切换与回程**

在第一台点切换器里的第二台，确认整页进入第二台、侧栏是第二台自己的原生树；开一段对话、发消息、触发一次审批并批准，确认流式与审批都正常；点网关注入的「回本机」回到第一台。

- [ ] **Step 5: 失败路径**

把第二台的打开地址改成一个无效值再切过去，确认得到的是错误页而不是裸文本，且两个出口都在（Review Focus 3）。

- [ ] **Step 6: 把结论写回规格文档并提交**

```bash
git add docs/superpowers/specs/2026-10-20-sidebar-host-switch-design.md
git commit -m "文档：记录两台实例的整页切换实测结果"
```

---

### Task 6: 退役跨主机汇总树

**前置：Task 5 通过且用户在真机确认无回归后放行。** 这一批是删除，不可逆。

**Files:**
- Delete: `packages/dsh-client/src/sidebar-tree.ts`、`host-session-tree.tsx`、`host-session-tree.module.css`、`remote-tree-actions.ts`、`host-roll-up.ts`、`remote-session-poll.ts`、`remote-session-store.ts`、`session-source.ts`、`session-actions.ts`、`remote-conversation.tsx`、`remote-conversation-store.ts`、`remote-conversation.module.css`
- Delete 对应测试：`tests/sidebar-tree.spec.ts`、`host-session-tree.spec.ts`、`session-source.spec.ts`、`session-actions.spec.ts`、`host-roll-up.spec.ts`、`remote-session-poll.spec.ts`、`remote-conversation.spec.ts`
- Modify: `packages/dsh-client/src/client/index.ts`（摘掉 `maybeRegisterSidebarTree` 与 `registerRemoteConversation` 两处注册及其 import）
- Modify: `packages/dsh-client/src/locales.ts`（删掉 `panel.tree.*` 与远端会话相关键，zh 与 en 同步）

**Interfaces:**
- Consumes: 无
- Produces: 无（净删除）

- [ ] **Step 1: 重新查引用**

Run: `grep -rn "sidebar-tree\|host-session-tree\|remote-tree-actions\|host-roll-up\|remote-session-poll\|remote-session-store\|session-source\|session-actions\|remote-conversation" packages/ --include="*.ts" --include="*.tsx" | grep -v node_modules`
Expected: 只剩 `client/index.ts`、`locales.ts` 与各自的测试文件。若出现计划外的引用者，停下来报告，不要自行扩大删除范围。

- [ ] **Step 2: 摘掉两处注册**

在 `client/index.ts` 删掉 `maybeRegisterSidebarTree(...)` 调用、`ctx.effect(() => registerRemoteConversation(...))` 整段，以及对应 import 与相关注释。

- [ ] **Step 3: 删文件与文案**

删除上列文件与测试；`locales.ts` 里整组删掉 `panel.tree.*`（zh 与 en 必须同步删，否则 `ui-i18n.spec.ts` 会失败），其余键先留着，跑测试看有没有孤儿引用再删。

- [ ] **Step 4: 跑全量测试**

Run: `npx vitest run`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add -A packages/dsh-client
git commit -m "侧栏：删除跨主机汇总树与远端动作代理"
```

---

### Task 7: 文档更新

**Files:**
- Modify: `README.md`（「当前能力」里那条多主机描述）
- Modify: `docs/mobile-client.zh.md`（若提到侧栏的主机树）
- Modify: `docs/architecture.zh.md`（若提到浏览区被插件替换）

**Interfaces:**
- Consumes: 无
- Produces: 无

- [ ] **Step 1: 改 README 的能力描述**

把「同一窗口管理多台主机」那条改成：侧栏是 DSH 原生的工作区树；侧栏底部的主机切换器整页跳到目标主机，那台机器用自己的原生侧栏与界面。

- [ ] **Step 2: 扫其余文档**

Run: `grep -rn "左侧树\|主机树\|遮蔽\|shadow" README.md docs/`
Expected: 命中处逐个核对，只改确实描述旧行为的段落。

- [ ] **Step 3: 提交**

```bash
git add README.md docs/
git commit -m "文档：侧栏回到原生，多主机改为整页切换"
```
