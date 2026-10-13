# 手机端独立入口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 安卓手机经 Tailscale 打开每台主机的 DSH 手机页，完成配对后可看会话、发消息、批权限、停止回合。

**Architecture:** 新宿主侧包 `@threadharbor/dsh-mobile-entry` 在 DSH Web 服务上挂三样东西：手机页静态资源（prefix 路由）、两个先过官方准入的小接口（peers / pair-url）、一个公开的 hello 标记。手机页是无构建的纯静态单页，直接说官方线上协议（POST `/api/<端点>` + WS `/api/remote.mux`），凭据走官方令牌换 cookie。桌面端 `dsh-client` 加二维码配对面板。网络层由每台机器的 `tailscale serve` + `--trusted-host` 完成，配置脚本与文档收尾。

**Tech Stack:** TypeScript（宿主侧，源码直连包模式）、原生 ESM JS（手机页，无构建）、vitest（node 环境 + 少量 jsdom）、`qrcode`（桌面面板）。

**Spec:** [docs/superpowers/specs/2026-10-14-mobile-entry-design.md](../specs/2026-10-14-mobile-entry-design.md)

## Global Constraints

- 源码直连包模式：`main`/`exports` 指向 `./src/*.ts`，导出含 `./package.json`；参照 `packages/dsh-host-federation/package.json`。
- 只用 DSH 公开服务面：`webServer.register` / `connection.admit` / `connection.authorizeIndex` / `connection.authenticatedUrl`。这些是 pre-stable API，上游签名变化时受影响面收敛在直接调用处，改动前先对照 `reference/deepseek-harness` 重核。
- 线上信封（已从 reference 钉死）：POST `/api/<endpoint>`，体为 `{method, payload, rpcId}`，`method` 必须等于端点串，应答按 `rpcId` 对上（`packages/client/connection/src/rpc-host.ts:230-262`）；WS 多路复用在 `/api/remote.mux`（`packages/api/gateway/src/stream-protocol.ts:7`）。
- 无凭据出口只有两类：手机页静态资源、hello 标记 JSON。其余一律先 `connection.admit`。
- wiring 规矩：新文件要么从 `ROOTS`/`COMPOSITION` 可达，要么登记 `KNOWN_UNWIRED` 并写清除条件（`tests/wiring.spec.ts:72`）。
- 手机页不引入构建链：`packages/dsh-mobile-entry/mobile/` 下是浏览器原生 ESM（`.js`），vitest 直接 import 测纯逻辑。
- 测试命令：`npx vitest run <file>`；全量 `npm run test`；类型 `npm run typecheck`。
- 用户可见文案中文；每个 Task 一次提交。

## Review Focus

1. **静态服务的路径穿越**（`/threadharbor/mobile/../../`、编码变体）→ 必须落到包内资源目录之外一律 404。测试钉在 Task 2。
2. **二维码里的令牌已过期**（面板打开后 DSH 重启过）→ 手机端交换收到 401，必须显示配对失败引导而不是白屏。测试钉在 Task 3（fake connection 的 401 分支）与 Task 8（引导态渲染数据）。
3. **会话中途 cookie 过期**（30 天到期）→ wire 客户端把 API 401 映射为「未配对」状态，应用回到引导屏不崩溃。测试钉在 Task 7。
4. **桌面与手机同时在线时审批事件的派发语义**（两个消费者，谁收到、谁作答）→ Task 6 探针实测并记录；Task 8 的横幅按实际派发实现，行为写进研究笔记。
5. **本机 Tailscale 缺失/未登录 + `mobileOrigin` 配置错误** → peers 接口返回结构化错误且本机入口不受影响；坏配置在装载时大声失败。测试钉在 Task 5 与 Task 4。

---

### Task 1: 新包骨架与装载接线

**Files:**
- Create: `packages/dsh-mobile-entry/package.json`、`packages/dsh-mobile-entry/tsconfig.json`、`packages/dsh-mobile-entry/src/index.ts`、`packages/dsh-mobile-entry/tests/smoke.spec.ts`
- Modify: `cordis.patch.yml`（插一行组合行）、`tests/wiring.spec.ts:10`（PACKAGES 数组）

**Interfaces:**
- Consumes: 无（首个任务）。
- Produces: 包 `@threadharbor/dsh-mobile-entry`；`src/index.ts` 导出 `name = 'threadharbor-mobile-entry'`、`inject = ['webServer', 'connection']`、`Config`（schemastery，字段见 Task 4）、`apply(ctx, config)`（本任务内为空体）。后续任务都往这个入口上加。

- [ ] **Step 1: 建 `src/index.ts` 空插件并写失败测试**

`tests/smoke.spec.ts` 断言模块导出 `name === 'threadharbor-mobile-entry'` 且 `inject` 含 `webServer`、`connection`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/dsh-mobile-entry/tests/smoke.spec.ts`
Expected: FAIL（模块不存在）。先建包骨架（照 `packages/dsh-host-federation/package.json` 抄结构，无依赖）后此处转 PASS。

- [ ] **Step 3: 跑 wiring 确认失败并接线**

Run: `npm run test -- tests/wiring.spec.ts`
Expected: FAIL（新包不在 PACKAGES / 不可达）。把包名加进 `tests/wiring.spec.ts` 的 `PACKAGES`，在 `cordis.patch.yml` 的 insert 列表加 `- id: threadharbor-mobile-entry` + `name: '@threadharbor/dsh-mobile-entry'`。
Run: `npm run test -- tests/wiring.spec.ts` → PASS。

- [ ] **Step 4: typecheck + 提交**

Run: `npm run typecheck`
Commit: `feat(mobile): dsh-mobile-entry 包骨架并接入组合`

### Task 2: 手机页静态服务与 hello 标记

**Files:**
- Create: `packages/dsh-mobile-entry/src/static-serve.ts`、`packages/dsh-mobile-entry/mobile/index.html`（占位壳，Task 8 换真身）、`packages/dsh-mobile-entry/tests/static-serve.spec.ts`
- Modify: `packages/dsh-mobile-entry/src/index.ts`

**Interfaces:**
- Consumes: Task 1 的入口与 `inject`。
- Produces:
  - `MOBILE_PREFIX = '/threadharbor/mobile'`、`HELLO_PATH = '/threadharbor/mobile/hello'`
  - `resolveMobileAsset(pathname: string): { status: 200; body: string; contentType: string } | { status: 404 }`（纯函数；`/threadharbor/mobile/` 与 `/threadharbor/mobile` 映射 index.html；只读包内 `mobile/` 目录清单，目录外的路径一律 404）
  - `registerMobileRoutes(ctx, config): void`——在 `apply` 里调用；注册 prefix 路由（静态）与 exact 路由 hello（GET，无准入，返回 `{'content-type':'application/json','cache-control':'no-store'}` 体 `{"mobile":true}`）

- [ ] **Step 1: 写失败测试**

`static-serve.spec.ts` 用例：index 两 spelling 返回 200 与 `text/html`；未知资源 404；**路径穿越**（`/threadharbor/mobile/../../package.json`、百分号编码变体）返回 404；hello 形状断言。资源目录清单在测试里用临时目录注入（`resolveMobileAsset` 接受可选目录参数，默认包内 `mobile/`）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/dsh-mobile-entry/tests/static-serve.spec.ts` → FAIL

- [ ] **Step 3: 实现 `resolveMobileAsset` 与路由注册**

路径归一化用 `new URL(pathname, 'http://x')` 后逐段检查：解码后必须落在 `mobile/` 前缀内（段级判断，不用 `startsWith` 字符串拼接）。注册用 `ctx.effect(() => ctx.webServer.register(...))` 双调用（返回 disposer）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/dsh-mobile-entry/tests/static-serve.spec.ts` → PASS；`npm run test -- tests/wiring.spec.ts` → PASS

- [ ] **Step 5: 提交**

Commit: `feat(mobile): 手机页静态服务与 hello 标记（prefix 路由，拒绝路径穿越）`

### Task 3: 配对交换封装（authorizeIndex 委托）

**Files:**
- Create: `packages/dsh-mobile-entry/src/pairing.ts`、`packages/dsh-mobile-entry/tests/pairing.spec.ts`
- Modify: `packages/dsh-mobile-entry/src/static-serve.ts`（index 请求先过封装）

**Interfaces:**
- Consumes: `connection.authorizeIndex(request, response): boolean`（官方语义见 spec 事实 11：带有效根令牌 → 铸 cookie + 303 `./`；带 cookie → true；其余 401 并接管响应）。
- Produces: `authorizeMobileIndex(req: { method: string; url: string; headers: Record<string, string> }, res: MinimalResponse, connection: { authorizeIndex(req: unknown, res: unknown): boolean }): boolean`——查询串带令牌时把 `url` 改写为 `/?<原查询串>` 再委托（浅封装对象，原 headers 保留）；不带令牌直接透传委托，false 时调用方返回引导壳。

- [ ] **Step 1: 写失败测试**

fake connection 实现官方三分支语义，用例四条：①带令牌 → 委托收到 `url` 以 `/` 开头且含同一查询串，返回 false、响应被 fake 接管（303+cookie）；②带无效令牌 → 同上封装路径但 fake 走 401 分支；③带 cookie 无令牌 → 原样透传返回 true；④两者皆无 → 透传 false（调用方服务引导壳）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/dsh-mobile-entry/tests/pairing.spec.ts` → FAIL

- [ ] **Step 3: 实现封装**

只做请求对象的 url 改写与转发，不接触 cookie/密钥/令牌值本身。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/dsh-mobile-entry/tests/pairing.spec.ts` → PASS（含 Task 2 回归）

- [ ] **Step 5: 提交**

Commit: `feat(mobile): 扫码配对经官方 authorizeIndex 完成令牌换 cookie`

### Task 4: pair-url 接口与 mobileOrigin 配置

**Files:**
- Create: `packages/dsh-mobile-entry/src/pair-url.ts`、`packages/dsh-mobile-entry/tests/pair-url.spec.ts`
- Modify: `packages/dsh-mobile-entry/src/index.ts`（Config 与路由挂载）

**Interfaces:**
- Consumes: `connection.admit(req)`、`connection.authenticatedUrl(baseUrl: string): string`。
- Produces:
  - Config 字段 `mobileOrigin?: string`（如 `https://mac1.example.ts.net`；schema 校验：https、无路径/查询/碎片、无尾斜杠，违反即装载失败）
  - `PAIR_URL_PATH = '/threadharbor/mobile/pair-url'`，GET，先 admit：拒绝时按官方 401/403 短体应答；通过且 `mobileOrigin` 未配置时 500 体 `{"error":"mobile-origin-unset"}`；正常 200 体 `{"url": <authenticatedUrl(`${mobileOrigin}/threadharbor/mobile/`)>}`

- [ ] **Step 1: 写失败测试**

用例：无 cookie → 401；坏 `mobileOrigin`（http、带路径、带尾斜杠）→ 配置解析抛错；未配置 → 500 `mobile-origin-unset`；正常 → 200 且 url 以配置 origin 开头、含 `/threadharbor/mobile/` 且带非空查询串（令牌）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/dsh-mobile-entry/tests/pair-url.spec.ts` → FAIL

- [ ] **Step 3: 实现路由与 schema**

admit 的分支照抄官方写法（`reference/.../client/connection/src/index.ts:148-153`：`'rejection' in admission` → `res.writeHead(admission.rejection)`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/dsh-mobile-entry/tests/pair-url.spec.ts` → PASS

- [ ] **Step 5: 提交**

Commit: `feat(mobile): pair-url 接口（准入后返回带令牌的手机根网址）`

### Task 5: peers 接口与 Tailscale 查询复用

**Files:**
- Create: `packages/dsh-mobile-entry/src/peers.ts`、`packages/dsh-mobile-entry/tests/peers.spec.ts`
- Modify: `packages/dsh-host-federation/src/tailscale.ts`（抽出可复用查询）、`packages/dsh-host-federation/package.json`（如需子路径导出）、`packages/dsh-mobile-entry/src/index.ts`

**Interfaces:**
- Consumes: 联邦包现有解析逻辑（`tailscale.ts` 内 `tailscale status --json` 的 exec + StatusNode 解析，行为不变）。
- Produces:
  - 联邦包导出 `queryTailscalePeers(run?: (file: string, args: string[]) => Promise<{ stdout: string }>): Promise<{ peers: readonly TailscalePeer[]; error?: string }>`（`run` 缺省用 `execFile` promisify；现有 bridge 改为调它，键值写入不变）
  - `PEERS_PATH = '/threadharbor/mobile/peers'`，GET，先 admit；应答 `{"peers":[{"dnsName","online","dsh"}],"error?}`；`dsh` 由服务端并发探测各 peer 的 `https://<dnsName>/threadharbor/mobile/hello`（2s 超时，结果缓存 5s，探测失败一律 `dsh:false` 不阻塞应答）；tailscale 查询失败/超时（3s）→ 200 + `error` 字段 + 空 peers

- [ ] **Step 1: 写失败测试**

用例：无 cookie → 401；注入 fake `run` 返回两台 peer + fake 探测（一台 200、一台超时）→ 应答里 `dsh` 分别 true/false 且总耗时 < 探测串行耗时；fake `run` 抛错（tailscale 缺失）→ 200 + `error` 非空 + 空 peers；5s 内二次调用不再触发探测（缓存）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/dsh-mobile-entry/tests/peers.spec.ts` → FAIL；联邦包回归 `npx vitest run packages/dsh-host-federation` → PASS（抽出后行为不变）

- [ ] **Step 3: 实现联邦包抽出与 peers 路由**

探测用全局 `fetch` 注入点（模块级可替换变量，测试换 fake）；并发用 `Promise.allSettled`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/dsh-mobile-entry packages/dsh-host-federation` → PASS

- [ ] **Step 5: 提交**

Commit: `feat(mobile): peers 接口复用联邦 Tailscale 查询并探测各机 DSH`

### Task 6: 线上协议探针（端点与事件形状钉死）

**Files:**
- Create: `scripts/probe-mobile-wire.mjs`、`docs/research/2026-10-15-mobile-wire.md`、`packages/dsh-mobile-entry/src/wire.ts`
- Test: 产出文档与常量即本任务的「测试」；`wire.ts` 不需要单测（纯常量 + 端到端由 Task 11 验证）

**Interfaces:**
- Consumes: `scripts/dev.sh` 的本地实例（默认 `http://127.0.0.1:3081`，令牌从 `$DSH_HOME/threadharbor-runtime/web.log` 的 `dsh web:` 行取）。
- Produces: `wire.ts` 导出 `SESSION_LIST_ENDPOINT`、`SESSION_HISTORY_ENDPOINT`、`SESSION_PROMPT_ENDPOINT`、`SESSION_CANCEL_ENDPOINT`、`MUX_PATH = '/api/remote.mux'`、mux 客户帧的字面量类型 `MuxClientFrame`（值全部来自探针实测，写进研究笔记）。

- [ ] **Step 1: 起实例并写探针**

Run: `scripts/dev.sh restart web`。探针脚本用 `fetch` + `WebSocket`（node 原生），按 Task 6 目标逐项打：会话列表、历史分页读、发一条消息、取消、mux 握手帧序、`approval/request` 事件的到达与应答回路、**双连接同时在线时事件的派发**（两个 mux 连接订阅同一事件，记录谁收到）。

- [ ] **Step 2: 跑探针并核对**

Run: `node scripts/probe-mobile-wire.mjs $(grep -o 'token=[^& ]*' <log> | head -1)`
Expected: 五类形状全部拿到；端点不存在时按 reference 源码（`packages/api/session-controller/src/client/`）修正候选名重跑。任何一项拿不到：停下来，把缺口记进研究笔记并在提交信息里说明（审批缺失按 spec V6 退路处理，需用户确认降级）。

- [ ] **Step 3: 固化常量与笔记**

`wire.ts` 写入实测端点与帧类型；研究笔记记录每类调用的请求/响应 JSON 样例与双连接派发结论。

- [ ] **Step 4: typecheck + 提交**

Run: `npm run typecheck`
Commit: `feat(mobile): 线上协议探针——端点/信封/事件形状与双连接派发结论`

### Task 7: 手机页 wire 客户端（纯逻辑模块）

**Files:**
- Create: `packages/dsh-mobile-entry/mobile/wire.js`、`packages/dsh-mobile-entry/tests/wire.spec.ts`

**Interfaces:**
- Consumes: Task 6 的 `wire.ts` 常量（同值硬编码进 `wire.js`——静态页不 import TS）。
- Produces（浏览器原生 ESM，node 可直接 import）:
  - `rpcCall(fetchLike, endpoint, payload, rpcId): Promise<{ ok: true; result: unknown } | { ok: false; kind: 'unpaired' | 'untrusted' | 'error'; message: string }>`（401→unpaired、403→untrusted）
  - `createBackoff(attempts): { next(): number }`（重连退避：1s、2s、5s、10s 封顶）
  - `class MuxConnection`——构造 `(urlFactory, socketFactory)`；`onEvent(type, listener)`；`answer(eventId, outcome)`；`close()`；断线自动按 backoff 重连并重放订阅

- [ ] **Step 1: 写失败测试**

用例：信封编码（体含 method===endpoint、rpcId 唯一递增）；401/403 映射；backoff 序列与封顶；MuxConnection 用 fake socketFactory 走「连接→收事件→应答→断线→按序重连→重放订阅」全链（vitest fake timers）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/dsh-mobile-entry/tests/wire.spec.ts` → FAIL

- [ ] **Step 3: 实现 wire.js**

无 DOM 依赖；`URL`/`WebSocket`/`fetch` 全部经参数注入。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/dsh-mobile-entry/tests/wire.spec.ts` → PASS

- [ ] **Step 5: 提交**

Commit: `feat(mobile): 手机页 wire 客户端——RPC 信封、退避重连、事件应答`

### Task 8: 手机页应用（壳与四屏）

**Files:**
- Create: `packages/dsh-mobile-entry/mobile/index.html`、`mobile/app.js`、`mobile/views.js`、`mobile/app.css`
- Modify: `packages/dsh-mobile-entry/mobile/index.html`（Task 2 的占位换真身）、`vitest.config.ts`（如 views 测试需要 jsdom 则加 environmentMatchGlobs 行）
- Test: `packages/dsh-mobile-entry/tests/views.spec.ts`

**Interfaces:**
- Consumes: Task 7 的 `rpcCall` / `MuxConnection`、Task 5 的 peers 应答形状、Task 6 的端点常量。
- Produces: `views.js` 纯函数 `renderHostList(state): string`（HTML 串）、`renderSessionList(state): string`、`renderConversation(state): string`、`pairingGuideView(reason: 'unpaired' | 'untrusted' | 'token-rejected'): string`、`stateFold(prev, event): state`（事件归并）。`app.js` 只做 DOM 挂接与调用编排。

- [ ] **Step 1: 写失败测试**

`views.spec.ts`（node 或 jsdom）用例：配对三分支各自的引导文案（unpaired→指向桌面二维码入口；untrusted→指向信任主机配置文档；token-rejected→说明令牌已过期需重扫）；主机列表渲染 peers 数据含在线/离线/dsh 标记；会话列表与对话视图渲染分页标记（hasMore→「加载更早」）；`stateFold` 对 append/prepend/assistant-stream 三类事件的归并幂等。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/dsh-mobile-entry/tests/views.spec.ts` → FAIL

- [ ] **Step 3: 实现应用**

交互清单（spec §5）：主机清单 → 会话列表 → 会话内容（加载更早）→ 输入框发消息；待批权限顶部横幅 + 批准/拒绝（经 MuxConnection 应答 `approval/request`，派发行为按 Task 6 结论）；停止按钮（SESSION_CANCEL_ENDPOINT）；窄屏/拇指尺寸/深色模式（CSS 媒体查询）。入口流程：先 rpcCall 会话列表探测配对状态再渲染首页。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/dsh-mobile-entry` → PASS

- [ ] **Step 5: 提交**

Commit: `feat(mobile): 手机页应用——配对引导/主机清单/会话/发消息/批权限/停止`

### Task 9: 桌面配对二维码面板

**Files:**
- Create: `packages/dsh-client/src/pairing-panel.ts`、`packages/dsh-client/tests/pairing-panel.spec.ts`
- Modify: `packages/dsh-client/src/client/index.ts`（挂载）、`packages/dsh-client/package.json`（加 `qrcode` 依赖）
- 参照: `packages/dsh-client/src/rollup-section.ts`（侧栏 section 注册模式）、`packages/dsh-client/src/gateway.ts`（同源 fetch 模式）

**Interfaces:**
- Consumes: Task 4 的 `PAIR_URL_PATH` 应答形状 `{url: string}`。
- Produces: 侧栏 section「手机配对」：拉取 `PAIR_URL_PATH`，用 `qrcode` 渲染二维码 + 网址文本；拉取失败（未配置 mobileOrigin）显示配置指引文案。

- [ ] **Step 1: 写失败测试**

照 `tests/rollup-section.spec.ts` 的模式：无 pair-url 可达/500 → 指引文案；200 → 二维码容器与网址文本出现；`renderToString` 断言（无 DOM）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/dsh-client/tests/pairing-panel.spec.ts` → FAIL

- [ ] **Step 3: 实现面板并重建浏览器包**

Run: `npm run build`（dsh-client bundle 重建，`qrcode` 打进 client.js）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/dsh-client` → PASS

- [ ] **Step 5: 提交**

Commit: `feat(mobile): 桌面侧栏手机配对面板——二维码 + 网址回退`

### Task 10: 配置脚本与文档

**Files:**
- Create: `scripts/mobile-setup.sh`
- Modify: `scripts/dev.sh`（`THREADHARBOR_TRUSTED_HOST` 透传为 `--trusted-host`）、`docs/mobile-client.zh.md`（按 spec 重写）、`docs/install.zh.md`（「手机通道」一节：serve 命令、trusted-host、SSH 备用通道）、`README.md`（当前能力一行 + 仓库结构一行）

**Interfaces:**
- Consumes: 无代码接口；文档内容以 spec 为准。
- Produces: `mobile-setup.sh <dsh端口>`——读本机 `tailscale status --json` 的 Self DNS 名；跑 `tailscale serve --bg <端口>`；打印应加的 `--trusted-host <本机.ts.net>` 与 `dsh` 启动示例；tailscale 不可用时非零退出并说明。

- [ ] **Step 1: 写脚本**

`bash -n` 过语法；`--help` 输出用法。

- [ ] **Step 2: 手工核对文档三处**

重写后的 `mobile-client.zh.md` 文首不再有过时标注（内容即现状）；install 文档步骤与脚本输出一致；README 能力行注明「核对时间 2026-10-15」。

- [ ] **Step 3: 全量检查 + 提交**

Run: `npm run typecheck && npm run test`
Commit: `feat(mobile): mobile-setup 配置脚本与手机通道文档（spec 落地文档三处）`

### Task 11: 真机验收（阶段 0 清单 + 第一版全流程）

**Files:**
- Create: `docs/research/2026-10-15-mobile-acceptance.md`（验收记录）
- Test: 本任务是人工验收，记录即测试

**Interfaces:**
- Consumes: 前十个任务的全部产出。
- Produces: 验收记录，含 spec §8 的 V1–V5、V7 结论与全流程截图/结论。

- [ ] **Step 1: Mac 侧预检（不需要手机）**

`scripts/dev.sh restart web` → `scripts/mobile-setup.sh 3081` → 从本机 curl `https://<本机>.ts.net/threadharbor/mobile/hello` 验证 V1（Host 保留：hello 能通即准入未拒；再用 curl `-H 'Origin: ...'` 复核 403 分支）；用 `websocat`/node 脚本过 hello 同域的 mux 升级验 V2。

- [ ] **Step 2: 手机侧验收**

安卓装 Tailscale 并连入；浏览器开 `https://<本机>.ts.net/threadharbor/mobile/`：V5（证书信任）、配对引导文案、桌面扫码（V7：303 落回手机页、cookie 生效）、主机清单、会话浏览与「加载更早」、发消息、批权限（桌面同时在线与离线两种情形，对照 Task 6 派发结论）、停止、30 天凭据说明。V4（重启后 cookie）：`scripts/dev.sh restart web` 后手机刷新仍可用。

- [ ] **Step 3: 退路判定与记录**

任何一项不过：按 spec §8 退路列记录并回计划调整（V1/V2 不过→本机轻量转发；V3 过不了重启→文档写明重跑命令；V7 不过→QR 改指官方根路径）。V3（整机重启）可与用户约时间补验，先在记录中标注「待补」。

- [ ] **Step 4: 提交**

Commit: `docs(mobile): 真机验收记录（阶段 0 清单 + 第一版全流程）`
