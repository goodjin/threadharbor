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
5. 旧项目里的 `.sessions/`：`spawnHold` 在启动 DSH hold 前调用 `migrateProjectDshSessions`，把 `<cwd>/.sessions/<projectKey>/<sessionId>/` 移到 `<dataDir>/dsh-sessions/`。目标已有同名会话时保留目标（正在写入的 `DSH_SESSION_ROOT` 副本），删除项目残留。空的 `.sessions` 树删掉。

## 验证步骤

1. ✅ `npx vitest run packages/hostd/tests/hold-worker.spec.ts` — 17/17 通过（含 4 条新增）。
2. ✅ `npx vitest run packages/hostd/tests/dsh-sessions.spec.ts` — 5/5 通过（项目 `.sessions` 迁入 `dsh-sessions`、目标已有则保留、symlink 跳过）。
3. ✅ `npx tsc -p packages/hostd/tsconfig.json --noEmit` — 无类型错误。
4. ✅ 本机已把 `/Users/good/github/threadharbor/.sessions` 与 `/Users/good/qg/nexa-service/.sessions` 迁入 `/private/tmp/threadharbor-hostd-run.mA1zJL/dsh-sessions/`；项目目录下 `.sessions` 已删除。`a990f321-…` 目标侧已有活副本，未覆盖。
5. 待真机：新 DSH 会话应只写入 `dataDir/dsh-sessions/`，项目目录不再出现 `.sessions/`。

## 相关测试

- `packages/hostd/tests/hold-worker.spec.ts`
  - `exports DSH_SESSION_ROOT into the stdio child env when sessionRoot is configured`
  - `leaves DSH_SESSION_ROOT unset when the config does not provide one`
  - `preserves an explicit sessionRoot for stdio dsh backends`（parseConfig）
  - `omits sessionRoot when the field is absent`（parseConfig）
- `packages/hostd/tests/dsh-sessions.spec.ts`
- `packages/hostd/tests/fixtures/fake-env-snapshot.mjs`（新增 fixture）

## 设计建议

- **目录归属**：DSH JSONL 放在 hostd dataDir 下的 `dsh-sessions/`，跟 hold journal 同级，符合「hostd 拥有自己的 dataDir」的设计，比塞进 Web 的 `$DSH_HOME` 更稳——不绑通道、不绑通道布局。
- **跨 hold 共享**：`dsh-sessions/` 不是按 hold 隔离的，DSH 用 `cwd` 当 projectKey，所有同一项目的 hold 共享同一棵子树；这样 attach / fork 续上历史不会因为 hold 目录被清掉而丢 JSONL。
- **迁移问题**：`packages/hostd/src/dsh-sessions.ts` `migrateProjectDshSessions` 在每次 DSH `spawnHold` 时把项目 `.sessions` 迁到 `dataDir/dsh-sessions`。同名会话以目标为准，避免覆盖已经在独立目录里写入的活副本。`.sessions` 若是指向 session root 的 symlink 则跳过。
- **dataDir 漂移（已通过 restart 自愈）**：`packages/dsh-gateway/src/local-hostd.ts` 的 `resolveLoopbackHostdDataDir` 检测 `--data-dir` 是否落在 `/tmp`、`/private/tmp`、`/var/folders/...` 或 OS `tmpdir()` 这些会被清掉的临时目录里，是的话把内容 `cpSync` 到 `~/.local/state/threadharbor` 再让新 hostd 起来时用新路径。目标目录已经存在则跳过迁移（避免覆盖已经在写的活副本），仅 stderr 记一笔。
  - **升级路径自愈**：`hostdRestartArgv` 走 `resolveLoopbackHostdDataDir` 拿最终路径再生成 argv，所以「升级 hostd」按钮按一次之后坏路径就消失，再按也不会回来。
  - **`/tmp` 入口在哪**：原 `/private/tmp/threadharbor-hostd-run.XXX/` 是某次手工 `mktemp -d` 留下的（gateway 自己代码里没有 `/tmp` 入口，全仓 `--data-dir` 只在 `bin.ts:54`、`ssh-manager.ts:265/267`、`local-hostd.ts` 出现）。下一次点升级就会自动搬到 `~/.local/state/threadharbor/`。
  - **未覆盖的情况**：测试用 `mkdtemp` 传 `persistentRoot` 选项隔离宿主 home；运行时只命中「`~/.local/state/threadharbor` 不存在 → copy 迁移」或「已存在 → 跳过迁移」两种。SSH 远端 host（`ssh-manager.ts` 的 `--data-dir $state/hostd`）不在这条路径上，路径已经在 `~/.local/state/threadharbor/<channel>/hostd` 下不走自愈。
