# Stable / Test 双通道发版规范

ThreadHarbor 在本地同时跑两个 DSH Web 实例：stable 通道（端口 3080）服务生产用户，test 通道（端口 3081）给本仓库开发用。两条通道共享同一份浏览器 `localStorage` 和会话存储，但 DSH_HOME、catalog、known_hosts、SSH tunnel 互相隔离。

本规范约束 stable 通道，避免本地未提交改动意外污染生产。

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
5. 不要把 hostd/gateway/client 三方的 bundle 分别部署。三方必须来自同一份制品，否则会出现 "新 client + 旧 gateway + 旧 hostd" 的混合状态（症状：浏览器侧报 `remote-agent response id did not match request`、prompt 提交后 UI 永远停留在等待态）。

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
# 浏览器打开 3081，回归 host 列表、prompt、config 编辑、login 流程

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
# stable 制品是否干净
node scripts/release-channel.mjs verify --release $(readlink -f ~/.local/share/threadharbor/stable-current)

# profile 是否真的指向 stable-current
ls -la ~/.dsh-threadharbor-stable/profiles/web/node_modules/threadharbor

# 两个通道加载的 source.dirty
cat $(readlink -f ~/.local/share/threadharbor/stable-current)/node_modules/.pnpm/@threadharbor+dsh-gateway*/node_modules/@threadharbor/dsh-gateway/lib/index.js \
  | grep -o "HostdConnectionPool\|ws-broadcaster" | sort | uniq -c

# 远端 hostd 是否与 gateway 匹配
curl -fsS -X POST -H "content-type: application/json" \
  -d '{"id":"probe","method":"inventory","params":{}}' \
  http://127.0.0.1:<hostd-port>/v1/control
# 返回 HTTP_FALLBACK_DISABLED → 远端是新 hostd（走 WS）
# 返回 inventory → 远端是旧 hostd（gateway 必须用 WS 才兼容）
```
