# 侧栏交给原生、主机切换走整页网关 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 插件停止遮蔽 DSH 原生侧栏浏览区，侧栏顶部多一个主机图标，点开主区主机列表，在列表里挑一台即整页跳到那台机器，使每台机器都用自己的原生侧栏。

**Architecture:** 影子树（按优先级 -10 遮蔽 `sidebar.workspaces`）改为默认不注册，开关语义反转为 `threadharbor.sidebarTree=on` 才启用。主机入口是 `sidebar.panellist` 里一个图标，与配对图标并列（`order: 102`，排在 101 的配对图标下面）；主机列表同一份 `AgentPanel` 组件多注册一个 `main` 的 keyed 座位，点图标即 `selectPanel` 切过去；列表里每台主机的「打开」是到 `/threadharbor/gateway/<hostId>/` 的链接。网关在改写对方页面时注入一个「当前主机 + 回本机」入口（去重判据沿用主机图标上的 `data-host-switcher`），并对页面导航请求（`Accept: text/html`）回 HTML 错误页而不是裸文本。跨主机汇总树先只停用、后单独一次提交删除。

**Tech Stack:** TypeScript、React 18（浏览器半边）、vitest（node 与 jsdom 双环境）、DSH Cordis 插槽系统、Node `http`（宿主端转发）。

**Spec:** `docs/superpowers/specs/2026-10-20-sidebar-host-switch-design.md`

## Global Constraints

- 用户可见文案一律走 `packages/dsh-client/src/locales.ts` 的 `zh` 与 `en` 两段词典，`tests/ui-i18n.spec.ts` 会拒绝硬编码文案。主机图标沿用既有键 `panel.label`（'各主机' / 'Hosts'），上一版底部切换器的 `panel.switch.*` 六个键要一并删掉（zh 与 en 同步删，缺一个就红）。注释语言跟随所在文件既有语言，不统一改成英文。
- 命名空间常量是 `NAMESPACE = 'threadharborClient'`（见 `packages/dsh-client/src/locales.ts`）。
- 提交信息用中文，与仓库历史一致。
- 单文件测试命令：`npx vitest run <path>`；仓库根已有 vitest。
- `reference/deepseek-harness/` 是被忽略的只读检出，不得修改。
- 本机 DSH Web 测试实例（3081）只经 `~/bin/dsh-web-3081` 起停，不得手敲裸命令；别的端口必须显式指定独立的 `DSH_HOME`。
- 影子树注册**不得**声明任何子插槽：`ui-slots` 对子插槽是先到先得，重复声明会抛 `slot "X" is already declared`，而原生那份注册必定发生（`packages/dsh-client/src/sidebar-tree.ts` 现在不声明，保持这一点）。
- 面板图标行的 **id 必须与主区 keyed 座位的 key 同名**：面板行的点击就是 `selectPanel(id)`（`reference/deepseek-harness/packages/client/ui-sidebar/src/client/SidebarRoot.tsx:68`）。
- 面板图标的 `order` **数字越大越靠下**（`PANEL_ORDER = 100` 的注释写着「above 100 sits below DSH's own rows」，`PAIRING_PANEL_ORDER = 101`）。主机图标要排在配对图标下面，用 102。
- `selectPanel` 在目标键未注册时**抛错**（`reference/deepseek-harness/packages/client/ui-layout/src/client/service.ts:72-75`）。调用处必须兜住，不能让异常掀翻整页。
- 若本任务需要新的状态容器，照抄 `packages/dsh-client/src/remote-session-store.ts` 的手写 `createXStore()` 形状（`set`/`get`/`subscribe`），不用 zustand。
- Node 版本 `^22.19.0 || >=24.0.0`。

## Review Focus

以下五类是规格没写、但真实使用中最可能咬人的输入。每条在所属任务里有对应测试。

1. **冷启动时点主机图标。** 主区 keyed 座位与面板图标行都经 `inject` 等座位就位，两者不一定同时到位；`selectPanel` 遇到未注册的键会抛错。那一下不能掀翻整页，也不能静默无反应。
2. **主机图标与配对图标的上下顺序。** `order` 数字越大越靠下，102 要落在 101 的配对图标**下面**；写反了不会报错，只会让图标跑到上面去。
3. **对方机器没装插件。** 那种页面上没有主机图标，唯一的出路是网关注入的那条；去重判据是「页面上存在 `data-host-switcher`」，对方真没装时不能误判成已装而把注入的出口也撤掉。
4. **窄侧栏下主机图标只有图标、没有文字。** 文字走 tooltip，tooltip 文本必须是「各主机」，不能是空白或原始键名。
5. **列表里那台没部署的主机。** 它不能有「打开」（没有地址就没有可导航的路径），给的是「部署」——这是面板的既有行为，本次改动不能破坏它。

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

### Task 2: 侧栏顶部主机图标 + 主机列表挂进主区

> 这一批替换掉上一版「侧栏底部分体切换器」那套（已实现于提交 `d456096`/`eabe8f5`）。形态由用户拍板改为顶部图标 + 主区主机列表，见规格「修订」一节。

**Files:**
- Create: `packages/dsh-client/src/host-icon.tsx`（面板图标行的图标）
- Delete: `packages/dsh-client/src/host-switcher.tsx`、`host-switcher-store.ts`、`host-switcher.module.css`、`packages/dsh-client/tests/host-switcher.spec.ts`
- Modify: `packages/dsh-client/src/client/index.ts`（`registerPanelSlots` 扩成三个座位；摘掉 `sidebar.footer.action` 的注册）
- Modify: `packages/dsh-client/src/locales.ts`（删掉 `panel.switch.*` 六个键的 zh 与 en）
- Test: `packages/dsh-client/tests/host-icon.spec.ts`

**Interfaces:**
- Consumes:
  - `AgentPanel` 与 `AgentPanelBusinessProps`（`packages/dsh-client/src/client/index.ts:221-231` 里 `registerPanelSlots` 已经在用，它们是设置分区那个座位的主体）
  - `PANEL_ID = 'threadharbor-rollup'`（`client/index.ts:163`）——主机图标行的 id 与主区 keyed 座位的 key 用它
  - `ctx.get('layout')`（布局服务，暴露 `selectPanel(panelId: MainPanelId | null): void`；`reference/deepseek-harness/packages/client/ui-layout/src/client/service.ts:36`）
  - 注册模板：`packages/dsh-client/src/pairing-panel.ts:169-177`（面板图标行）与 `:169-171`（`main` keyed 座位）
  - `NAMESPACE`、`RuntimeT`、`panel.label`（'各主机' / 'Hosts'，`locales.ts:34` 与 `:448`）
- Produces:
  - `export const HOST_ICON_PANEL_ORDER = 102`（排在 `PAIRING_PANEL_ORDER = 101` 下面）
  - `export function HostIcon(props: { readonly t?: RuntimeT }): JSX.Element`——图标根元素带 `data-host-switcher`
  - 三个座位同由 `registerPanelSlots` 注册：`settings.section`（既有）、`sidebar.panellist`（新增，id = `PANEL_ID`，order = `HOST_ICON_PANEL_ORDER`，label = `() => t('panel.label')`）、`main`（新增，key = `PANEL_ID`，`inject: () => face`）

- [ ] **Step 1: 写注册与图标的失败测试**

新建 `packages/dsh-client/tests/host-icon.spec.ts`。挂载用的壳子照抄 `packages/dsh-client/tests/panel-mount.spec.ts` 与 `handover-mount.spec.ts` 里那套真 `SlotCore` 挂载（上一版为此补过 `sidebar.footer.action` 的声明）。

用例：

```ts
it('主机图标进面板图标区，id 与主区座位同名，排在配对图标下面', () => { ... })
it('图标根元素带 data-host-switcher（网关注入入口的去重判据）', () => { ... })
it('面板图标行的标签是词典里的「各主机」，不是空串也不是原始键名', () => { ... })
it('主区座位已注册时，点图标切到主机列表面板', () => { ... })
it('主区座位还没注册时，点图标不抛错，也要有交代', () => { ... })
it('主机列表里没有打开地址的那台，给的是「部署」而不是「打开」', () => { ... })
```

第三条与第四条用一个会记调用的假布局服务（`{ selectPanel(id) { calls.push(id) } }`）驱动；第四条让假服务抛错，断言异常没有掀翻渲染，且界面给出了可读的交代。第六条是回归钉子：主机列表通过新的主区座位挂出来之后，那台没部署的主机仍然只给「部署」。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/dsh-client/tests/host-icon.spec.ts`
Expected: FAIL，`host-icon.tsx` 尚不存在。

- [ ] **Step 3: 实现图标组件**

`host-icon.tsx`：一个面板图标（宽侧栏下 16px、窄轨 18px——尺寸由 `sidebar.panellist` 的 owner props 给，形状照 `pairing-panel.ts` 的 `PairingIcon`），根元素带 `data-host-switcher`。点击行为：读 `ctx.get('layout')`，调 `selectPanel(PANEL_ID)`；抛错时兜住并在图标旁给一句可读交代（走词典，不硬编码）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/dsh-client/tests/host-icon.spec.ts`
Expected: PASS。

- [ ] **Step 5: 扩 `registerPanelSlots` 成三个座位**

在 `client/index.ts:221-231` 的 `registerPanelSlots` 里，除了既有的 `settings.section`，再加两处 `inject`：`sidebar.panellist`（`{ name: 'sidebar.panellist', id: PANEL_ID, order: HOST_ICON_PANEL_ORDER, label, locale: NAMESPACE }`）与 `main`（`{ name: 'main', key: PANEL_ID, locale: NAMESPACE, inject: () => face }`）。三处都用 `inject` 等座位就位，不要直接 `register`。

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run packages/dsh-client/tests/host-icon.spec.ts packages/dsh-client/tests/panel-mount.spec.ts packages/dsh-client/tests/handover-mount.spec.ts`
Expected: PASS（后两个是真 `SlotCore` 挂载，主区多一个 keyed 座位不该影响它们）。

- [ ] **Step 7: 摘掉底部切换器**

删掉四个文件（`host-switcher.tsx`、`host-switcher-store.ts`、`host-switcher.module.css`、`tests/host-switcher.spec.ts`），删掉 `client/index.ts` 里 `sidebar.footer.action` 那段注册（连同它的 import 与 store 接线），并把 `locales.ts` 里 `panel.switch.*` 六个键的 zh 与 en 一并删掉。改完先查一遍引用，确认没有别处还在用：`grep -rn "host-switcher\|panel.switch\." packages/ --include="*.ts" --include="*.tsx" | grep -v node_modules` 应当没有命中。

另外检查 `panel-mount.spec.ts` 与 `handover-mount.spec.ts` 里为上一版补的 `sidebar.footer.action` 槽声明：没有任何东西再注册进那个槽了，把那两行删掉（留着也无害，但那是上一版的遗留）。

- [ ] **Step 8: 跑本包全量测试**

Run: `npx vitest run packages/dsh-client/tests`
Expected: PASS，含 `ui-i18n.spec.ts`（zh 与 en 同步删过）与 `runtime-locale.spec.ts`。

- [ ] **Step 9: 提交**

```bash
git add -A packages/dsh-client
git commit -m "侧栏：主机入口改为顶部图标，主机列表同组件挂进主区"
```


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

再确认主机入口：**侧栏顶部面板图标区**里有一个主机图标，排在配对图标**下面**（Review Focus 2），宽侧栏下点它右侧主区打开主机列表；窄侧栏（56px）下它只剩一个图标，悬停有「各主机」的提示（Review Focus 4），点它同样能打开主机列表。

- [ ] **Step 3: 起第二台实例**

另起一台，显式指定独立的 `DSH_HOME` 与端口；在第一台的「设置 → 各主机」里登记它并填打开地址。

- [ ] **Step 4: 切换与回程**

在第一台点顶部主机图标 → 主区主机列表 → 点第二台的「打开」，确认整页进入第二台、侧栏是第二台自己的原生树；第二台自己的侧栏顶部也应当有主机图标（每台都装了插件，Review Focus 3）；开一段对话、发消息、触发一次审批并批准，确认流式与审批都正常；点网关注入的「回本机」回到第一台。

另外确认列表里那台**没部署**的主机（先别填打开地址）：它那行给的是「部署」，不是「打开」（Review Focus 5）。

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
