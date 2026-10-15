# 主机状态模型 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把主机的「装没装 / 起没起 / 现在能不能打开」从猜测改成从对方机器读回来的事实，并让每个状态配上前台真正需要的按钮。

**Architecture:** 三层。纯函数层（`host-state.ts`）只做「事实 → 状态词 + 按钮」推导，不碰 DOM；主机侧 SSH 层在现有读取里并入一次存活探测，另加一个「启动对方 DSH」的写动作；界面层消费前两层，负责取事实与渲染。Tailscale 选择器改填 SSH 目标，主机地址改由部署/连接结果写入。

**Tech Stack:** TypeScript（strict）、React 18、vitest、cordis 插件（本仓 `packages/dsh-host-federation` 与 `packages/dsh-client`）

**Spec:** [docs/superpowers/specs/2026-10-15-host-state-model-design.md](../specs/2026-10-15-host-state-model-design.md)

## Global Constraints

- **双语硬门禁。** 每个 locale key 必须有 zh 与 en 两份，且 `fallbackT` 逐字节保真。门禁测试：`packages/dsh-client/tests/panel-locale.spec.ts`、`runtime-locale.spec.ts`、`ui-i18n.spec.ts`——加 key 忘了加英文会在这些测试里红。
- **界面不硬编码中文文案。** `ui-i18n.spec.ts` 会扫源码里的中文字面量。
- **主机密钥 fail-closed 不放松。** 指纹不匹配仍然读不到对方；不为「自动读取」放宽。
- **远端 DSH 始终绑 `127.0.0.1`。** `packages/dsh-host-federation/tests/ssh-manager.spec.ts` 断言安装脚本含 `bind_host="127.0.0.1"` 且**不含** `tailscale ip`——本计划的任何脚本改动都不得破坏这两条。
- **不新增常驻服务、不新增鉴权体系。** 新动作一律走现有 `/api/threadharbor.host-ssh.*` POST 路由与现有 session cookie。
- **跨包无需先构建。** `@threadharbor/dsh-host-federation` 的 `exports` 直指 `./src/index.ts`，改完源码直接跑测试即可。
- **命令。** 单文件：`pnpm vitest run <path>`；全量：`pnpm test`；类型：`pnpm typecheck`。

## Review Focus

规格是愿景文档，它的沉默不是许可——以下五种情况规格没逐条写死，但真机上最可能咬人，各自由对应 Task 的测试钉住：

1. **对方 DSH 要 token，401/403 也是「在跑」。** 把它当成没跑，会让一台好主机显示成「未启动」并给出「启动对方 DSH」按钮 → Task 3。
2. **密码认证的主机永远读不到对方状态。** 不显式说明，这些主机会静默停在「未知」，比今天更让人困惑 → Task 6。
3. **慢网络下读取超时。** 报「未启动」的后果远重于报「未知」 → Task 3。
4. **部署脚本重构丢分支。** systemd 分支或 nohup 分支任一丢失，新机器就部署不了 → Task 4。
5. **主机密钥变更。** 自动读取不得成为放宽 fail-closed 的借口 → Task 3。

## File Structure

**新建**

| 文件 | 职责 |
|---|---|
| `packages/dsh-client/src/host-state.ts` | 纯函数：事实 → 状态词、状态 → 按钮。不碰 DOM、不发请求、不读时钟 |
| `packages/dsh-client/tests/host-state.spec.ts` | 上表的完整推导表 + 按钮表 |
| `packages/dsh-host-federation/src/remote-report.ts` | `RemoteReport` 线上的形状与解析 |
| `packages/dsh-host-federation/tests/remote-report.spec.ts` | 解析的宽容/严格边界 |
| `packages/dsh-host-federation/src/ssh/liveness.ts` | 存活探测脚本生成 + 回答归类 + 读数决策 |
| `packages/dsh-host-federation/tests/liveness.spec.ts` | 四类回答的归类 |
| `packages/dsh-host-federation/src/ssh/start-script.ts` | 部署脚本的公共片段与启动片段 |

**修改**

| 文件 | 改什么 |
|---|---|
| `packages/dsh-host-federation/src/ssh/manager.ts` | `readPeer` 并入探测；`buildInstallScript` 改为拼装片段；新增 `startPeer` |
| `packages/dsh-host-federation/src/ssh-deploy.ts` | `ROUTE_PEER` 返回读数；新增 `ROUTE_START` |
| `packages/dsh-host-federation/src/registry.ts` | `HostRegistration.remote`；新增 `recordRemote` |
| `packages/dsh-host-federation/src/index.ts` | 导出 `RemoteReport` 及其解析 |
| `packages/dsh-client/src/ssh-deploy.ts` | `readRemotePeer` 返回类型；新增 `startRemotePeer` |
| `packages/dsh-client/src/panel.tsx` | 状态词与按钮表；选择器改接线；合并两个可达性按钮 |
| `packages/dsh-client/src/reach.ts` | 不可达原因写出实际检测目标与端口 |
| `packages/dsh-client/src/locales.ts` | 新增 zh/en 键 |
| `packages/dsh-client/src/host-roll-up.ts` | 「未部署」改用真读数 |
| `packages/dsh-client/tests/panel-interact.spec.ts` | 状态接线与选择器接线 |
| `docs/ssh-deploy.zh.md` | 状态与按钮一节 |

---

### Task 1: 状态推导纯函数

**Files:**
- Create: `packages/dsh-client/src/host-state.ts`
- Test: `packages/dsh-client/tests/host-state.spec.ts`

**Interfaces:**
- Consumes: 无（第一个任务）
- Produces:
  ```ts
  export type HostReach = 'unchecked' | 'checking' | 'reachable' | 'unreachable'
  export type HostFacts = {
    readonly self: boolean
    readonly readable: boolean
    readonly deployment: RemoteDeployment   // 来自 '@threadharbor/dsh-host-federation'，本任务先就地声明，Task 2 改为转出
    readonly liveness: RemoteLiveness
    readonly reach: HostReach
    readonly reported: boolean
  }
  export type HostStatus = 'self' | 'reading' | 'undeployed' | 'stopped'
    | 'connected' | 'reachable' | 'disconnected' | 'unchecked' | 'unknown'
  export type HostAction = 'deploy' | 'read-peer' | 'start-peer' | 'redeploy'
    | 'open-page' | 'connect-open' | 'check-reach' | 'fill-ssh' | 'retry-read'
  export function hostStatus(facts: HostFacts, reading: boolean): HostStatus
  export function hostActions(status: HostStatus): readonly HostAction[]
  ```

- [ ] **Step 1: 写失败的测试**

`packages/dsh-client/tests/host-state.spec.ts`，用一个 `facts(overrides)` 辅助函数造事实，断言规格 §4.2 的推导表：

- `self 为真时是 self`（其余事实任意）
- `正在读时是 reading`，即使 `deployment` 已读到未部署
- `读到没装是 undeployed`
- `装了但对方没应答是 stopped`
- `对方在跑、打得开、对方回连了是 connected`
- `对方在跑、打得开、没回连是 reachable`
- `对方在跑、本机打不开是 disconnected`
- `对方在跑、reach 为 unchecked 是 unchecked`；`reach 为 checking` 同样断言 `unchecked`
- `可读但读不出来是 unknown`（`readable: true, deployment: 'unknown'`）
- `直连主机不显示 unknown`（`readable: false, deployment: 'unknown', liveness: 'unknown', reach: 'reachable'` → `reachable`；`reach: 'unreachable'` → `disconnected`）

再加一组 `hostActions` 的按钮表断言，逐状态比对数组：

```
self → []
reading → []
undeployed → ['deploy', 'read-peer']
stopped → ['start-peer', 'redeploy']
connected → ['open-page', 'check-reach']
reachable → ['connect-open', 'check-reach']
disconnected → ['connect-open', 'check-reach']
unchecked → ['check-reach', 'connect-open']
unknown → ['fill-ssh', 'retry-read']
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/dsh-client/tests/host-state.spec.ts`
Expected: FAIL — `Cannot find module '../src/host-state.ts'`

- [ ] **Step 3: 实现 `host-state.ts`**

推导顺序固定为：`self` → `reading` → `readable === false` 直接落到按 `reach` 分支 → `deployment` 为 `undeployed` → 为 `unknown` → 为 `deployed` 时按 `liveness` 与 `reach` 分支。

按 `reach` 分支的规则（`readable === false` 的直连主机走这里）：
`reachable && reported` → `connected`；`reachable` → `reachable`；`unreachable` → `disconnected`；`unchecked | checking` → `unchecked`。

`hostActions` 是一个查表，每个状态一个数组，顺序即主按钮在前。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/dsh-client/tests/host-state.spec.ts`
Expected: PASS，全部 19 个用例

- [ ] **Step 5: 提交**

```bash
git add packages/dsh-client/src/host-state.ts packages/dsh-client/tests/host-state.spec.ts
git commit -m "feat(client): 主机状态推导纯函数（事实 → 状态词 + 按钮表）"
```

---

### Task 2: 读数的线上形状与登记簿存储

**Files:**
- Create: `packages/dsh-host-federation/src/remote-report.ts`
- Create: `packages/dsh-host-federation/tests/remote-report.spec.ts`
- Modify: `packages/dsh-host-federation/src/registry.ts`（`HostRegistration` 加字段、`parseEntry` 读它、`hostRegistry` 加 `recordRemote`）
- Modify: `packages/dsh-host-federation/src/index.ts`（导出）

**Interfaces:**
- Consumes: Task 1 的 `HostFacts.deployment` / `HostFacts.liveness`
- Produces:
  ```ts
  // remote-report.ts
  export type RemoteDeployment = 'undeployed' | 'deployed' | 'unknown'
  export type RemoteLiveness = 'stopped' | 'running' | 'unknown'
  export type RemoteReport = {
    readonly deployment: RemoteDeployment
    readonly liveness: RemoteLiveness
    readonly livenessNote?: string
    readonly port?: number
    readonly launchUrl?: string
    readonly readAt: number
  }
  export function parseRemoteReport(value: unknown): RemoteReport | undefined

  // registry.ts
  // HostRegistration 新增 readonly remote?: RemoteReport
  // hostRegistry(storage, now) 返回值新增：
  recordRemote(hostId: string, report: RemoteReport): boolean
  ```
- Task 1 之后要做：`packages/dsh-client/src/host-state.ts` 的 `HostDeployment` / `HostLiveness` 改为从 `@threadharbor/dsh-host-federation` 转出同名别名，删掉本地的联合类型声明。

- [ ] **Step 1: 写失败的测试**

`remote-report.spec.ts`：
- `parseRemoteReport` 读出完整形状
- `deployment` 不是三个取值之一时读成 `unknown`（宽容，不丢整条）
- `liveness` 同上
- `port` 非 1–65535 整数时丢弃该字段
- `readAt` 不是有限数字时整条返回 `undefined`
- 非对象、非数组的输入返回 `undefined`

在 `packages/dsh-host-federation/tests/registry.spec.ts` 追加：
- `recordRemote` 写入后 `list()` 能读回同一个 `remote`
- 对不存在的 `hostId` 返回 `false` 且不写
- 写入后 `address` / `launchUrl` / `ssh` / `createdAt` 一个都不变
- `parseRemoteReport` 返回 `undefined` 的值不写入，原条目仍在
- 旧条目（JSON 里没有 `remote` 键）读出时 `remote` 为 `undefined`，不报错

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/dsh-host-federation/tests/remote-report.spec.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

`remote-report.ts` 只放类型与解析，不含 node 内建模块（要进浏览器 bundle 的根入口）。
`recordRemote` 的实现读出全部条目、找到 hostId、替换其 `remote`、写回，找不到返回 `false`；解析失败直接返回 `false` 不写。
`index.ts` 按现有注释的规矩加两行导出（同 `tailscale-keys.ts` 的纯模块先例）。

同时把 `host-state.ts` 的两个联合类型改成转出。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/dsh-host-federation/tests/remote-report.spec.ts packages/dsh-client/tests/host-state.spec.ts`
Expected: PASS

- [ ] **Step 5: 全量 + 类型**

Run: `pnpm test && pnpm typecheck`
Expected: 全绿

- [ ] **Step 6: 提交**

```bash
git add packages/dsh-host-federation/src/remote-report.ts packages/dsh-host-federation/src/index.ts packages/dsh-host-federation/src/registry.ts packages/dsh-host-federation/tests/remote-report.spec.ts packages/dsh-client/src/host-state.ts
git commit -m "feat(federation): RemoteReport 线上的形状 + 登记簿 recordRemote 存储读数"
```

---

### Task 3: 存活探测并入 SSH 读取

**Files:**
- Create: `packages/dsh-host-federation/src/ssh/liveness.ts`
- Create: `packages/dsh-host-federation/tests/liveness.spec.ts`
- Modify: `packages/dsh-host-federation/src/ssh/manager.ts`（`readPeer`）
- Modify: `packages/dsh-host-federation/src/ssh-deploy.ts`（`ROUTE_PEER` 返回值）
- Modify: `packages/dsh-client/src/ssh-deploy.ts`（`readRemotePeer` 返回类型）

**Interfaces:**
- Consumes: Task 2 的 `RemoteDeployment` / `RemoteLiveness`
- Produces:
  ```ts
  // ssh/liveness.ts
  export type Liveness = 'running' | 'stopped' | 'unknown'
  export type PeerReport = PeerStatus & {
    readonly liveness: Liveness
    readonly livenessNote?: string
  }
  export function buildLivenessProbe(port: number): string
  export function classifyLiveness(probe: { readonly code: number; readonly stdout: string }): {
    readonly liveness: Liveness
    readonly note?: string
  }
  export function decidePeerReport(
    peer: PeerStatus,
    probe: { readonly code: number; readonly stdout: string } | undefined,
  ): PeerReport
  ```
- 客户端 `readRemotePeer` 返回类型从 `PeerStatus` 改为 `PeerReport`。`parsePeerStatus` 不动。

- [ ] **Step 1: 写失败的测试**

`liveness.spec.ts`：

`classifyLiveness`：
- `curl 退出 0（200）是 running`
- `curl 退出 0（401）也是 running` —— **Review Focus 第 1 条**
- `curl 退出 7（连不上）是 stopped`
- `curl 退出 28（超时）是 unknown 且 note 含 28` —— **Review Focus 第 3 条**
- 远端直接打印 `UNKNOWN` 时是 `unknown`

`buildLivenessProbe`（对返回的脚本文本做断言）：
- 含 `127.0.0.1` 与传入的端口
- 先试 `curl`，再退 `node`，都没有时打印 `UNKNOWN`
- 不含 `tailscale`

`decidePeerReport`：
- `pluginsInstalled 为假时是 undeployed 且 liveness unknown，probe 给什么都一样`
- `装了但记录里没有 port 时是 deployed + unknown，note 说明没有端口`
- 其余走 `classifyLiveness`

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/dsh-host-federation/tests/liveness.spec.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 `liveness.ts` 与 `readPeer`**

`buildLivenessProbe(port)` 返回一段 `set -eu` 之后可直接跑的 shell：有 `curl` 就
`curl -sS -m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:<port>/` 并按退出码打印
`RUNNING` / `STOPPED`；没有 `curl` 但有 `node` 就用 node 的 http 模块做同样的事；
两者皆无打印 `UNKNOWN`。

`classifyLiveness` **按退出码而非 HTTP 状态码归类**：退出 0 即 running（任何应答，
含 401/403）；退出 7 为 stopped；其余为 unknown 并把退出码写进 note。

`manager.readPeer` 在读记录文件之后、仍在同一次 SSH 连接里跑 `buildLivenessProbe(peer.port)`，
把 `{code, stdout}` 交给 `decidePeerReport`。记录文件不存在时不跑探测。指纹校验与
fail-closed 逻辑一字不改。

**读取总预算 8 秒**（规格 §6.4）：走 `manager` 既有的 `handshakeBudgetMs()`，在该值
大于 8000 时传 8000 进去。到点按 `liveness: 'unknown'` + note「读取超时」处置，
绝不返回 `stopped`——**Review Focus 第 3 条**。

`ROUTE_PEER` 返回 `decidePeerReport` 的结果；客户端 `readRemotePeer` 的返回类型改为
`PeerReport`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/dsh-host-federation/tests/liveness.spec.ts packages/dsh-host-federation/tests/ssh-manager.spec.ts`
Expected: PASS —— `ssh-manager.spec.ts` 现有的 fail-closed 断言与脚本断言一并通过

- [ ] **Step 5: 全量 + 类型**

Run: `pnpm test && pnpm typecheck`
Expected: 全绿

- [ ] **Step 6: 提交**

```bash
git add packages/dsh-host-federation/src/ssh/liveness.ts packages/dsh-host-federation/src/ssh/manager.ts packages/dsh-host-federation/src/ssh-deploy.ts packages/dsh-client/src/ssh-deploy.ts packages/dsh-host-federation/tests/liveness.spec.ts
git commit -m "feat(federation): SSH 读取并入存活探测，读数含 running/stopped/unknown"
```

---

### Task 4: 部署脚本公共片段抽取（纯重构，无行为变化）

**Files:**
- Create: `packages/dsh-host-federation/src/ssh/start-script.ts`
- Create: `packages/dsh-host-federation/tests/start-script.spec.ts`
- Modify: `packages/dsh-host-federation/src/ssh/manager.ts`（`buildInstallScript` 改为拼装）

**Interfaces:**
- Consumes: 无
- Produces:
  ```ts
  export function buildRemoteEnv(input: {
    readonly channel: string
    readonly nodePath: string
    readonly remotePort: number
    readonly hostId: string
    readonly hostTitle: string
    readonly remoteAgentsPatch: string
  }): string   // 路径、PATH、身份文件、systemd unit、health_url / port_pids / port_busy / launch_url_from_log

  export function buildStartBranch(input: {
    readonly channel: string
    readonly remotePort: number
  }): string   // if systemctl … else nohup … fi + 健康等待，末尾 printf 'STARTED_OK\n'

  export function buildStartScript(input: {
    readonly channel: string
    readonly nodePath: string
    readonly remotePort: number
    readonly hostId: string
    readonly hostTitle: string
    readonly remoteAgentsPatch: string
  }): string   // buildRemoteEnv + buildStartBranch
  ```
- 本任务**不**改任何外部可见行为；`buildInstallScript` 的产出应当与重构前逐行等价。

- [ ] **Step 1: 写失败的测试**

`start-script.spec.ts`：
- `buildStartScript 含 systemd 分支`（含 `systemctl --user enable --now`）
- `buildStartScript 含 nohup 分支`（含 `nohup` 与 `dsh-web.pid`）
- `buildStartScript 以端口有应答为成功`（含健康等待循环，含 `STARTED_OK`）
- `buildStartScript 绑 127.0.0.1` —— **Review Focus 第 4 条**，断言含 `bind_host="127.0.0.1"` 且不含 `tailscale ip`
- `buildStartScript 不重装插件`（不含 `dsh plugin` 与 `npm install -g`）
- `buildStartScript 写 systemd unit`（含 `threadharbor-dsh-web` 与 `--profile web`）

在 `ssh-manager.spec.ts` 追加源码断言：
- `安装脚本仍然同时含 systemd 与 nohup 两个分支`（读 `manager.ts` 源码断言 `buildInstallScript` 拼装了两者）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/dsh-host-federation/tests/start-script.spec.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

把 `manager.ts` 里 `buildInstallScript` 的 shell 行按职责切成三段搬进 `start-script.ts`：
公共环境（`dsh_home` / `state` / `log_file` / PATH / `identity_file` / `agents_patch` /
`dsh_bin` / `dsh_args` / `bind_host` / `service_name` / `service` / `health_url` /
`port_pids` / `port_busy` / `launch_url_from_log`）进 `buildRemoteEnv`；启动分支
（systemd 优先、否则 nohup）与健康等待进 `buildStartBranch`。

`buildInstallScript` 改成 `[buildRemoteEnv(...), …安装那几行…, buildStartBranch(...), emit_success 那几行…].join('; ')`，
**变的只有拼装方式，产出的脚本文本保持等价**。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/dsh-host-federation/tests/start-script.spec.ts packages/dsh-host-federation/tests/ssh-manager.spec.ts`
Expected: PASS —— 现有 13 行安装脚本断言一条都不能少

- [ ] **Step 5: 提交**

```bash
git add packages/dsh-host-federation/src/ssh/start-script.ts packages/dsh-host-federation/src/ssh/manager.ts packages/dsh-host-federation/tests/start-script.spec.ts packages/dsh-host-federation/tests/ssh-manager.spec.ts
git commit -m "refactor(federation): 抽出部署脚本的环境片段与启动片段（行为不变）"
```

---

### Task 5: 「启动对方 DSH」动作

**Files:**
- Modify: `packages/dsh-host-federation/src/ssh/manager.ts`（新增 `startPeer`）
- Modify: `packages/dsh-host-federation/src/ssh-deploy.ts`（新增 `ROUTE_START` 与路由注册）
- Modify: `packages/dsh-client/src/ssh-deploy.ts`（新增 `ROUTE_START` 常量与 `startRemotePeer`）
- Test: `packages/dsh-host-federation/tests/ssh-manager.spec.ts`、`packages/dsh-client/tests/ssh-client.spec.ts`

**Interfaces:**
- Consumes: Task 4 的 `buildStartScript`
- Produces:
  ```ts
  // host-federation/src/ssh-deploy.ts
  export const ROUTE_START = '/api/threadharbor.host-ssh.start'

  // ssh/manager.ts
  startPeer(config: SshConnectionConfig, port: number): Promise<
    { readonly ok: true; readonly port: number } | { readonly ok: false; readonly reason: string }
  >

  // dsh-client/src/ssh-deploy.ts
  export const ROUTE_START = '/api/threadharbor.host-ssh.start'
  export async function startRemotePeer(
    ssh: SshConnectionInput & { readonly hostKeyFingerprint: string },
    port: number,
    t?: RuntimeT,
  ): Promise<ApiResult<{ readonly port: number }>>
  ```

- [ ] **Step 1: 写失败的测试**

`ssh-manager.spec.ts` 追加源码断言：
- `startPeer 用已有的指纹校验`（`manager.ts` 源码含 `startPeer`，且它调用 `readPeer` 的同一套 scan/persistKnownHost 路径——断言 `startPeer` 源码片段内含 `hostKeyFingerprint` 校验文案）

新增 `packages/dsh-client/tests/ssh-client.spec.ts` 里的用例（沿用该文件已有的 `stubFetchOnce` 辅助）：
- `宿主与客户端的 ROUTE_START 常量是同一字符串`（各自 import 后比对，防两边写歪）
- `startRemotePeer 走 POST 且 body 带 ssh 与 port`：断言 `call[0]` 是 `/api/threadharbor.host-ssh.start`，`JSON.parse(body)` 等于 `{ ssh: {...}, port: 3081 }`

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/dsh-client/tests/ssh-client.spec.ts`
Expected: FAIL — `ROUTE_START` / `startRemotePeer` 未导出

- [ ] **Step 3: 实现**

`manager.startPeer(config, port)`：先跑一遍与 `readPeer` 相同的 scan + 指纹比对（**Review Focus 第 5 条**，不放宽），再执行 `buildStartScript(...)`。执行完成后读 stdout：含 `STARTED_OK` 即 `ok: true`，否则 `ok: false` 且 `reason` 带上远端 stderr 原文。**成功判据是端口有应答，不是 kill 成功**（规格 §7，macOS 的 pid 文件可能是陈旧的）。

`ROUTE_START` 用现有的 `register` 辅助函数注册（自动获得 JSON body 解析、错误转 400 的行为）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/dsh-client/tests/ssh-client.spec.ts packages/dsh-host-federation/tests/ssh-manager.spec.ts`
Expected: PASS

- [ ] **Step 5: 全量 + 类型 + 提交**

Run: `pnpm test && pnpm typecheck`
Expected: 全绿

```bash
git add packages/dsh-host-federation/src/ssh/manager.ts packages/dsh-host-federation/src/ssh-deploy.ts packages/dsh-client/src/ssh-deploy.ts packages/dsh-client/tests/ssh-client.spec.ts packages/dsh-host-federation/tests/ssh-manager.spec.ts
git commit -m "feat(federation): 新增「启动对方 DSH」动作（复用启动片段，成功以端口应答为准）"
```

---

### Task 6: 面板接线——状态词与按钮表

**Files:**
- Modify: `packages/dsh-client/src/panel.tsx`（`AgentPanelProps` 加 `remote`、`HostRow`、详情页按钮、合并两个可达性按钮）
- Modify: `packages/dsh-client/src/locales.ts`
- Modify: `packages/dsh-client/src/client/index.ts`（把真实的 read/start 接进 `remote` 端口）
- Test: `packages/dsh-client/tests/panel-interact.spec.ts`、`panel-locale.spec.ts`

**Interfaces:**
- Consumes: Task 1 的 `hostStatus` / `hostActions`，Task 2 的 `recordRemote`，Task 3 的 `readRemotePeer`，Task 5 的 `startRemotePeer`
- Produces（`panel.tsx` 新导出）：
  ```ts
  export type RemoteReadResult = { readonly ok: true; readonly report: PeerReport }
    | { readonly ok: false; readonly error: string }
  export type RemoteStartResult = { readonly ok: true; readonly port: number }
    | { readonly ok: false; readonly error: string }
  export type RemotePort = {
    read(ssh: SshConnectionInput & { readonly hostKeyFingerprint: string }): Promise<RemoteReadResult>
    start(ssh: SshConnectionInput & { readonly hostKeyFingerprint: string }, port: number): Promise<RemoteStartResult>
  }
  // AgentPanelProps 新增 readonly remote?: RemotePort
  ```
- 新增 locale key（zh / en 必须成对，`panel-locale.spec.ts` 会逐个查）：

  | key | zh |
  |---|---|
  | `panel.status.undeployed` | 未部署 |
  | `panel.status.stopped` | 未启动 |
  | `panel.status.unknown` | 未知 |
  | `panel.status.unchecked` | 未验证 |
  | `panel.button.readPeer` | 读一次对方状态 |
  | `panel.button.startPeer` | 启动对方 DSH |
  | `panel.button.redeploy` | 重新部署 |
  | `panel.button.checkReach` | 检查能否打开 |
  | `panel.button.retryRead` | 重试读取 |
  | `panel.facts.deployment` | 部署 |
  | `panel.facts.liveness` | 运行 |
  | `panel.facts.entry` | 本机入口 |
  | `panel.facts.reported` | 对方回连 |
  | `panel.facts.readAt` | 读到的时刻 |
  | `panel.notes.readFailed` | 这次没读到：{reason} |
  | `panel.notes.lastRead` | 上次读到的是：{summary}（{at}） |
  | `panel.notes.passwordAuth` | 这台主机用密码认证，凭据不保存，读不了对方状态 |
  | `panel.button.approveAndRead` | 批准并读取 |
  | `panel.button.keyNotApproved` | 还没批准这台机器的主机密钥 |

  「读取中」复用已有的 `panel.status.checking`；「已连接」「可达」「未连接」「本机」分别复用 `panel.status.connected` / `reachableUnsynced` / `offline` / `self`。

- [ ] **Step 1: 写失败的测试**

在 `panel-interact.spec.ts` 加一个带原型的 `FakeRemote`（照 `FakeTailscale` 的写法），并在 `mountPanel` 的 props 里接上。用 `makeRegistry` 播种一台登记、再用 `recordRemote` 写读数。断言：

- `部署态未部署时详情页状态词是未部署且有部署按钮`：`data-action="deploy"` 存在，`data-action="start-peer"` 不存在
- `运行态未启动时详情页是启动对方 DSH 按钮`：`data-action="start-peer"` 存在，`data-action="deploy"` 不存在
- `隧道在线时详情页是打开页面按钮`：`data-action="open-page"` 存在
- `读失败时保留上次读数`：`FakeRemote.read` 返回 `{ok:false}`，页面上同时出现 `panel.notes.readFailed` 文案与 `panel.notes.lastRead` 文案（**规格 §6.3**）
- `点刷新对方状态会用已保存的 SSH 凭据去读`：断言 `FakeRemote` 记下的 `ssh` 里 `identityFile` 与 `hostKeyFingerprint` 来自登记
- `密码认证的主机明说读不了`：`FakeRemote.read` 返回错误，页面出现 `panel.notes.passwordAuth`（**Review Focus 第 2 条**）
- `没批准主机密钥时给的是批准并读取`：登记里 `ssh.hostKeyFingerprint` 为 `'unapproved'` 时，详情页出现 `data-action="approve-and-read"` 而**不是** `data-action="retry-read"`；点它先调 inspect 再调 read（规格 §5.2）
- `主机行只有状态词和刷新按钮`：列表行里不出现 `open-page` / `connect-open` / `check-reach`

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/dsh-client/tests/panel-interact.spec.ts`
Expected: FAIL — `data-action="start-peer"` 等断言不成立

- [ ] **Step 3: 实现**

面板里新增 `const [remoteReports, setRemoteReports] = useState<ReadonlyMap<string, HostFacts>>()` 之类的读取态，`reaches` 的既有语义保持不变（它喂的是 `reach`）。

进入详情页时：若 `storedSshInput(registration.ssh)` 有值则调 `props.remote.read(...)`，成功则 `registry.recordRemote(hostId, {…report, readAt: Date.now()})` 并刷新列表；失败则保留旧读数并把错误挂到该主机上。

`HostListRow` 的 `connection` 改为由 `hostStatus(facts, reading)` 推出，替换掉 `deriveHostConnection`；`connectionStatusLabel` 改为查 `HostStatus → locale key`。

详情页按钮按 `hostActions(status)` 渲染；**「检测可达」与「检查隧道」合并为 `check-reach`**，两者都用 `startReach(registration)`（它问的就是登记里那个地址）。

指纹为 `'unapproved'` 的登记不进入自动读取，状态词为 `unknown`，主按钮渲染
`approve-and-read`：点击时先走既有 `inspectSshHost`，让操作者认完指纹再自动接着读
（规格 §5.2）。这条路径复用现有 `SshDeploySection` 的密钥批准交互，不新增第二套。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/dsh-client/tests/panel-interact.spec.ts packages/dsh-client/tests/panel-locale.spec.ts packages/dsh-client/tests/runtime-locale.spec.ts packages/dsh-client/tests/ui-i18n.spec.ts`
Expected: PASS

- [ ] **Step 5: 全量 + 类型 + 提交**

Run: `pnpm test && pnpm typecheck`
Expected: 全绿

```bash
git add packages/dsh-client/src/panel.tsx packages/dsh-client/src/locales.ts packages/dsh-client/src/client/index.ts packages/dsh-client/tests/panel-interact.spec.ts packages/dsh-client/tests/panel-locale.spec.ts
git commit -m "feat(client): 面板按新状态模型渲染状态词与按钮，合并两个可达性按钮"
```

---

### Task 7: Tailscale 选择器改接线

**Files:**
- Modify: `packages/dsh-client/src/panel.tsx`（`pickPeer`、`HostFormPage` 的 SSH 目标输入、`addMode` 切换）
- Test: `packages/dsh-client/tests/panel-interact.spec.ts`

**Interfaces:**
- Consumes: Task 6 的 `AgentPanelProps.remote`（本任务不用，只是上下文）
- Produces: `AgentPanel` 里新增 `sshTargetDraft` state，作为 `SshDeploySection` 的 SSH 目标初值来源

- [ ] **Step 1: 写失败的测试**

改写 `panel-interact.spec.ts` 里现有的「从 Tailscale 选」用例（它现在断言 `address: 'http://100.101.1.7'`，正是要废掉的行为），并补：

- `选中一台只填名称与 SSH 目标，地址栏留空`：选 `bench.tail-scale.ts.net` 后，`data-form-field-id` 的值是 `bench.tail-scale.ts.net`，`data-ssh-target` 的值是 `100.101.1.7`，`data-form-field-address` 的值为空串
- `添加页选中后自动切到 SSH 部署区`：断言 `[data-ssh-deploy]` 存在且 `data-ssh-target` 已带值
- `详情页选中不改已登记的地址`：登记里 `address` 前后一致
- `手填地址的路径不受影响`：不选 Tailscale、直接填 IP 并确定，登记的地址仍是 `http://100.101.1.7`（照搬现有断言）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/dsh-client/tests/panel-interact.spec.ts`
Expected: FAIL — 选中后地址栏仍被填上、SSH 目标为空

- [ ] **Step 3: 实现**

`pickPeer` 改为：`onPickPeer(peer)` → 名称栏填 `peer.name`、把 `peer.ip` 交给 SSH 目标栏、**不碰地址栏**，并在地址标签旁渲染「留空 = 由部署或连接自动写入」的注记。

`AgentPanel` 持有 `sshTargetDraft`，同时传给 `HostFormPage`（供选择器写）与 `SshDeploySection`（覆盖其内部 `target` 初值）。添加页在选中 peer 后把 `addMode` 置为 `'ssh'`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/dsh-client/tests/panel-interact.spec.ts`
Expected: PASS

- [ ] **Step 5: 全量 + 提交**

Run: `pnpm test && pnpm typecheck`
Expected: 全绿

```bash
git add packages/dsh-client/src/panel.tsx packages/dsh-client/tests/panel-interact.spec.ts
git commit -m "fix(client): Tailscale 选择器改填 SSH 目标，地址留给部署/连接写入"
```

---

### Task 8: 不可达原因写出实际检测目标

**Files:**
- Modify: `packages/dsh-client/src/reach.ts`
- Modify: `packages/dsh-client/src/locales.ts`
- Test: `packages/dsh-client/tests/reach.spec.ts`

**Interfaces:**
- Consumes: 无
- Produces: `reach.ts` 内新增并导出
  ```ts
  /** The target a probe will actually hit, port included. */
  export function describeProbeTarget(address: string): { readonly text: string; readonly hasPort: boolean }
  ```
- 新增 locale key：`panel.reach.defaultPort`（zh：`正在检测 {url} 的 80 端口（地址没写端口）`，占位符 `{url}`）。

- [ ] **Step 1: 写失败的测试**

`reach.spec.ts` 追加：
- `地址不带端口时 describeProbeTarget 补出 80 且 hasPort 为假`：`describeProbeTarget('http://100.101.1.7')` 的 `text` 含 `80`，`hasPort === false`
- `地址带端口时 hasPort 为真且 text 含该端口`：`describeProbeTarget('http://100.101.1.7:3081')`
- `不可达的原因写出检测目标`：`probeReach` 收到 `TypeError` 且地址不带端口时，`reason` 含 `80`
- `地址带端口时原因里不出现「没写端口」`

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/dsh-client/tests/reach.spec.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`probeReach` 的 `unreachable` 分支按 `describeProbeTarget` 的结果选文案：有端口走原来的「网络层失败：地址不可达、端口没有监听，或浏览器拦下了这个请求」；无端口走新的 `panel.reach.defaultPort`，把实际 URL 与默认端口说出来。`timeout` 分支不动。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/dsh-client/tests/reach.spec.ts packages/dsh-client/tests/ui-i18n.spec.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/dsh-client/src/reach.ts packages/dsh-client/src/locales.ts packages/dsh-client/tests/reach.spec.ts packages/dsh-client/tests/panel-locale.spec.ts
git commit -m "fix(client): 可达性检测失败时写出实际检测目标与端口"
```

---

### Task 9: 左侧会话树的「未部署」改用真读数

**Files:**
- Modify: `packages/dsh-client/src/host-roll-up.ts`
- Test: 对应的 `host-roll-up` 测试文件

**Interfaces:**
- Consumes: Task 2 的 `HostRegistration.remote`
- Produces: `undeployed` 的判定改为：有读数时按 `report.deployment === 'undeployed'`；没有读数时退回旧的「没有 launchUrl 即未部署」启发式。

- [ ] **Step 1: 写失败的测试**

- `读数说未部署时行是未部署`（即使登记里有 launchUrl —— 装了又卸了）
- `读数说已部署时行不是未部署`（即使登记里没有 launchUrl —— 装了但还没连过）
- `没有读数时退回旧启发式`

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/dsh-client/tests/host-roll-up.spec.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`host-roll-up.ts` 里 `undeployed: registration.launchUrl === undefined` 改为先看
`registration.remote?.deployment`，为 `undefined` 时才退回旧启发式。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/dsh-client/tests/host-roll-up.spec.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/dsh-client/src/host-roll-up.ts packages/dsh-client/tests/host-roll-up.spec.ts
git commit -m "feat(client): 会话树的未部署标记改用读回来的部署态"
```

---

### Task 10: 文档同步与真机验证清单

**Files:**
- Modify: `docs/ssh-deploy.zh.md`
- Create: `docs/bugfix/2026-10-15-host-state-model-verification.md`（真机验证记录）

**Interfaces:**
- Consumes: Task 1–9 的全部产出
- Produces: 与代码一致的文档 + 一份可勾选的真机验证清单

- [ ] **Step 1: 改文档**

`docs/ssh-deploy.zh.md` 的「界面：会话树与主机状态」一节：把「主机行显示 已连接 /
可达 / 未连接 / 检测中」替换为规格 §4.2 的九个状态词，把「详情页提供 连接、重新部署
DSH（SSH）、可达性检测」替换为规格 §5 的按钮表。第 15 行关于选择器的那句补上
「（2026-10-15 起代码已按此接线）」。

- [ ] **Step 2: 写真机验证清单**

在 `docs/bugfix/2026-10-15-host-state-model-verification.md` 里写下这些可勾选项，
每项注明「通过 / 现象 + 原文」：

1. 一台真机器全新登记 → 状态词「未部署」，按钮是「部署 DSH（SSH）」
2. 部署完成 → 状态词「已连接」，点「打开页面」能打开
3. 在对方杀掉 dsh web 进程 → 进详情页重读 → 状态词「未启动」
4. 点「启动对方 DSH」→ 十几秒内恢复「已连接」
5. 用 `tailscale serve` 的 https 网址手填登记一台直连主机 → 状态词「可达」，部署/运行两行显示未知
6. 手填一个不带端口的地址 → 点检测 → 错误文案里写出了 80 端口
7. 一台密码认证的主机 → 状态词「未知」，页面明说凭据不保存读不了
8. 把网线拔掉再进详情页 → 状态词「未知」，且下方仍保留上次读到的时刻

- [ ] **Step 3: 逐项跑完并记录**

把每一项的实际结果填进清单文件；任何一项不通过，回到对应 Task 修，不要在清单里写「预期通过」。

- [ ] **Step 4: 全量 + 提交**

Run: `pnpm test && pnpm typecheck`
Expected: 全绿

```bash
git add docs/ssh-deploy.zh.md docs/bugfix/2026-10-15-host-state-model-verification.md
git commit -m "docs: 同步 SSH 部署文档的状态与按钮，补真机验证清单"
```

---

## 自查记录

- **规格覆盖**：§4 状态模型 → Task 1；§6.2/§10 读数与存储 → Task 2；§6.1/§6.3/§6.4 读取 → Task 3；§7 启动 → Task 4+5；§5 按钮表与 §5.1 合并 → Task 6；§8/§8.1 选择器 → Task 7；§9 退化与端口文案 → Task 8；§10 会话树 → Task 9；§12 验证 → 各自 Task 的单测 + Task 10 真机；§13 文档 → Task 10。规格每一节都有归属。
- **Review Focus 五条**分别落在 Task 3（第 1、3、5 条）、Task 6（第 2 条）、Task 4（第 4 条）的测试步骤里。
- **类型一致**：`RemoteDeployment` / `RemoteLiveness` 只在 `remote-report.ts` 声明一次，`host-state.ts` 转出别名；`PeerReport` 只在 `ssh/liveness.ts` 声明，客户端从 federation 根入口 import；`ROUTE_START` 在宿主与客户端各有一份同字符串常量，Task 5 的测试专门比对两边相等。
