# 主机切换器（侧栏常驻）实现计划

> 目标：在侧栏底部放一个常驻的主机切换器，下拉列出所有主机，选一台就切到那台主机的界面（走 host-gateway 代理）。下拉里放「+ 添加主机」项，点了进现有的 SSH 部署添加流程。
>
> 核对时间：2026-11-02
> 前提：threadharbor 后端（ssh-deploy / host-gateway / host-store / federation-sync）已完整，本次只动浏览器 UI。

## 一、现状（不动的资产）

- **后端 SSH 部署**：默认 `installPluginsFromGithub: true`，SSH 过去跑 `dsh plugin add github:...` 从 GitHub 装 DSH+插件，**不复制本机任何内容**。用户要的「只复制程序和配置、不复制项目会话」天然满足（默认压根不复制）。只有关掉 GitHub 安装时才上传本地 release tarball（也是发行包，不含项目/会话）。
- **隧道**：`ssh -L` 转发对方回环端口，对方只听 `127.0.0.1`。
- **网关**：`host-gateway` 同源反向代理。`gatewayPagePath(hostId)` 返回 `/threadharbor/gateway/<hostId>/`，整页 navigate 过去后目标主机跑自己的原生侧栏。
- **主机登记簿**：`host-store`，`registry.list()` 返回 `HostRegistration[]`。
- **现有「各主机」面板**：`panel.tsx`（3000 行），list/detail/add(chooser/ssh/manual) 视图，`enterHost(row)` 已有「有 launchUrl 就 navigate(gatewayPagePath)，否则进详情页」的逻辑。

## 二、槽位依据

DSH 侧栏实际渲染的槽（从 `dsh-client-ui-sidebar/lib/client.js` 与 `.d.ts` 契约确认）：

| 槽名 | kind | 用途 |
|---|---|---|
| `sidebar.brand.mark/name` | single | 顶部品牌区 |
| `sidebar.panellist` | list | 面板图标行（threadharbor 已用，挂「各主机」） |
| `sidebar.workspaces` | list | 工作区浏览器（ui-workspace 占） |
| `sidebar.settings` | single | 设置入口（ui-settings 占） |
| **`sidebar.footer.action`** | **list** | **侧栏底部、Settings 旁边的动作区 ← 切换器放这** |
| `sidebar.toggle.badge` | single | 折叠按钮上的徽标 |

`sidebar.footer.action` 契约（`slots.d.ts:76`）：
```ts
'sidebar.footer.action': { kind: 'list'; scope: 'root'; owner: SidebarFooterActionOwnerProps }
```
每个 action 收到 `SidebarFooterActionOwnerProps = { wide: boolean }`（侧栏展开/收起）。注册方式同 `sidebar.panellist`：`slots.inject('sidebar.footer.action', () => slots.register({...}, Component))`。

## 三、实现

### 0. 关键发现：已有 `#th-host-bar`（远程页面顶部的切换器）

`host-gateway-path.ts` 的 `gatewayClientScript` 已经往**远程页面**（gateway 代理的目标主机界面）注入了一个 `#th-host-bar`：一个 `<select>` 下拉，列出「当前主机（当前）/ 本机 / 所有 peers」，`change` 时 `location.assign` 切换。还有 `#th-back-home` 链接回本机。

但那是**远程页面**的切换器（远程页面跑的是目标主机的 DSH，本机侧栏在那边不显示）。**本机访问自己时，侧栏底部没有常驻切换器**——这正是用户要补的。

两个切换器互补：远程页面顶部用 `#th-host-bar`（已存在），本机侧栏底部用新的 `sidebar.footer.action` 切换器（本次做）。切换逻辑一致：`navigate` 到 `gatewayPagePath(hostId)`（远程）或 `/`（本机）。

`host-icon.tsx` 的注释已说明：`data-host-switcher` 标记让 `#th-host-bar` 在远程页面检测到自家图标时让位（不重复渲染）。本机侧栏切换器也带这个标记，保持一致。

### 1. 新组件 `src/host-switcher.tsx`

一个 footer action 组件（注册到 `sidebar.footer.action`）：
- 折叠态（`wide === false`）：只显示主机图标（复用 `host-icon.tsx` 的 svg），点开弹下拉。
- 展开态（`wide === true`）：显示当前主机名 + 下拉箭头，点开弹下拉。
- 下拉内容：
  - 本机那台（`row.self`）排第一，标「本机」。
  - 其余按登记顺序，显示 `name`（注册名，无则 hostId）。
  - 分隔线。
  - 「+ 添加主机」项。
- 选中一台主机：`navigate(gatewayPagePath(hostId))`（本机则 `/`）。复用 `#th-host-bar` 的 `location.assign` 模式——但组件走 `props.navigate`（可注入测试）。
- 选中「+ 添加」：`selectPanel(PANEL_ID)` 切到「各主机」面板 + 派发自定义事件通知 panel 打开 add 视图。

**props**：组件通过 `inject` 拿 `AgentPanelBusinessProps`（registry/navigate 等），跟 `AgentPanel` 同 face。另需 `ctx`（拿 layout 服务做 selectPanel）——参照 `remote-conversation.tsx` 的 `selectPanel(ctx, id)` 模式（`ctx.get('layout').selectPanel(id)`）。

**「+ 添加」落点**：用 `ctx.get('layout').selectPanel('threadharbor-rollup')` 切面板，再 `window.dispatchEvent(new CustomEvent('threadharbor:open-add'))`。panel 组件在 `useEffect` 里 `addEventListener('threadharbor:open-add', () => setView({ page: 'add' }))`。简单、低耦合。

### 2. 注册到 `sidebar.footer.action`

在 `src/client/index.ts` 的 `registerPanelSlots` 里加：
```ts
slots.inject('sidebar.footer.action', () => slots.register(
  { name: 'sidebar.footer.action', id: 'threadharbor-host-switcher', order: 1, locale: NAMESPACE },
  HostSwitcher,
))
```
组件通过 `inject` 拿 `AgentPanelBusinessProps`，跟 `AgentPanel` 同 face。当前主机判定：读 `window.location.pathname`——`/threadharbor/gateway/<hostId>/` 则当前在该主机，`/` 则本机。

### 3. panel 响应「打开 add」事件

`src/panel.tsx` 的 `AgentPanel` 加一个 `useEffect`：
```ts
useEffect(() => {
  const open = () => openAdd()
  window.addEventListener('threadharbor:open-add', open)
  return () => window.removeEventListener('threadharbor:open-add', open)
}, [])
```
`openAdd` 已存在（2339 行）。

### 4. 当前主机判定

切换器要显示「当前在哪台主机」。读 `window.location.pathname`：
- `/threadharbor/gateway/<hostId>/` → 当前在 hostId。
- `/`（根） → 当前在本机。

### 5. i18n 文案

`src/locales.ts` 加（zh/en）：
- `switcher.label`：「主机」/「Hosts」
- `switcher.addHost`：「+ 添加主机」/「+ Add host」
- `switcher.local`：「本机」/「This machine」
- `switcher.current`：「（当前）」/「(current)」

### 6. 样式

`src/panel.module.css` 加 `.hostSwitcher` / `.hostSwitcherTrigger` / `.hostSwitcherMenu` / `.hostSwitcherItem` / `.hostSwitcherSeparator`，跟现有 `.hostList` / `.hostRow` 风格一致。折叠态（`wide === false`）只显示图标。下拉用绝对定位弹层。

## 四、验证

- `npm run typecheck:client` + `npm run test:client`（新组件加测试：列出主机、点切换 navigate、点添加触发、折叠态渲染）。
- `npm run build`（含 verify-client-build）。
- 手动：装到 desktop profile，重启 App，看侧栏底部有没有切换器，点能不能切主机，添加流程能不能进。

## 五、不做什么

- 不改后端（SSH 部署/隧道/网关已满足需求）。
- 不删现有「各主机」面板（它仍是添加/管理/详情的入口；切换器是快速切换的补充）。
- 不做会话树（2026-10-11 用户已决定会话列表在面板里没必要）。

## 六、实际结果（2026-11-02）

全部落地，门禁全绿：
- `npm run typecheck` ✓ / `typecheck:client` ✓
- `npm run test` 265 项 ✓ / `test:client` 426 项 ✓（含新增 `host-switcher.spec.ts` 5 项）
- `npm run build` ✓（`lib/client.js` 含切换器代码）

新增/改动文件：
- `src/host-switcher.tsx`（新组件，约 190 行）
- `src/client/index.ts`（注册 `sidebar.footer.action`；face 加 `navigate`/`openAddHost`；wiring 构造 `openAddHost` = selectPanel + dispatchEvent）
- `src/panel.tsx`（face 加 `navigate?`/`openAddHost?`；加 `OPEN_ADD_HOST_EVENT` 监听打开 add 视图）
- `src/locales.ts`（`switcher.*` 文案 zh/en）
- `src/panel.module.css`（切换器样式，折叠/展开两态）
- `tests-client/host-switcher.spec.ts`（新，5 项）
- `tests-client/host-icon.spec.ts`（壳子声明 `sidebar.footer.action`）

「+ 添加」落点定为：`selectPanel('threadharbor-rollup')` 切到「各主机」面板 + `dispatchEvent('threadharbor:open-add-host')`，panel 监听后 `openAdd()`。复用 `remote-conversation.tsx` 已有的 `ctx.get('layout').selectPanel` 模式。

待用户操作：重启桌面 App 看实际效果。
