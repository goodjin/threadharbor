# Stable / Test 双通道发版规范

> **⚠️ 已退役（2026-10-20）**：双通道方案停用，web 只剩一个实例，固定 3080
> （DSH_HOME=`~/.dsh-web`，由 `~/bin/dsh-web` 管理；3081 与 `~/bin/dsh-web-3081`
> 已删除）。本文保留作历史参考：其中的制品验证与 promote 流程思路仍可复用，
> 但端口、通道与「3081 重启」相关操作一律以 AGENTS.md 的 3080 铁律为准。

ThreadHarbor 在本地同时跑两个 DSH Web 实例：stable 通道（端口 3080）服务生产用户，test 通道（端口 3081）给本仓库开发用。两条通道共享同一份浏览器 `localStorage`，但 DSH_HOME 与 profile 互相隔离。（2026-10-10 复核：hostd 与 gateway 已随多主机迁移阶段 6 下线，通道隔离清单里原来的 catalog、known_hosts、SSH tunnel 都不再存在。）

本规范约束 stable 通道，避免本地未提交改动意外污染生产。

> **补丁文件的下线（2026-10-10 记录）**：hostd 部署删除时一并删掉了
> `deploy/channels/<channel>.patch.yml`，而 `scripts/dev.sh` 与
> `scripts/release-channel.mjs` 当时还在硬性要求它们存在，在真实仓库里会直接失败
> （测试没抓住，因为测试自己在临时产物里造了这些补丁）。两个脚本已改为
> 「有就用、没有就不带 `--patch`」：插件现在由 profile 自己组装，补丁是可选的。

## 角色与边界

| 通道 | 端口 | 加载源 | 用途 |
| --- | --- | --- | --- |
| stable | 3080 | `~/.local/share/threadharbor/stable-current` 制品 | 长期给生产用户使用。**只能在显式发版流程下覆盖**。 |
| test | 3081 | 当前工作区 `/Users/good/github/threadharbor` | 调试通道，重启即生效，dirty 工作区可直接重启。 |

test 通道的 symlink 始终指向工作区，任何 dirty 改动都会在下一次 3081 重启时加载。**stable 通道禁止任何自动指向工作区或未 verify 制品的路径。**

## 禁止做的事

1. 不要在 dirty 工作区直接 `release-channel.mjs promote`。
2. 不要让 `stable-current` 链向 `dirty: true` 的制品。如果看到 `stable-state.json.current` 对应的制品 `source.dirty === true`，立刻按 "事故响应" 步骤 rollback。
3. 不要在 3080 还在跑的时候手工覆盖 `~/.dsh-threadharbor-stable/profiles/web/node_modules/threadharbor`。
4. 不要把 release-channel.mjs 的 `createCandidate({ skipCheck: true })` 当作默认路径。`--skip-check` 只用于离线环境，必须显式声明。
5. 不要让两个通道跑到不同来源的制品上（一个链接工作区、一个链接制品）。agent 现在以 DSH 插件形式跑在提供页面那台机器的进程内，「新 client + 旧 gateway + 旧 hostd」那类混合状态已不存在，但同一份制品的原则不变：stable 只能跑 `promote` 过的制品，test 才允许链接工作区。

## 发版流程（stable 覆盖唯一合法路径）

```sh
# 1. 工作区干净，所有改动已 commit
git status --porcelain   # 必须空

# 2. 跑一次完整检查
npm run check            # typecheck + test；失败必须先修

# 3. 在干净工作区创建候选制品
node scripts/release-channel.mjs candidate --version 0.1.0-local.YYYYMMDD.N

# 4. 在 test 通道验证候选制品
node scripts/release-channel.mjs bootstrap --channel test --source-home ~/.dsh \
  --workspace ~/.local/share/threadharbor/releases/0.1.0-local.YYYYMMDD.N
# 停掉手动的 3081，用 release-channel 启动 test
node scripts/release-channel.mjs start --channel test
# 浏览器打开 3081，回归 preset 建会话、提问、工具调用投影、权限批准

# 5. 验证通过后 promote
node scripts/release-channel.mjs promote --version 0.1.0-local.YYYYMMDD.N

# 6. 重启 stable 让新制品生效
node scripts/release-channel.mjs stop --channel stable
node scripts/release-channel.mjs start --channel stable
```

`promote` 完成后 `stable-state.json` 会写入：

- `current`: 新制品版本
- `previous`: 上一个能 verify 的版本（用于 rollback）
- `rejectedCurrent`: 之前指向但 verify 失败的版本（如有）
- `promotedAt`: ISO 时间戳

### dirty 工作区保护

`promoteRelease` 默认拒绝 `source.dirty === true` 的制品。如果确实需要在 dirty 工作区构建的制品上 promote（例如离线调试），必须显式声明：

```sh
node scripts/release-channel.mjs promote --version 0.1.0-local.YYYYMMDD.N --allow-dirty
```

不传 `--allow-dirty` 且制品是 dirty 时，命令直接报错退出，不会切换 symlink。

## 回滚

`rollback` 把 stable-current 切回 stable-previous，并可选地 `restore-data` 恢复 catalog backup。

```sh
node scripts/release-channel.mjs rollback --channel stable --restore-data
node scripts/release-channel.mjs stop --channel stable
node scripts/release-channel.mjs start --channel stable
```

**前提条件**：`stable-previous` 指向的制品必须能 `verifyRelease` 通过。如果 `rollback` 报 "release checksum verification failed"，说明 previous 已经损坏，需要按 "事故响应" 处理。

## 事故响应

当 stable 出现异常（id mismatch、UI 卡死、inventory 报 unknown）时：

1. **不要直接重试** —— 先确认 stable 制品的 `source.dirty` 是否被设为 true：
   ```sh
   cat ~/.local/share/threadharbor/releases/$(basename $(readlink ~/.local/share/threadharbor/stable-current))/threadharbor-release.json | python3 -m json.tool | grep dirty
   ```
2. 如果 `dirty: true`，按上面 "rollback" 流程恢复到最近的干净版本。
3. 如果 `rollback` 也失败（stable-previous 已损坏），在 `~/.local/share/threadharbor/releases/` 中找一个能 verify 通过的更早版本（例如 `0.1.0-local.20260831.1`），手动重切 symlink：
   ```sh
   cd ~/.local/share/threadharbor
   ln -sfn releases/<last-clean-version> stable-current
   ln -sfn releases/<previous-stable-current> stable-previous
   # 同步更新 stable-state.json（手动写入 current/previous/rejectedCurrent）
   node scripts/release-channel.mjs start --channel stable
   ```
4. 恢复后核对 `~/.dsh-threadharbor-stable/profiles/web/node_modules/threadharbor` 是否指向干净制品。
5. 在 `docs/bugfix/` 下记录事故根因和修复步骤。

## 制品完整性

每个 release 目录里都有 `threadharbor-release.json`：

- `schemaVersion`: 必须为 1
- `version`: 制品版本号
- `createdAt`: 创建时间
- `source.revision`: git commit hash
- `source.dirty`: true/false —— **stable 制品必须为 false**
- `entries[]`: 所有文件的 sha256 manifest，`verifyRelease` 会重算并比对

如果发现 manifest 与磁盘不符（`verifyRelease` 失败），说明 pnpm cache 重 hash 或者有进程覆盖了 release 目录里的文件。**这种制品不能再用于 stable**。

## 排查清单（出现异常时按顺序核对）

```sh
# stable 制品是否干净、manifest 是否与磁盘一致
node scripts/release-channel.mjs verify --release $(readlink -f ~/.local/share/threadharbor/stable-current)

# profile 是否真的指向 stable-current
ls -la ~/.dsh-threadharbor-stable/profiles/web/node_modules/threadharbor

# 两个通道各自跑的是哪个制品、进程是否还活着
node scripts/release-channel.mjs status --channel stable
node scripts/release-channel.mjs status --channel test

# agent 子进程/连接归 DSH 进程所有：重启通道进程即重启 agent，
# 没有（也不再需要）单独的 hostd 探针
```

（2026-10-10 复核：原清单里「grep gateway 产物里的 HostdConnectionPool」和
「curl hostd 的 /v1/control 探针」两步随 hostd/gateway 下线一并作废。）
