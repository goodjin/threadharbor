# Bug Fix: DSH 原生 JSONL session 写到了项目目录

- 日期: 2026-09-04
- 严重程度: Medium
- 影响范围: 所有 DSH 后端项目；每个被打开的项目 cwd 下都会出现 `.sessions/`。

## 问题描述

ThreadHarbor 把 Agent 的 cwd 设成了项目路径，并通过 hold-worker 直接 `spawn()` DSH stdio 进程。bundled cordis.yml 里：

```yaml
- id: sessions
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: !!js process.env.DSH_SESSION_ROOT ?? './.sessions'
```

`./.sessions` 解析成 child 的 cwd 也就是项目目录。ThreadHarbor 没有给 child 注入 `DSH_SESSION_ROOT`，结果：

- `/Users/good/github/threadharbor/.sessions/--Users-good-github-threadharbor--/<sessionId>/session.jsonl.zstd`
- `/Users/good/qg/nexa-service/.sessions/--Users-good-qg-nexa-service--/<id>/session.jsonl.zstd`

仓库 `.gitignore` 已经把 `/.sessions/` 列入，但启动路径没有改。

侧栏 catalog 在 `$DSH_HOME/storages/remote_agent.json`，与 cwd 无关；hostd 的 hold journal 在 `dataDir/holds/<holdId>/`，也不该绑项目路径。ThreadHarbor 把这三层（JSONL、catalog、journal）都散落了：catalog 在 Web 自己的 home，journal 在 hostd dataDir，而 JSONL 跑到了项目目录里——本应属于 hostd 这一层。

## 根因分析

- 问题位置: `packages/hostd/src/hold-worker.ts:230 startStdio`、`packages/hostd/src/server.ts:726 spawnHold`、`packages/hostd/src/hold-protocol.ts HoldWorkerConfig`
- 原因: hold-worker 启动 DSH stdio 子进程时只复制 `process.env`，没有给 `$DSH_SESSION_ROOT` 设值。bundled cordis.yml 的 `root` 回退到 `./<cwd>/.sessions`，而 `cwd` 就是项目路径。
- 代码流程:
  1. `server.ts startSession` → `spawnHold(record)` 写 `config.json` 给 hold-worker。
  2. hold-worker `startStdio` 用 `spawn(command, [...args], { cwd: config.cwd, env: process.env })` 拉起 DSH。
  3. DSH 启动时读 cordis.yml，看到 `$DSH_SESSION_ROOT` 未设置，把 `./<项目路径>/.sessions` 当根目录。
  4. 每次新会话都把 `session.jsonl.zstd` 写到项目目录里。

## 修复方案

把 DSH 原生 JSONL root 收敛到 hostd 的 dataDir 下独立目录。

1. `packages/hostd/src/hold-protocol.ts`：给 `HoldWorkerConfig` 加可选 `sessionRoot?: string`。
2. `packages/hostd/src/hold-worker.ts`：
   - `parseConfig` 透传 `sessionRoot`。
   - `startStdio` 在 `env` 上覆盖 `DSH_SESSION_ROOT = config.sessionRoot`（仅 stdio+dsh；非 dsh 不会带这个字段）。
3. `packages/hostd/src/server.ts`：
   - 新增模块级 helper `dshSessionRoot(dataDir)`，返回 `join(dataDir, 'dsh-sessions')` 并通过 `ensureOwnerOnlyDirectory` 建立 owner-only 目录。
   - `spawnHold` 在 `backend === 'dsh'` 时把 `sessionRoot` 写进 `HoldWorkerConfig`。
4. 测试：
   - 新 fixture `fake-env-snapshot.mjs`：把 `process.env.DSH_SESSION_ROOT` 写到指定文件。
   - `hold-worker.spec.ts`：新增两条用例覆盖「设了 sessionRoot 时注入」与「未设时不注入」。
   - `parseConfig`：新增 round-trip 用例，确认 `sessionRoot` 可被读回且缺失时为 `undefined`。
5. 旧项目里的 `.sessions/`：本次改动只影响新建会话；迁移策略留给后续决定（见下文）。

## 验证步骤

1. ✅ `npx vitest run packages/hostd/tests/hold-worker.spec.ts` — 17/17 通过（含 4 条新增）。
2. ✅ `npx vitest run packages/hostd/tests/` — 52/52 通过；`hostd-integration.spec.ts` 跨 backend 流程仍绿。
3. ✅ `npx tsc -p packages/hostd/tsconfig.json --noEmit` — 无类型错误。
4. 待真机：启动一个 DSH 项目，打开几条会话，确认 `~/.local/state/threadharbor/dsh-sessions/<projectKey>/<sessionId>/session.jsonl.zstd` 出现，项目目录不再新增 `.sessions/`。

## 相关测试

- `packages/hostd/tests/hold-worker.spec.ts`
  - `exports DSH_SESSION_ROOT into the stdio child env when sessionRoot is configured`
  - `leaves DSH_SESSION_ROOT unset when the config does not provide one`
  - `preserves an explicit sessionRoot for stdio dsh backends`（parseConfig）
  - `omits sessionRoot when the field is absent`（parseConfig）
- `packages/hostd/tests/fixtures/fake-env-snapshot.mjs`（新增 fixture）

## 设计建议

- **目录归属**：DSH JSONL 放在 hostd dataDir 下的 `dsh-sessions/`，跟 hold journal 同级，符合「hostd 拥有自己的 dataDir」的设计，比塞进 Web 的 `$DSH_HOME` 更稳——不绑通道、不绑通道布局。
- **跨 hold 共享**：`dsh-sessions/` 不是按 hold 隔离的，DSH 用 `cwd` 当 projectKey，所有同一项目的 hold 共享同一棵子树；这样 attach / fork 续上历史不会因为 hold 目录被清掉而丢 JSONL。
- **迁移问题**：已存在的项目 `<cwd>/.sessions/` 不会被本次修改自动迁移。两种选择：
  - 静默：用户自清，不做兼容（默认）。
  - 一次性迁移：在 `session.start` 检测到项目里已有 `.sessions/`，把 `<cwd>/.sessions/*` 移到 `<dataDir>/dsh-sessions/<projectKey>/*`，再继续。
  目前选择「只对新建会话生效」。如果后续要兼容旧目录，可以新增一个 hostd 控制 RPC 做一次性迁移，避免改启动路径引入新的不确定性。
- **dataDir 漂移（未解决，后续 ticket）**：本机当前 hostd 实际用的是 `/private/tmp/threadharbor-hostd-run.XXXX/`，跟设计默认 `~/.local/state/threadharbor` 不一致。`/tmp` 在重启后会被清掉，hold journal 也会丢；这跟本 fix 是独立问题，应该分开处理。
  - **升级路径会延续坏路径**：`packages/dsh-gateway/src/local-hostd.ts:33` 的 `restartLoopbackHostd` 会用 `lsof`+`ps` 读出当前 hostd 进程的 `--data-dir` 再原样回传，所以「升级 hostd」按钮不会自动把 dataDir 迁回 `~/.local/state/threadharbor`。
  - **代码里没有 `/tmp` 入口**：grep 全仓 `--data-dir` 只在 `bin.ts:54`（默认 `~/.local/state/threadharbor`）、`ssh-manager.ts:265/267`（SSH 远端，`$state/hostd`）和 `local-hostd.ts:33`（续传）出现。也就是说 `/private/tmp/threadharbor-hostd-run.XXX/` 是某次手工启动（很可能是 `mktemp -d` 之类）留下的，gateway 自己不会建这个路径。
  - **修复方向（不在本轮）**：手动 kill 当前 hostd 后用默认 `--data-dir`（或不传）重启；或在 `restartLoopbackHostd` 里加一道「检测到 `/tmp` 或 `/private/tmp` 前缀则改写到 `~/.local/state/threadharbor`」的迁移逻辑。
