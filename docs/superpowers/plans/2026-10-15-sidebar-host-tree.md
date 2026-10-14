# 左侧主机树（阶段 L）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 接管 DSH 左侧工作区列表槽位（`sidebar.workspaces`），渲染「主机 → 项目 → 会话」一棵树：本机子树真实可点，远端主机按登记簿列出并按需拉取会话。

**Architecture:** 以更低优先级数值遮蔽原生占位者（槽位机制官方支持，最低数值者渲染）。树模型复用 git 历史里被删除的 RollUpView 三层类型；本机数据经 cordis 服务 `workspaces`/`sessions`/`uiWorkspace` 读取与打开；远端数据经恢复的 ROUTE_REMOTE_SESSIONS 路由用 launchUrl 服务端拉取。被顶掉的原生组件不可组合渲染，本机外观为复刻简化版（用户已同意，升级时人工对齐）。

**Tech Stack:** pnpm workspace；packages/dsh-host-federation（服务端路由与纯函数）、packages/dsh-client（React 18 + CSS Modules + vitest + @testing-library/react）。

**Spec:** docs/design/dsh-multi-host-migration.md §8.5（插件接管左右会话区，2026-10-15 定稿）。

## Global Constraints

- zh 与 en 两份文案词典都加键，键名 `panel.tree.*`；PANEL_KEYS 键清单若校验则同步。
- 样式走 CSS Modules；测试钩子一律 `data-*` 属性（浏览器实测也靠它们，不用类名）。
- 登记簿与传输层不落任何秘密（沿用现有 HostSshInfo 纪律）。
- 构建门禁：`node_modules/.bin/tsc -b tsconfig.json --force` 后再 `npm run build`；全量 `npm run check`。
- 恢复代码一律取自 `git show 9fedeae^:<path>`，恢复时保留原注释与测试，再按本计划改造。
- 对 cordis 服务（`ctx.get`）的一切读取都做结构校验，失败给出中文原因，绝不静默成空树。

## Review Focus

1. **DSH 服务缺失或形状漂移**（`ctx.get('workspaces'/'sessions'/'uiWorkspace')` 返回 undefined 或字段变了）→ 树显示「本机会话未就绪：<原因>」，不许渲染看似真实的空树。测试入 Task 2/3。
2. **远端拉取失败**（隧道断、token 失效、接口 404）→ 该主机节点灰显并带原始原因，树其余部分照常。测试入 Task 1/5。
3. **从未部署的主机**（登记了但没有 launchUrl）→ 灰显「未部署」，点击进详情页，不许是死行。测试入 Task 4/5。
4. **跨主机同名项目**→ 标签带主机名限定，两行不得合并（rollup-view 原测试已钉，随 Task 1 恢复）。
5. **遮蔽组件自身崩溃**→ 槽位系统的失败即弃权机制应让原生列表回来（不整栏白屏）。单测不可达，Task 7 真机验证清单必含此项（临时抛错→原生出现→恢复）。

---

### Task 1: Federation 层恢复（分组、树视图、远端拉取路由）

**Files:**
- Restore: `packages/dsh-host-federation/src/workspace-map.ts`、`src/rollup-view.ts`、`src/host-remote-sessions.ts`（取自 9fedeae^）
- Modify: `src/federation.ts`（恢复 HostSession/RollUp 频道类型，如 9fedeae^ 版）、`src/ssh-deploy.ts`（恢复 ROUTE_REMOTE_SESSIONS 注册，方法 ['POST']）、`src/index.ts`（导出）
- Restore tests: `tests/rollup-view.spec.ts`；workspace-map/host-remote-sessions 的断言并入 `tests/federation.spec.ts` 新 describe

**Interfaces:**
- Produces: `sessionsFromWorkspaces(workspaces, {sessions, includeArchived?}): WorkspaceSession[]`；`rollUpView(rollUp: RollUp): RollUpView`（HostViewRow/ProjectView/SessionView 同 9fedeae^ 版）；`ROUTE_REMOTE_SESSIONS = '/api/threadharbor.host-remote.sessions'`，请求 `{launchUrl: string}`，响应 `{ok: true, value: {sessions: HostSession[], note?: string}}`；`HostSession = {sessionId, projectId, title, projectTitle?}`（以 9fedeae^ federation.ts 为准，逐字恢复）。

- [ ] **Step 1: 恢复测试先行** — 从 9fedeae^ 恢复 rollup-view.spec.ts 全文；在 federation.spec.ts 补 describe「远端会话拉取」：launchUrl 缺 token → `{sessions: [], note: 含「token」}`；fetch 两个候选端点（/api/workspace/list、/api/workspaces）先 404 后 200 → 解析成功条数正确（stub 全局 fetch）。
- [ ] **Step 2: 跑测确认失败** — `npx vitest run packages/dsh-host-federation`：新 describe 与 rollup-view 全红（模块不存在）。
- [ ] **Step 3: 恢复实现** — 三个文件逐字恢复；federation.ts 恢复类型；ssh-deploy.ts 挂回路由（沿用现有 register helper）。
- [ ] **Step 4: 跑测全绿** — 同 Step 2 命令，期望全绿。
- [ ] **Step 5: Commit** — `git add -A packages/dsh-host-federation && git commit -m "federation: 恢复工作区分组/树视图/远端会话拉取路由（阶段 L）"`

### Task 2: 客户端本机数据源恢复

**Files:**
- Restore: `packages/dsh-client/src/session-source.ts`（9fedeae^ 版）
- Test: `packages/dsh-client/tests/session-source.spec.ts`（9fedeae^ 有则恢复，无则新写）

**Interfaces:**
- Consumes: `sessionsFromWorkspaces`、`WorkspaceLike`、`SessionLike`（Task 1）。
- Produces: `readLocalSessions(ctx: ClientContextLike): Promise<SessionRead>`，`SessionRead = {ok: true, sessions: SourceSession[]} | {ok: false, note: string}`；`SourceSession = {projectId, sessionId, title, projectTitle}`。

- [ ] **Step 1: 测试先行** — 三例：两个服务齐 → 分组正确；`ctx.get('workspaces')` 为 undefined → `{ok: false, note 含「未就绪」}`；服务返回缺字段的畸形项 → 该项被剔除且 note 说明（不许整树失败也不许静默吞掉）。
- [ ] **Step 2: 跑测失败** — `npx vitest run packages/dsh-client/tests/session-source.spec.ts`。
- [ ] **Step 3: 恢复/实现** — 9fedeae^ 版即含结构校验，按测试对齐。
- [ ] **Step 4: 跑测全绿。**
- [ ] **Step 5: Commit** — `git commit -m "client: 恢复本机会话读取（阶段 L）"`

### Task 3: 本机打开接缝（uiWorkspace 结构收窄）

**Files:**
- Create: `packages/dsh-client/src/session-actions.ts`
- Test: `packages/dsh-client/tests/session-actions.spec.ts`

**Interfaces:**
- Produces: `openLocalSession(ctx, sessionId): boolean`（true=已派发）；`startSessionInProject(ctx, workspaceId): boolean`；两者对 `ctx.get('uiWorkspace')` 做 `typeof x?.openSession === 'function'` 收窄，缺失时返回 false 且由调用方显示原因。

- [ ] **Step 1: 测试先行** — 有 openSession → 调用且参数为 sessionId、返回 true；无服务 → false 且不抛；openSession 抛错 → 捕获转 false（界面上走失败提示路径）。
- [ ] **Step 2: 跑测失败。**
- [ ] **Step 3: 实现（收窄 + try/catch 即可由签名与测试确定）。**
- [ ] **Step 4: 跑测全绿。**
- [ ] **Step 5: Commit。**

### Task 4: 远端会话存储与合成（host-roll-up 恢复改造）

**Files:**
- Restore: `packages/dsh-client/src/remote-session-store.ts`、`src/host-roll-up.ts`（9fedeae^）
- Create: `packages/dsh-client/src/remote-session-poll.ts`
- Test: 恢复对应 spec 并补 remote-session-poll 用例

**Interfaces:**
- Consumes: `RollUpView`、`HostSession`（Task 1）、`HostRegistryPort`、在场频道快照（现有 panel 内类型，抽为参数注入，不在本任务内新建全局）。
- Produces: `createRemoteSessionStore()`（9fedeae^ 原接口）；`rollUpViewWithRegistry(rollUp, registrations, remoteSessions): RollUpView`（9fedeae^ 原签名）；`fetchHostSessions(launchUrl, t): Promise<{sessions: HostSession[]} | {failed: string}>` — 包 ROUTE_REMOTE_SESSIONS 的 POST，非 ok 响应原样带回错误文本。

- [ ] **Step 1: 测试先行** — 恢复 host-roll-up 原 spec；新增：未部署主机（无 launchUrl）→ 行 `empty: true` 且 label 后缀「未部署」标志字段（若无此字段则加 `readonly undeployed?: boolean` 到 HostViewRow）；fetchHostSessions：stub fetch 返回 `{ok: false, error: 'x'}` → `failed: 'x'`。
- [ ] **Step 2: 跑测失败。**
- [ ] **Step 3: 恢复实现并按测试改造（undeployed 标志 + 错误透传）。**
- [ ] **Step 4: 跑测全绿。**
- [ ] **Step 5: Commit。**

### Task 5: 树组件 HostSessionTree

**Files:**
- Create: `packages/dsh-client/src/host-session-tree.tsx`、`src/host-session-tree.module.css`
- Modify: `packages/dsh-client/src/locales.ts`（zh/en 加 `panel.tree.*`）
- Test: `packages/dsh-client/tests/host-session-tree.spec.ts`

**Interfaces:**
- Consumes: `RollUpView`（Task 1/4）、`openLocalSession`/`startSessionInProject`（Task 3）、`fetchHostSessions`（Task 4）。
- Produces: `HostSessionTree(props: {view: RollUpView; ctx: SessionActionsCtx; onOpenHostPage(hostId: string): void; initialExpanded?: string[]})`；钩子：根 `data-host-tree`、主机行 `data-host-node={hostId}`、展开箭头 `data-host-toggle`、项目组 `data-project-group={projectId}`、会话行 `data-session-row={sessionId}`、本机项目行内「新会话」`data-action="tree-new-session"`、未部署提示 `data-undeployed-note`、拉取失败原文 `data-host-error`。展开态存 localStorage（键 `threadharbor.tree.expanded`），本机默认展开。

- [ ] **Step 1: 测试先行（用 panel-interact 的 mount 辅助风格）** — 五例：三层结构渲染与 data 钩子齐全；点本机会话行 → openLocalSession 收到 sessionId；点远端会话行 → onOpenHostPage；未部署主机 → 灰显 + data-undeployed-note 文案；远端拉取失败 → data-host-error 含原始文本。首测前先写空组件让 import 可解析。
- [ ] **Step 2: 跑测失败。**
- [ ] **Step 3: 实现** — 纯渲染 + 回调，拉取失败文本由 view 外的 poll 层写入 remote-session-store 后经 props 重渲染（组件自身不发请求，保证可测）。样式对齐原生观感的简化：缩进两层、圆点状态位、等宽数字时间。
- [ ] **Step 4: 跑测全绿；zh/en 键齐。**
- [ ] **Step 5: Commit。**

### Task 6: 遮蔽注册与回退开关

**Files:**
- Modify: `packages/dsh-client/src/client/index.ts`（注册点）、`src/locales.ts`
- Test: `packages/dsh-client/tests/sidebar-shadow.spec.ts`

**Interfaces:**
- Consumes: `HostSessionTree`（Task 5）、`readLocalSessions`（Task 2）、`rollUpViewWithRegistry` + store + `fetchHostSessions`（Task 4）。
- Produces: `maybeRegisterSidebarTree(ctx): void` — 当 `localStorage.getItem('threadharbor.sidebarTree') !== 'off'` 时 `ctx.slots.register({name: 'sidebar.workspaces', priority: -10, locale: NS}, ShadowComponent)`；组件内部：挂载时 readLocalSessions + 30s 轮询、远端展开主机 fetchHostSessions + 60s 轮询、合并 rollUpViewWithRegistry 喂树。

- [ ] **Step 1: 测试先行** — 三例：开关 off → 不注册；on → 注册且 priority 为 -10 且 name 为 sidebar.workspaces；注册两次（HMR）→ 第二次静默跳过（用注册计数 stub 断言只调一次）。
- [ ] **Step 2: 跑测失败。**
- [ ] **Step 3: 实现** — 复用现有 client entry 的 ctx.slots 注入方式；`onOpenHostPage` 按 §8.5 阶段 L 过渡约定接到**那台主机的详情页**（切换到本插件面板并定位该主机行；有 launchUrl 的主机行内保留「打开页面」按钮即现有详情页能力，不在此处开新标签）；locale 键 `panel.tree.fallbackNote` 等。
- [ ] **Step 4: 跑测全绿。**
- [ ] **Step 5: Commit。**

### Task 7: 构建、真机验证与文档

**Files:**
- Modify: `docs/design/dsh-multi-host-migration.md`（§8.5 后补落地记录）

- [ ] **Step 1: `node_modules/.bin/tsc -b tsconfig.json --force && npm run check`** — 期望全绿。
- [ ] **Step 2: `npm run build && bash scripts/dev.sh restart web`** — 新 token 取自 web.log。
- [ ] **Step 3: Playwright 真机清单** — ①原生列表被遮蔽、树可见且含本机真实项目与会话；②点本机会话 → 会话打开；③jinmac 灰显未部署（或部署后灰显未连接）与提示文案；④开关置 off 刷新 → 原生列表回归；⑤临时在组件抛错（本地实验后必须还原）→ 原生列表顶回、不白屏。
- [ ] **Step 4: 文档落地记录（含：外观为复刻简化、升级需人工对齐、回退开关用法）。**
- [ ] **Step 5: Commit（不得包含 /tmp 与探针脚本）。**
