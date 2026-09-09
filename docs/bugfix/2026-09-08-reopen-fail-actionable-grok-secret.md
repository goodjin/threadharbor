# Bug Fix: 重开失败被静默吞掉 / Grok 密钥漂移导致永远无法重开

## 问题描述

- 日期: 2026-09-08
- 严重程度: Medium（用户体验 + 一个具体后端无法恢复）
- 影响范围: 所有后端的「在当前会话重开」；Grok 后端为硬伤
- 表现:
  1. Grok 会话 `e84146c3-…`（本机唯一 Grok 会话）自 9 月 4 日起 hold worker 死亡。
  2. 本机 hostd 于 14:26 重启，新进程环境里没有 `GROK_AGENT_SECRET`；9 月 1 日启动的
     `grok agent serve`（:2419，带 `--secret`）仍在运行。
  3. 点「在当前会话重开」→ 界面显示「重开中…」十几秒后回到原状，无任何错误提示；反复点击反复失败。
  4. 诊断时只能靠挖 `config.json` / `ps` / journal 推断原因：复活流程写出的 worker config 不含
     secret → hold-worker 连 `ws://127.0.0.1:2419/ws` 握手被拒 → worker 在绑定控制 socket 之前退出
     → hostd `spawnHold` 轮询 15 s 后报 `hold … did not start` → 会话仍标 lost。

## 根因分析

1. **密钥生命周期只挂在父进程 env**（`GROK_AGENT_SECRET`）：
   - `server.ts` spawnHold/`ensureGrokServer` 直接读 `process.env`；
   - hostd 重启（升级/换 shell/launchd）后 env 丢失，而旧 hostd 拉起的 grok serve 密钥不变，
     新旧失配；`ensureGrokServer` 只看 TCP 端口开着就认为可用（8/29 bugfix 文档已计划
     「在私有数据目录生成并持久化 Grok Agent 密钥，重启后复用」，当时未落地）。
   - hold-worker 里 env secret 优先级高于 config，进一步掩盖 config 的正确值。
2. **失败被折叠/吞掉**：
   - gateway `holdSessionFailure` 把所有「did not start / socket」类错误折叠成
     「远程会话进程已停止。可以点重开」——而对一次重开操作来说这是错的（我们正在重开），
     真实原因被隐藏；
   - 前端 `reconnect()` 的 `.catch(() => undefined)` 直接吞错误，无任何可见提示。

## 修复方案

### hostd：Grok serve 密钥归 hostd 所有，可诊断、可修复（`grok-serve.ts` 新增）
- 持久化 secret 文件 `<dataDir>/grok-serve-secret`（0o600）；优先级：文件 > env（env 首次使用会固化到文件）> 新生成。
- `spawnHold` 的 worker transport secret 与 `ensureGrokServer` 都改用 hostd 拥有的 secret；
  hold-worker 改为 **config secret 优先**（旧 env 只作兜底）。
- `ensureGrokServer` 只对**命令行可识别为 `grok agent serve --bind …`** 的监听者做真实 WebSocket
  握手探测（带 secret），失配即抛带修复标记的错误；不探测/不杀陌生监听者。
- 新增控制方法（hostd + gateway 白名单透传）：
  - `grok.serve.inspect`：只读诊断（listening / pid / grokAgentServe / secretAdoptable / reachable / ours）；
  - `grok.serve.adopt`：非破坏性——从监听者命令行读取 `--secret` 并持久化（适合接管旧 hostd 的服务）；
  - `grok.serve.restart`：破坏性——仅当监听者被识别为 grok agent serve 时 SIGTERM→SIGKILL 后，
    用 hostd secret 重新拉起。
- 可操作错误统一带机器可读前缀 `[th-fix:<kind>] <detail>`（`grok-serve` / `agent-missing`），
  使其穿透 gateway 原样到达浏览器。
- hold-worker 启动日志落到 `holds/<holdId>/worker.log`（owner-only）；`spawnHold` 失败把日志尾部
  并入错误，替代原来的 15 秒静默。

### gateway
- dispatch 增加 `grok.serve.inspect|adopt|restart` 代理（同 `agent.*`）。
- `holdSessionFailure` 不再折叠：带 `[th-fix:` 的错误、以及任何 hostd 已返回的具体错误都原样透出；
  只有确凿的 hold socket 死亡（`.sock`/named pipe + 连接错误）保留「点重开」通用文案。

### 前端
- `store` 新增 `parseReopenFailure`：解析 `[th-fix:…]` → 原因 + 修复类型；死 socket → 原通用提示；
  其它 hostd 错误 → 原文展示（不再折叠）。
- `store.reconnectSession` 显式重开失败时抛出原始原因（不再折叠成“请再点一次重开”）。
- `store.repairGrokServe(sessionId, 'adopt'|'restart')`：先执行 hostd 修复 RPC，再自动重开。
- 会话横幅新增「在当前会话重开失败」提示（原因可见）：
  - 修复类型 `grok-serve` → 「接管现有 Grok 服务并重试」（非破坏，单击执行）
    与「重启 Grok 服务」（破坏性，需二次点击确认，10 s 未确认自动解除）；
  - 任何失败都有「重试重开」。
  - 修复成功后（channel open）横幅自动消失。

## 验证步骤

1. 单元：`grok-serve.spec.ts`（secret 解析/优先级、命令行识别、握手探测 accept/reject、
   TCP 监听者 pid、worker.log 尾部、hostd adopt/inspect/尾部错误）。
2. hostd 集成原用例全绿（grok 用 fake listener，非 grok 命令行 → 不再探测，行为不变）。
3. gateway：attach 返回 `[th-fix:grok-serve] …` 时错误原样到浏览器（新用例）。
4. client：`parseReopenFailure` 三种分支 + `repairGrokServe('adopt')` 调 RPC 后自动 attach（新用例）。
5. 实机回归（待用户升级 hostd 后）：对 `e84146c3-…` 点重开 → 失败横幅显示原因与
   「接管现有 Grok 服务并重试」→ 点击后应能在同一会话 id 上成功重开。

## 相关文件

- `packages/protocol/src/index.ts`（方法并集 + `[th-fix:` 标记工具）
- `packages/hostd/src/grok-serve.ts`（新增）
- `packages/hostd/src/server.ts`、`packages/hostd/src/hold-worker.ts`
- `packages/dsh-gateway/src/index.ts`
- `packages/dsh-client/src/client/store.ts`、`RemoteConversation.tsx`
- 测试：`packages/hostd/tests/grok-serve.spec.ts`（新增）、hostd/gateway/client 相应 spec
