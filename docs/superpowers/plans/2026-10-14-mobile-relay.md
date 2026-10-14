# 手机入口中转方案（tencent01 聚合）实施计划

> **给执行代理：** 必须使用子技能 `subagent-driven-development`（推荐）或 `executing-plans` 逐任务执行本计划。步骤用复选框（`- [ ]`）跟踪。

**目标：** 让手机不装 Tailscale，只经公网 HTTPS 访问云主机 tencent01，在一个入口里查看 tailnet 上各台机器的会话，并完成读历史、发消息、批权限、停回合。

**架构：** 新增宿主侧插件 `@threadharbor/dsh-mobile-relay`，跑在云主机的 DSH 上。它经 SSH 为每台机器维持一条本地端口转发（复用联邦包已有的 `DshSshManager.ensureTunnel`），经隧道读该机启动日志里的启动网址换取 cookie，之后用 cookie 代理该机的官方 RPC 调用与 `/api/remote.mux` 事件流；各机事件汇流成一条流推给手机。手机页代码只有一份（`packages/dsh-mobile-entry/mobile/`），由服务端注入的 `mode` 决定走「直连本机」还是「经云主机聚合」两个后端之一。

**技术栈：** TypeScript（宿主插件，ESM，无构建）、cordis 插件装载（`name`/`inject`/`Config`/`apply`）、`@deepseek-ai/schemastery` 配置校验、OpenSSH CLI（既有 SSH 能力用 CLI 而非库）、`ws`（唯一新增运行时依赖，用于带 Cookie 头升级 WS）、原生 ESM 手机页（无构建链）、vitest（Node 环境，页面挂接层用 jsdom）。

**设计文档：** `docs/superpowers/specs/2026-10-14-mobile-relay-design.md`（本计划与其一同阅读；事实核对时间 2026-10-14）

## 全局约束

- 仓库 Node 要求 `^22.19.0 || >=24.0.0`；tencent01 现为 v20.20.2，部署前必须升级（Task 1）。
- 手机页保持零构建链：原生 ESM、不得引入 import map、打包器或框架；页面文件仍是 `.js` + 旁置 `.d.ts`。
- 对手机暴露的一切出口都必须先 `connection.admit(req)`，拒绝时状态码原样写出、短体固定（401 `'unauthorized'`，其余 `'forbidden'`）——与 `packages/dsh-mobile-entry/src/pair-url.ts` 同一写法。
- 凭据（cookie、启动令牌）不得出现在任何日志、错误消息、接口应答或提交内容里。
- 手机侧只认云主机：各机 cookie 永不下发给手机；`pair-url` 在云主机上照旧用官方 `connection.authenticatedUrl`。
- 云主机对外只暴露 HTTPS；云主机自身 DSH 必须把公网域名列入 `--trusted-host`，且该域名与 `mobileOrigin` 完全一致（装载期由 `assertMobileOrigin` 校验）。
- 各机 DSH 保持只监听回环，**不得**要求用户给各机新增 `tailscale serve` 或 `--trusted-host`。
- 审批沿用宿主「先答先生效」语义；代理转发不得改变这一语义，迟到的应答按良性处理。
- 面向用户的文案一律中文；改动既有中文文案时保持原有语气。
- 每个任务结束前跑全量 `npm run test` 与 `npm run typecheck`，两者必须干净（不是只看聚焦用例）。
- 新增包必须同步四处：包 `package.json`、根 `package.json` 的 `dependencies`（`workspace:^`）、根 `tsconfig.json` 的 `references`、`tests/plugin.spec.ts` 里那份 `expect(manifest.dependencies).toEqual({...})` 名单；组合行加进 `cordis.patch.yml`。

## 评审重点

写代码时最容易出问题、而本设计文档没有逐条规定的地方（按最容易咬人的顺序）。每条在对应任务里补上钉住它的用例。

1. **答审批时机器串了**：两台机器同时有待批请求，手机应答必须发给发起该请求的那台；发错机器要么静默失败，要么批错事。对应 Task 8：`answer` 必须带 `hostId`，测试用两台假机器各挂一个待批事件，断言手机对 A 的应答只落到 A 的连接上。
2. **换机器后残留上一台的内容**：从机器 A 切到 B，慢应答回来时不得把 A 的会话内容画到 B 上。对应 Task 9：会话代际防护必须把机器维度一起纳入，测试用两台假机器 + 延迟应答复现。
3. **云主机重启后端口漂移**：cookie 与端口绑定，隧道本地端口一旦换人，旧 cookie 打新端口必然 401。对应 Task 5：端口分配必须持久化；测试里清空隧道（模拟重启）但保留已分配端口，断言端口不变、凭据复用。
4. **机器重启后启动令牌轮换**：cookie 在有效期内应继续可用；失效时应自愈一次；第二次失败必须如实标「凭据需更新」，不得静默降级成只读。对应 Task 4：三次用例——有效期内直接用、401 后重换一次成功、连续两次 401 后标脏且接口如实说明。
5. **手机首访的 Host 是公网域名**：云主机未信任该域名时首访即 403。对应 Task 3：装载期校验 `mobileOrigin` 与 `--trusted-host` 的一致性由运维脚本保证，用例钉住「`mobileOrigin` 非规范化 https origin 装载即失败」（复用 `assertMobileOrigin` 的既有测试形状）。

---

### Task 1: 云主机就位与阶段 0 真机验证

**文件：**
- 新建：`scripts/probe-relay-wire.mjs`
- 新建：`docs/research/2026-10-16-relay-spike.md`
- 不改产品代码（本任务只产出证据与探针）

**接口：**
- 产出：`probe-relay-wire.mjs` 的用法与输出格式（后续任务的实现者据此核对真实行为）；证据文档中的「实测」条目。

**背景事实（已核对，2026-10-14）：** tencent01 = `212.64.11.60`，SSH `tencent01-root`（root）/ `tencent01-ts`（tailnet 100.84.120.35，用户 hello）；已装并在跑 Tailscale；Node v20.20.2；未装 DSH。tailnet 里可连到本机 22 端口。本机日常 DSH 监听 `127.0.0.1:3081`，启动未带 `--trusted-host`，`tailscale serve` 无配置。`ws@8.21.3`/`8.22.0` 已在工作区 store 可离线安装。

- [ ] **Step 1: 升级 tencent01 的 Node 到 22.19+ 或 24**

经 SSH 在 tencent01 上安装新版 Node（不动系统自带 v20），确认 `ssh tencent01-root 'node -v'` 落在 `^22.19.0 || >=24.0.0`。若该机无 nvm，先装 nvm 再装版本。

- [ ] **Step 2: 在 tencent01 上装 DSH + ThreadHarbor（暂不含新插件）**

按 `docs/install.zh.md`（核对时间 2026-10-15）里的安装在 tencent01 上装 DSH Web 与 ThreadHarbor，用独立家目录（不要碰本机那三个既有家目录）。启动时带 `--trusted-host <公网域名>`（域名以用户实际提供的为准；若用户尚未给出公网域名，用一个占位域名先跑通其余步骤，并在证据文档里标注该占位，Step 6 会暴露缺项）。把实际用的启动命令、家目录路径与配置文件位置记进证据文档。

- [ ] **Step 3: 写探针脚本 `scripts/probe-relay-wire.mjs`**

一个 Node 脚本，按顺序实测并逐条打印结论（每条标注「实测」或「源码钉死 + 出处」）：

1. 开一条 SSH 本地转发：`ssh -N -L <freePort>:127.0.0.1:3081 <machine>`（目标机与端口由命令行参数给），确认 `http://127.0.0.1:<freePort>/` 可达；
2. 经同一 SSH 读目标机 DSH 启动日志里最后一行 `LAUNCH_URL=`，取出令牌（不打印令牌原文，只打印长度与是否取到）；
3. `GET http://127.0.0.1:<freePort>/?token=<令牌>` 取 `Set-Cookie`，打印 cookie 名与过期属性（不打印值）；
4. 带该 cookie `POST /api/session/list`（信封 `{"type":"client-request","rpcId":"p1","method":"session/list","payload":{"args":{}}}`），打印 HTTP 状态与 `result.ok`；
5. 用 `ws` 库带 `Cookie` 头升级 `ws://127.0.0.1:<freePort>/api/remote.mux`，发 open 帧订阅 `$events`（`payload` 恰为 `{"args":{}}`），打印是否收到 `ready` 帧与其 `clientId` 是否存在；并**实测 Node 内置 `WebSocket` 是否能带自定义头**（预期不能，据此确认必须用 `ws`）；
6. 打印 `tailscale status --json` 里可见的对端名数量。

- [ ] **Step 4: 跑探针并把结论写进证据文档**

`node scripts/probe-relay-wire.mjs --machine tencent01-... --port 3081`（参数按 Step 1/2 的实际值）。新建 `docs/research/2026-10-16-relay-spike.md`：每条结论一行，标「实测」或「源码钉死（文件:行）」，并写明核对时间 2026-10-16。**任一条失败就停下报告，不要继续 Task 2**——通道不成立时整个方案要改。

- [ ] **Step 5: 跑全量测试与类型检查（本任务未改产品代码，应与基线一致）**

Run: `npm run test && npm run typecheck`
Expected: 与基线同数通过、0 失败。

- [ ] **Step 6: 提交**

```bash
git add scripts/probe-relay-wire.mjs docs/research/2026-10-16-relay-spike.md
git commit -m "docs(relay): 阶段 0 真机验证——SSH 隧道换 cookie、WS 带 Cookie 头、tailnet 发现"
```

---

### Task 2: 联邦包公开「读远端启动网址」

**文件：**
- 修改：`packages/dsh-host-federation/src/ssh/manager.ts`（新增一个公开方法）
- 测试：`packages/dsh-host-federation/tests/launch-url.spec.ts`

**接口：**
- 产出：`DshSshManager.readLaunchUrl(config: SshConnectionConfig, remoteLogPath: string, timeoutMs?: number): Promise<string | undefined>` —— 经 SSH 读远端日志，返回**最后一行** `LAUNCH_URL=` 的值（无则 `undefined`）。取不到不抛错。

**注意：** `remoteExec` 与 `materializeAuth` 是 manager 的 private 方法，本任务在类内新增公开方法复用它们，不导出新的内部面。远端命令固定为 `grep -h '^LAUNCH_URL=' <logPath> | tail -1`（默认 `remoteLogPath` 取 `~/.dsh-threadharbor/dsh-web.log`——实际路径以 Step 1/2 在 tencent01 上确认的为准，确认后写进方法默认参数注释）。

- [ ] **Step 1: 写失败用例**

`packages/dsh-host-federation/tests/launch-url.spec.ts`：用假 SSH 执行面（沿用 `tests/ssh-manager.spec.ts` 注入 exec 的方式）喂三种 stdout——含两行 `LAUNCH_URL=`（断言取最后一行）、只有 `ALREADY_RUNNING=1`（断言 `undefined`）、空（断言 `undefined`）。

- [ ] **Step 2: 跑用例确认失败**

Run: `npx vitest run packages/dsh-host-federation/tests/launch-url.spec.ts`
Expected: FAIL，`readLaunchUrl is not a function`。

- [ ] **Step 3: 实现 `readLaunchUrl`**

在 `DshSshManager` 里加公开方法：`await this.remoteExec(this.materializeAuth(config), script, timeoutMs ?? 15_000)`，用既有 `parseDeployMarkers` 的行解析逻辑（同一份 `startsWith('LAUNCH_URL=')` 规则；`parseDeployMarkers` 取的是最后一次出现，行为正好一致，直接复用它解析 stdout 即可），stdout 空或命令非零退出时返回 `undefined`，任何异常也返回 `undefined`（取不到不是致命事）。

- [ ] **Step 4: 跑用例确认通过**

Run: `npx vitest run packages/dsh-host-federation/tests/launch-url.spec.ts`
Expected: PASS（3 个用例）。

- [ ] **Step 5: 跑全量与类型检查**

Run: `npm run test && npm run typecheck`
Expected: 0 失败，类型干净。

- [ ] **Step 6: 提交**

```bash
git add packages/dsh-host-federation/src/ssh/manager.ts packages/dsh-host-federation/tests/launch-url.spec.ts
git commit -m "feat(federation): 公开读远端 DSH 启动网址（复用部署那套标记解析）"
```

---

### Task 3: 中转包骨架与装载接线

**文件：**
- 新建：`packages/dsh-mobile-relay/package.json`、`packages/dsh-mobile-relay/tsconfig.json`、`packages/dsh-mobile-relay/src/index.ts`
- 修改：根 `package.json`（`dependencies` 加 `'@threadharbor/dsh-mobile-relay': 'workspace:^'`）、根 `tsconfig.json`（`references`）、`tests/plugin.spec.ts`（依赖名单加一行、组合行断言加一条）、`cordis.patch.yml`（新增组合行）

**接口：**
- 产出：`apply(ctx, config)` 挂载的中转插件；配置形状 `MobileRelayConfig`（见下）；组合行 id `threadharbor-mobile-relay`。

**配置形状（`Config` 的解析结果）：**

```ts
export interface RelayMachineConfig {
  readonly hostId: string        // tailnet DNS 名，如 gooddemacbook-pro
  readonly target: string        // SSH 目标（IP 或名字）
  readonly port?: number         // SSH 端口，缺省 22
  readonly user?: string         // SSH 用户
  readonly identityFile?: string // 私钥绝对路径
  readonly remotePort: number    // 该机 DSH 的回环端口，如 3081
}

export interface MobileRelayConfig {
  readonly mobileOrigin?: string
  readonly sshKnownHostsPath: string
  readonly statePath: string     // 凭据与端口分配的家目录文件
  readonly machines: readonly RelayMachineConfig[]
}
```

`Config` 用 schemastery 声明：`mobileOrigin` 复用 `MOBILE_ORIGIN_PATTERN`；`machines` 为对象数组，逐项校验 `hostId`/`target` 为非空无空白字符串、`remotePort` 为 1–65535 整数；`sshKnownHostsPath`/`statePath` 为非空字符串。`apply` 开头调用 `assertMobileOrigin`（从 `@threadharbor/dsh-mobile-entry/pair-url` 导入），再做 `hostId` 唯一性与「不含大写字母/尾点/空白」的校验——坏名字装载即失败，不静默跳过。

- [ ] **Step 1: 写失败用例**

`packages/dsh-mobile-relay/tests/load.spec.ts`：用假 ctx（`webServer.register` 收集器、`connection` 假件）调 `apply`——① 合法配置下注册了 hello 与 `/threadharbor/relay/hosts` 两条路由；② `mobileOrigin` 非规范化（如 `https://Example.COM`）时抛错且**未注册任何路由**；③ 两台机器 `hostId` 重复时抛错；④ `hostId` 含大写字母时抛错。

- [ ] **Step 2: 跑用例确认失败**

Run: `npx vitest run packages/dsh-mobile-relay/tests/load.spec.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现骨架**

`src/index.ts` 照 `packages/dsh-mobile-entry/src/index.ts` 的四件套写：`export const name = 'threadharbor-mobile-relay'`、`export const inject = ['webServer', 'connection']`、`export const Config: Schema`、`export function apply(ctx, config?)`。本任务只注册两条路由：静态壳（复用 `registerMobileRoutes`，但传入 `mobileDir` 指向依赖包的 `mobile/` 目录、模式 `hub`，见 Task 9）与 `/threadharbor/relay/hosts` 的占位（返回 `{hosts: []}`，Task 7 填实）。依赖声明：`@deepseek-ai/schemastery`、`@threadharbor/dsh-mobile-entry`、`@threadharbor/dsh-host-federation`（`workspace:^`）。

- [ ] **Step 4: 跑用例确认通过**

Run: `npx vitest run packages/dsh-mobile-relay/tests/load.spec.ts`
Expected: PASS（4 个用例）。

- [ ] **Step 5: 跑全量与类型检查**

Run: `npm run test && npm run typecheck`
Expected: 0 失败；`tests/plugin.spec.ts` 与 `tests/wiring.spec.ts` 都通过（新包已进依赖名单与组合行，装配门禁能找到它）。

- [ ] **Step 6: 提交**

```bash
git add packages/dsh-mobile-relay package.json tsconfig.json tests/plugin.spec.ts cordis.patch.yml pnpm-lock.yaml
git commit -m "feat(relay): 中转插件骨架与装载接线（配置校验 + 组合行）"
```

---

### Task 4: 凭据层（换 cookie、持久化、失效自愈一次）

**文件：**
- 新建：`packages/dsh-mobile-relay/src/credentials.ts`
- 测试：`packages/dsh-mobile-relay/tests/credentials.spec.ts`

**接口：**
- 产出：
  - `export type StoredCredential = { readonly hostId: string; readonly cookie: string; readonly obtainedAt: number }`
  - `export class CredentialStore { constructor(path: string); list(): readonly StoredCredential[]; get(hostId: string): StoredCredential | undefined; put(entry: StoredCredential): void; forget(hostId: string): void }` —— 文件以 `0600` 写、目录 `0700` 创建，内容是 JSON 数组。
  - `export async function exchangeLaunchToken(origin: string, launchUrl: string, fetchLike?: typeof fetch): Promise<{ cookie: string } | { error: string }>` —— `GET <origin>/?token=<令牌>`，从应答的 `set-cookie` 取值；取不到返回 `{error}`，不抛。
  - `export class MachineCredentials { constructor(store: CredentialStore, fetchLike?); async resolve(hostId: string, origin: string, readLaunchUrl: () => Promise<string | undefined>): Promise<{ ok: true; cookie: string } | { ok: false; reason: 'missing-launch-url' | 'no-cookie' | 'unreachable' }> }` —— 有有效 cookie 直接给；没有或 401 时调 `readLaunchUrl` 换一次并记住。

**测试用注入面：** `fetchLike` 与 `readLaunchUrl` 都由测试传假件；状态文件用 `mkdtemp` 临时目录。

- [ ] **Step 1: 写失败用例（覆盖评审重点 4）**

`credentials.spec.ts`：① 已存 cookie 时 `resolve` 不发任何请求直接返回该 cookie；② 无 cookie 时调 `readLaunchUrl` 拿令牌 → `exchangeLaunchToken` → 记住并返回；③ `readLaunchUrl` 返回 `undefined` 时 `resolve` 返回 `{ok:false, reason:'missing-launch-url'}`；④ 交换应答无 `set-cookie` 时返回 `no-cookie`；⑤ 连续两次 401 后调用方应能判脏（用例会断言第二次 `resolve` 会再试一次重换，重换仍失败则返回 `no-cookie`）。

- [ ] **Step 2: 跑用例确认失败**

Run: `npx vitest run packages/dsh-mobile-relay/tests/credentials.spec.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`CredentialStore` 用 `node:fs` 的 `mkdirSync(dir, {recursive:true, mode:0o700})`、`writeFileSync(path, body, {mode:0o600})`、`readFileSync`，JSON 解析失败时当空表（并在注释写明：家目录文件损坏时按「凭据全无」处理，走重新换取，不静默使用半份数据）。`exchangeLaunchToken` 只接受 `https?` 同源 origin，令牌只出现在这一次请求的 URL 里，不进错误消息。`MachineCredentials.resolve` 内部缓存当次进程内的 cookie，`fetchLike` 默认 `globalThis.fetch`。

- [ ] **Step 4: 跑用例确认通过**

Run: `npx vitest run packages/dsh-mobile-relay/tests/credentials.spec.ts`
Expected: PASS（5 个用例）。

- [ ] **Step 5: 跑全量与类型检查**

Run: `npm run test && npm run typecheck`
Expected: 0 失败。

- [ ] **Step 6: 提交**

```bash
git add packages/dsh-mobile-relay/src/credentials.ts packages/dsh-mobile-relay/tests/credentials.spec.ts
git commit -m "feat(relay): 各机凭据换取、持久化与失效自愈（令牌与 cookie 不落日志）"
```

---

### Task 5: SSH 隧道池（本地端口固定分配与持久化）

**文件：**
- 新建：`packages/dsh-mobile-relay/src/tunnels.ts`
- 测试：`packages/dsh-mobile-relay/tests/tunnels.spec.ts`

**接口：**
- 产出：
  - `export type TunnelHandle = { readonly hostId: string; readonly localPort: number; readonly origin: string }`（`origin` = `http://127.0.0.1:<localPort>`）
  - `export class TunnelPool { constructor(statePath: string, deps: { ensureTunnel(config: SshConnectionConfig, remotePort: number): Promise<string>; closeTunnel?(): Promise<void> }, knownHostsPath: string); async ensure(machine: RelayMachineConfig): Promise<{ ok: true; handle: TunnelHandle } | { ok: false; reason: 'fingerprint-unapproved' | 'ssh-failed'; detail: string }>; closeAll(): Promise<void> }`

**行为：** 端口从 41100 起找空闲端口（`net.createServer().listen(0)` 探测可用性，或直接取系统分配端口——实现时选一种并在注释写明），分配结果写进 `statePath` 的 JSON；进程重启后先读回分配，端口不变（评审重点 3）。同一 `hostId` 重复 `ensure` 返回同一 handle，不重复开隧道。`hostKeyFingerprint` 为 `'unapproved'` 时不建隧道，直接返回 `fingerprint-unapproved`。

- [ ] **Step 1: 写失败用例（覆盖评审重点 3）**

`tunnels.spec.ts` 用假 `ensureTunnel`（记录调用次数、返回假 endpoint）：① 首次 `ensure` 分配端口并落盘；② 新建 `TunnelPool` 实例（同 statePath）后 `ensure` 拿到**同一端口**、且假 `ensureTunnel` 被调用次数为 2 次但端口未变（第二次是新进程的正常重建）；③ 同实例内重复 `ensure` 不再调用假隧道；④ `fingerprint` 为 `'unapproved'` 时返回 `fingerprint-unapproved` 且不调用假隧道。

- [ ] **Step 2: 跑用例确认失败**

Run: `npx vitest run packages/dsh-mobile-relay/tests/tunnels.spec.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

用 `ssh2` 之外的既有路径：注入 `deps.ensureTunnel` 由调用方（Task 7 装配处）传 `DshSshManager.ensureTunnel` 的绑定；本文件只管分配、持久化、去重与错误分类。SshConnectionConfig 由 `RelayMachineConfig` 拼 `{target, port, user, identityFile, hostKeyFingerprint}`，指纹从 `knownHostsPath` 对应的 known_hosts 里查（查不到即 `'unapproved'`）。

- [ ] **Step 4: 跑用例确认通过**

Run: `npx vitest run packages/dsh-mobile-relay/tests/tunnels.spec.ts`
Expected: PASS（4 个用例）。

- [ ] **Step 5: 跑全量与类型检查**

Run: `npm run test && npm run typecheck`
Expected: 0 失败。

- [ ] **Step 6: 提交**

```bash
git add packages/dsh-mobile-relay/src/tunnels.ts packages/dsh-mobile-relay/tests/tunnels.spec.ts
git commit -m "feat(relay): SSH 隧道池——本地端口固定分配并随状态持久化"
```

---

### Task 6: 单机客户端（带 cookie 的 RPC 与事件流）

**文件：**
- 新建：`packages/dsh-mobile-relay/src/machine-client.ts`、`packages/dsh-mobile-relay/src/wire.ts`
- 修改：`packages/dsh-mobile-relay/package.json`（加 `ws` 依赖）
- 测试：`packages/dsh-mobile-relay/tests/machine-client.spec.ts`

**接口：**
- 产出：
  - `wire.ts`：`SESSION_LIST_ENDPOINT`/`SESSION_HISTORY_ENDPOINT`/`SESSION_PROMPT_ENDPOINT`/`SESSION_CANCEL_ENDPOINT` = `'session/list'|'session/page'|'session/prompt'|'session/cancel'`，`MUX_PATH = '/api/remote.mux'`，`EVENTS_STREAM_ENDPOINT = '$events'`，`EVENT_RESULT_ENDPOINT = '$events/result'`（与 `packages/dsh-mobile-entry/src/wire.ts` 同值，注释互相指认）
  - `export type RpcResult = { ok: true; value: unknown } | { ok: false; kind: 'unauthorized' | 'rpc-error' | 'transport'; message: string }`
  - `export class MachineClient { constructor(opts: { origin: string; getCookie: () => Promise<{ ok: true; cookie: string } | { ok: false; reason: string }>; fetchLike?: typeof fetch; openSocket?: (url: string, cookie: string) => WireSocket }); async call(endpoint: string, args: Record<string, unknown>): Promise<RpcResult>; onEvent(type: string, listener: (value: unknown) => void): () => void; connect(): void; async answer(eventId: string, outcome: { kind: 'next' } | { kind: 'result'; value?: unknown } | { kind: 'rejected'; error: string }): Promise<{ ok: boolean; message?: string }>; close(): void }`

**行为：** `call` 发 `POST <origin>/api/<endpoint>`，信封 `{type:'client-request', rpcId, method:endpoint, payload:{args}}`，带 `Cookie` 头；HTTP 401 → `{ok:false, kind:'unauthorized'}`（交上层触发重换凭据），`result.ok===true` → `{ok:true, value}`，其余按 `rpc-error`/`transport` 归类。`connect()` 建 WS（`ws` 库，`headers:{Cookie}`），发 open 帧订阅 `$events`；收到 `item` 帧按 `value.type` 派发；`error` 帧派发为 `'error'`；`end` 帧视为断线；断线按 1s→2s→5s→10s 退避重连并重放订阅（阶梯与 `mobile/wire.js` 的 `BACKOFF_STEPS_MS` 同值）。`answer` 走 HTTP `POST <origin>/api/$events/result`，**发与 `call` 相同的完整信封** `{type:'client-request', rpcId, method:'$events/result', payload:{args:{clientId,eventId,outcome}}}`——宿主对每个 `/api/<endpoint>` POST 都先过信封校验且 `method` 须逐字等于路径端点（`reference/deepseek-harness/packages/client/connection/src/rpc-host.ts` 的 `clientRequestSchema`），漏信封会被直接拒；永不 reject。

- [ ] **Step 1: 写失败用例**

`machine-client.spec.ts`：① `call` 的请求 URL/方法/头/信封逐字断言；② 401 → `unauthorized`；③ `result.ok=false` → `rpc-error` 且带宿主消息；④ 假 socket 收 `ready` 帧后 `answer` 用该 `clientId`；⑤ 断线后按退避重连并重发 open 帧（用 `vi.useFakeTimers`）；⑥ `answer` 在 `ready` 之前调用返回 `{ok:false}` 且不发请求。

- [ ] **Step 2: 跑用例确认失败**

Run: `npx vitest run packages/dsh-mobile-relay/tests/machine-client.spec.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`openSocket` 默认实现用 `ws` 的 `new WebSocket(url, {headers:{Cookie: cookie}})`，适配成与手机页同形的最小 socket（`send/close/onopen/onmessage/onclose`）。`ws` 版本用 `^8.21.0`（与 DSH 自身依赖一致，工作区可离线安装），装完更新 `pnpm-lock.yaml`。

- [ ] **Step 4: 跑用例确认通过**

Run: `npx vitest run packages/dsh-mobile-relay/tests/machine-client.spec.ts`
Expected: PASS（6 个用例）。

- [ ] **Step 5: 跑全量与类型检查**

Run: `npm run test && npm run typecheck`
Expected: 0 失败。

- [ ] **Step 6: 提交**

```bash
git add packages/dsh-mobile-relay/src/machine-client.ts packages/dsh-mobile-relay/src/wire.ts packages/dsh-mobile-relay/tests/machine-client.spec.ts packages/dsh-mobile-relay/package.json pnpm-lock.yaml
git commit -m "feat(relay): 单机客户端——带 cookie 的 RPC 与事件流（含退避重连）"
```

---

### Task 7: 主机清单（tailnet 发现 + 隧道内探测）

**文件：**
- 新建：`packages/dsh-mobile-relay/src/hosts.ts`
- 修改：`packages/dsh-mobile-relay/src/index.ts`（把 Task 3 的占位路由换成真实现）
- 测试：`packages/dsh-mobile-relay/tests/hosts.spec.ts`

**接口：**
- 产出：`export const RELAY_HOSTS_PATH = '/threadharbor/relay/hosts'`；`export type RelayHost = { hostId: string; online: boolean; running: boolean; reachable: boolean; credential: 'ok' | 'missing' }`（据实订正：凭据层只有进程内判脏、无持久化失效标记，`stale` 无从判定，硬造一个永远为假的枚举值会被误读成有信息）；`export class HostRegistry { constructor(deps: { tunnels: TunnelPool; credentials: MachineCredentials; run?: TailscaleStatusRun; probeFetch?: ProbeFetch }); async list(): Promise<{ hosts: readonly RelayHost[]; error?: string }>; invalidate(): void }`

**行为：** 查 `queryTailscalePeers(run)` 拿对端（3s 到点按失败处置，折成 `error` 字段）；只保留配置里登记过的 `hostId`（未登记的对端不进清单）；对每台并发 `ensure` 隧道并探 `/threadharbor/mobile/hello`（2s 预算、5s 缓存，形状照 `packages/dsh-mobile-entry/src/peers.ts` 的 `probeDsh`），据探测结果定 `running`；`reachable` 取隧道结果；`credential` 由凭据层当前状态给出。坏名字在 Task 3 装载期已拒，这里不再兜。

- [ ] **Step 1: 写失败用例**

`hosts.spec.ts`：① 假 tailnet 返回 3 个对端、配置只登记 2 台 → 清单 2 台且不含未登记者；② `hello` 探测 200 → `running:true`，超时/非 200 → `false`；③ 隧道失败 → `reachable:false` 且 `running:false`；④ tailscale 查询抛错 → 返回 `{hosts:[], error:'…'}` 且 HTTP 仍 200；⑤ 缓存期内重复 `list()` 不重复打探测（断言假探测调用次数）。

- [ ] **Step 2: 跑用例确认失败**

Run: `npx vitest run packages/dsh-mobile-relay/tests/hosts.spec.ts`
Expected: FAIL。

- [ ] **Step 3: 实现并接进 `index.ts`**

路由先 `connection.admit(req)`（拒绝分支照抄 `pair-url.ts`），只接 GET（其余 405 带 `allow: GET`），应答 JSON 带 `cache-control: no-store` 与 `content-length`。

- [ ] **Step 4: 跑用例确认通过**

Run: `npx vitest run packages/dsh-mobile-relay/tests/hosts.spec.ts`
Expected: PASS（5 个用例）。

- [ ] **Step 5: 跑全量与类型检查**

Run: `npm run test && npm run typecheck`
Expected: 0 失败。

- [ ] **Step 6: 提交**

```bash
git add packages/dsh-mobile-relay/src/hosts.ts packages/dsh-mobile-relay/src/index.ts packages/dsh-mobile-relay/tests/hosts.spec.ts
git commit -m "feat(relay): 主机清单——tailnet 发现 + 隧道内 hello 探测"
```

---

### Task 8: 对手机暴露的转发接口与事件汇流

**文件：**
- 新建：`packages/dsh-mobile-relay/src/hub-routes.ts`、`packages/dsh-mobile-relay/src/relay.ts`
- 修改：`packages/dsh-mobile-relay/src/index.ts`
- 测试：`packages/dsh-mobile-relay/tests/hub-routes.spec.ts`

**接口：**
- 产出路径常量：`RELAY_HOSTS_PATH`（Task 7）、`RELAY_SESSIONS_PATH = '/threadharbor/relay/hosts/'`（prefix，下同）、`RELAY_EVENTS_PATH = '/threadharbor/relay/events'`（WS）
- `export class Relay { constructor(deps: { hosts: HostRegistry; clients: ClientPool; credentials: MachineCredentials }); handleSessions(req, res, url: URL): Promise<void>; handlePrompt(req, res, url: URL): Promise<void>; handleCancel(req, res, url: URL): Promise<void>; handleMessages(req, res, url: URL): Promise<void>; handleAnswer(req, res): Promise<void>; connectEvents(socket, head): void; async start(): Promise<void>; async stop(): Promise<void> }`

**路径解析：** `webServer.register` 只有 `exact` 与 `prefix` 两种匹配（无路径参数），所以 `/threadharbor/relay/hosts/` 用 prefix 注册，在 handler 内用 `new URL(req.url, 'http://relay.invalid').pathname` 拆段：`['hosts', hostId, 'sessions'[, sid[,'messages'|'prompt'|'cancel']]]`；段数或形状不符一律 404 JSON `{"error":"not-found"}`。**hostId 与 sid 在转发前必须按白名单校验**（hostId 必须在配置登记内、sid 必须匹配 `^[\w.:-]{1,128}$`），防止把任意路径拼进上游 URL。

**行为：** 每个 `hostId` 对应一个 `MachineClient`（`ClientPool` 懒建、复用）。事件：手机连 `ws://<relay>/threadharbor/relay/events`（用 `webServer.registerUpgrade`），`Relay` 把各机 `MachineClient` 的事件加上 `hostId` 后广播给所有已连手机；手机断开只摘它自己，不影响上游。`POST /threadharbor/relay/answer` 体为 `{hostId, eventId, outcome}`，转给对应机器的 `answer`（评审重点 1）。所有 HTTP 出口先 `admit`。

- [ ] **Step 1: 写失败用例（覆盖评审重点 1）**

`hub-routes.spec.ts`：① 两台假机器各发一个 `approval/request` → 手机端收到两条且都带 `hostId`；② 对 A 的 `answer` 只落到 A 的假客户端（断言 B 未被调用）；③ `hostId` 不在配置内 → 404；④ `sid` 含 `/../` → 404（不发起上游调用）；⑤ 未准入（admit 返回 `{rejection:401}`）→ 401 且短体 `'unauthorized'`；⑥ 上游 401 → 接口返回 `{error:'credential-stale'}` 并触发该机凭据重换一次。

- [ ] **Step 2: 跑用例确认失败**

Run: `npx vitest run packages/dsh-mobile-relay/tests/hub-routes.spec.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`relay.ts` 持有 `Map<hostId, MachineClient>` 与 `Set<已连手机>`；`start()` 为每台机器建客户端并 `connect()`，`stop()` 全部关闭。WS 帧用与手机页一致的信封：`{type:'item', hostId, value}`（值原样透传 `MachineClient` 派发的 `value`），手机端据此更新对应机器的状态。

- [ ] **Step 4: 跑用例确认通过**

Run: `npx vitest run packages/dsh-mobile-relay/tests/hub-routes.spec.ts`
Expected: PASS（6 个用例）。

- [ ] **Step 5: 跑全量与类型检查**

Run: `npm run test && npm run typecheck`
Expected: 0 失败。

- [ ] **Step 6: 提交**

```bash
git add packages/dsh-mobile-relay/src/hub-routes.ts packages/dsh-mobile-relay/src/relay.ts packages/dsh-mobile-relay/src/index.ts packages/dsh-mobile-relay/tests/hub-routes.spec.ts
git commit -m "feat(relay): 对手机的转发接口与跨机事件汇流（应答按机器归属）"
```

---

### Task 9: 手机页机器维度与双后端

**文件：**
- 新建：`packages/dsh-mobile-entry/mobile/backend-machine.js`、`packages/dsh-mobile-entry/mobile/backend-hub.js` 及其 `.d.ts`
- 修改：`packages/dsh-mobile-entry/mobile/app.js`（接入后端抽象 + `state.machineId` + 机器标识渲染）、`packages/dsh-mobile-entry/mobile/views.js`（会话条目与审批横幅带机器名）、`packages/dsh-mobile-entry/mobile/index.html`（配置占位）、`packages/dsh-mobile-entry/src/static-serve.ts`（index.html 注入模式）、`packages/dsh-mobile-entry/tests/app.spec.ts`（既有直连用例必须原样通过）
- 新增测试：`packages/dsh-mobile-entry/tests/hub-app.spec.ts`
- 修改：`vitest.config.ts`（新用例登记 jsdom）

**接口：**
- `bootApp(root, deps)` 新增可选 `deps.backend`（不传时用 `machineBackend`，与今天行为逐字一致）。后端接口（两种实现同形）：

```js
// backend-machine.js 与 backend-hub.js 都导出 createXxxBackend()
{
  mode: 'machine' | 'hub',
  listHosts(): Promise<{ hosts: Array<{ hostId: string, name: string, running: boolean, reachable?: boolean, online?: boolean }>, error?: string }>,
  listSessions(hostId: string): Promise<{ items: Array<object> } | { error: string }>,
  pageMessages(hostId: string, sessionId: string, throughSeq?: number): Promise<{ conv: object } | { error: string }>,
  prompt(hostId: string, sessionId: string, text: string): Promise<{ ok: boolean, message?: string }>,
  cancel(hostId: string, sessionId: string): Promise<{ ok: boolean, message?: string }>,
  answer(hostId: string, eventId: string, outcome: object): Promise<{ ok: boolean, message?: string }>,
  connectEvents(handlers: { onEvent: (hostId: string, type: string, value: object) => void, onStatus: (state: string, detail: string) => void }): { close(): void },
}
```

`backend-machine` 忽略 `hostId`（直连本机），`backend-hub` 走 `/threadharbor/relay/*` 与 `/threadharbor/relay/events`。`index.html` 里放一行占位 `<script>window.__THREADHARBOR_MOBILE__ = __MOBILE_CONFIG__</script>`，`static-serve.ts` 在返回 index.html 时把它替换成 `{"mode":"machine"}` 或 `{"mode":"hub"}`（中转包传 `mode:'hub'`）。既有导出（`nextScrollTop`、`makeSocketFactory`、`bootApp`）签名不变。

- [ ] **Step 1: 写失败用例**

`hub-app.spec.ts`（jsdom）：① 首屏是机器清单，点某台进入该机会话列表（断言请求 URL 带该 `hostId`）；② 事件带 `hostId` 只更新对应机器的状态；③ **评审重点 2**：从 A 切到 B 后，A 的慢 `pageMessages` 应答不得画到 B 上（用 deferred 应答复现）；④ 审批应答请求体带 `hostId`；⑤ 机器离线时该机行显示离线且进入后显示「最后读到的时间」；⑥ `mode:'machine'` 时首屏行为与今天一致（复用既有 `app.spec.ts` 的入口用例，不重复写）。

- [ ] **Step 2: 跑用例确认失败**

Run: `npx vitest run packages/dsh-mobile-entry/tests/hub-app.spec.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`app.js` 里所有取数据的调用改为走 `state.backend`；新增 `state.machineId`（`null` = 在机器清单屏）；`convGeneration` 递增条件扩展为「打开会话 / 切换机器 / 返回清单 / 重 boot」；会话条目与审批横幅在 hub 模式下显示机器名（views 新增可选 `machineLabel` 字段，缺省不渲染——保证直连模式的 DOM 不变）。中转包的 `registerMobileRoutes` 调用传 `{ mobileDir, mode:'hub' }`。

- [ ] **Step 4: 跑用例确认通过（并确认直连模式无回归）**

Run: `npx vitest run packages/dsh-mobile-entry/tests/hub-app.spec.ts packages/dsh-mobile-entry/tests/app.spec.ts packages/dsh-mobile-entry/tests/views.spec.ts`
Expected: 全部 PASS，既有直连用例一条不改就过（若有失败，说明抽象漏了既有行为，先修抽象）。

- [ ] **Step 5: 跑全量与类型检查**

Run: `npm run test && npm run typecheck`
Expected: 0 失败。

- [ ] **Step 6: 提交**

```bash
git add packages/dsh-mobile-entry/mobile packages/dsh-mobile-entry/src/static-serve.ts packages/dsh-mobile-entry/tests vitest.config.ts
git commit -m "feat(mobile): 手机页机器维度与双后端（直连模式行为不变）"
```

---

### Task 10: 文档与运维脚本

**文件：**
- 修改：`docs/mobile-client.zh.md`、`docs/install.zh.md`、`README.md`
- 新建：`scripts/relay-setup.sh`

**接口：** `scripts/relay-setup.sh --host <tailnet 名> --target <ssh 目标> --remote-port <dsh 端口> [--user <用户>] [--identity <私钥路径>]`；`--help` 只打用法。脚本做三件事：① 校验端口（拒绝前导零形态的 `0[0-9]*`，照 `scripts/mobile-setup.sh` 的既有校验写法）；② 校验 `host` 是不含大写/尾点/空白的合法 tailnet 名；③ 打印要加进云主机 `cordis.patch.yml` 的组合行片段（含 `mobileOrigin`、机器条目、`sshKnownHostsPath`、`statePath`），不代用户改文件。

- [ ] **Step 1: 写失败用例**

`tests/relay-setup.spec.ts`（沿用 `tests/release-scripts.spec.ts` 那种「spawn 脚本再断言输出」的方式；注意 `scripts/mobile-setup.sh` 本身没有自动测试，本任务为新脚本建立首个）：① `--help` 只输出用法不含副作用；② 端口 `099` 被拒（先于任何 SSH 调用）；③ `host` 含大写被拒；④ 合法参数输出含 `- id: threadharbor-mobile-relay` 与 `mobileOrigin:` 的片段。

- [ ] **Step 2: 跑用例确认失败**

Run: `npx vitest run tests/relay-setup.spec.ts`
Expected: FAIL（脚本不存在）。

- [ ] **Step 3: 实现脚本与文档**

文档补三节：云主机通道（为什么手机不需要 Tailscale、数据走 SSH 隧道、tailnet 只做发现）、云主机准备清单（照 Task 1 实测过的事实写，含 Node 版本要求）、手机打不开时的排查三步（VPN 通道占用 → 代理直连规则 → 证书信任）。README 核对时间更新为 2026-10-16。

- [ ] **Step 4: 跑用例确认通过**

Run: `npx vitest run tests/relay-setup.spec.ts && bash -n scripts/relay-setup.sh`
Expected: PASS，语法检查通过。

- [ ] **Step 5: 跑全量与类型检查**

Run: `npm run test && npm run typecheck`
Expected: 0 失败。

- [ ] **Step 6: 提交**

```bash
git add scripts/relay-setup.sh tests/relay-setup.spec.ts docs/mobile-client.zh.md docs/install.zh.md README.md
git commit -m "docs(relay): 云主机通道说明、准备清单与手机侧排查三步"
```

---

### Task 11: 真机验收（云主机 + 手机）

**文件：**
- 新建：`docs/research/2026-10-16-relay-acceptance.md`

**验收项（机器侧可自动验的在此任务里逐条跑并记录证据）：**

1. 云主机插件装载成功，组合行与配置生效（`/threadharbor/mobile/hello` 返回 200）。
2. `/threadharbor/relay/hosts` 返回本机与另一台已登记机器，`running` 均为真。
3. 经隧道取到 cookie 并成功代理一次 `session/list`（真机，非假件）。
4. 事件流在云主机上收到真机 `ready` 帧；造一次真审批（用本机另一个会话触发需批准的操作），手机侧能应答。
5. 云主机重启后：端口分配不变、cookie 复用、无需人工干预（V3 等价项）。
6. 停掉某台机器的 DSH：该机在清单显示离线，历史标注最后读取时间，其他机器不受影响。

**手机侧（人工，与用户一起做，写成可抄的清单）：** 公网域名首访无证书警告 → 扫云主机桌面面板的码配对 → 机器清单 → 进会话 → 读历史 → 发消息 → 批权限（桌面同时开着，验证先到先得与「已在别处处理」）→ 停回合 → 切另一台机器 → 断网/重连。清单按上表的编号组织，每步写明「预期看到什么」。

- [ ] **Step 1: 逐条跑机器侧验收并记录**

每条一行：编号、结论（通过/不通过）、证据来源（命令与关键输出，不含凭据原文）、核对时间。

- [ ] **Step 2: 与用户一起走手机侧清单，把真实结果补进文档**

未做的人工项明确标「待用户」，不要写成通过。

- [ ] **Step 3: 跑全量与类型检查**

Run: `npm run test && npm run typecheck`
Expected: 0 失败。

- [ ] **Step 4: 提交**

```bash
git add docs/research/2026-10-16-relay-acceptance.md
git commit -m "docs(relay): 真机验收记录与手机侧走查清单"
```

---

## 自查记录

- **设计覆盖：** 设计文档 §2 的十条决策分别落在 Task 1（D2/D10 的可行性）、3–8（D3/D4/D9 的实现）、9（D3 的页面形态）、10（D5/D6 的运维与文档）。§5 的凭据生命周期在 Task 4，§6 清单在 Task 7，§8 页面改动在 Task 9，§9 安全姿态在 Task 3/4/8（不落日志、路径白名单、admit 优先），§11 准备清单在 Task 1/10，§12 失败矩阵在 Task 4/5/7/8 的错误分类，§14 风险在 Task 1（SSH 承重）与 Task 5（端口绑定）。
- **步骤粒度：** 每个代码步骤给出确切文件、确切签名与确切取值；测试步骤给出用例名与断言内容；没有「处理边界情况」这类空话。
- **类型一致：** `RelayMachineConfig`/`MobileRelayConfig` 只在 Task 3 定义，Task 5/7/8 引用；`TunnelHandle`、`RelayHost`、`RpcResult`、`MachineClient`、`CredentialStore` 各自只定义一次。
- **评审重点：** 五条分别对应 Task 8（应答归属）、Task 9（机器切换残留）、Task 5（端口漂移）、Task 4（凭据自愈）、Task 3（首访信任），每条都有指定用例。
- **比例：** 计划比设计文档长，但每个任务都带可独立测试的交付物，没有把实现代码抄进计划。
