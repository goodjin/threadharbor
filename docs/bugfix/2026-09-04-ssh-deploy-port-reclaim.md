# Bug Fix: macOS SSH 部署 hostd 时无法回收被占用的目标端口

## 问题描述

- 日期: 2026-09-04
- 严重程度: High
- 影响范围: 通过 `host-ssh-deploy` 在 macOS / 非 systemd 主机上部署或升级远端 hostd

用户点击远端主机的「升级 hostd」后，gateway 报 `SSH 部署失败，请检查主机连接和远端服务日志。` 同一目标用普通 `ssh user@host` 直接登录完全正常。升级结束后 hostd 仍连不上。

## 根因分析

- 问题位置: `packages/dsh-gateway/src/ssh-manager.ts:267`（旧版的 macOS fallback 分支）
- 原因: macOS 没有 `systemctl --user`，fallback 路径只 kill 写在 `$state/hostd.pid` 里的那个 pid；如果旧 hostd 不是当前脚本启动的（手工启动、更老版本的部署、pid 文件被删），目标端口上的监听进程就没人管。
- 代码流程:
  1. 远端 hostd 是 2026-08-30 那批部署的（见 `2026-08-30-ssh-multi-host-key-order.md`），属于 HTTP-only 协议版本，仍在 `127.0.0.1:3091` 上监听。
  2. 新的 `host-ssh-deploy` 流程把新 `bin.js` + `hold-worker.js` 上传到 `~/.local/share/threadharbor/test/current/`，但 `~/.local/state/threadharbor/test/hostd.pid` 不存在或指的不是当前监听者。
  3. `nohup "$node" "$bin" --port 3091 …` 启动新进程 → `Error: listen EADDRINUSE: address already in use 127.0.0.1:3091`，新进程当场退出。
  4. SSH 命令本身 exit 0（`nohup` 派生成功），gateway 看不到 deploy 步骤的错误。
  5. post-deploy `refreshHostInventory` 通过隧道连 127.0.0.1:3091 → 撞到老 HTTP-only hostd，WS 握手失败 → inventory 抛 `deployed hostd did not pass its inventory health check`。
  6. `operationFailureDetail` 没命中任何具体分支（`packages/dsh-gateway/src/index.ts:308`），掉进兜底文案 `SSH 部署失败，请检查主机连接和远端服务日志。`，没有提示 EADDRINUSE。

## 修复方案

### 1. macOS fallback 加端口回收

`packages/dsh-gateway/src/ssh-manager.ts:249-279` 把 fallback 分支拆成多行：

- 先按 pid 文件里的旧 pid `kill`，覆盖正常升级路径。
- 再用 `lsof -nP -iTCP:$port -sTCP:LISTEN -t` 找出当前监听目标端口的进程并 `kill`，覆盖 pid 文件丢失/陈旧/被外部启动的场景。
- 然后用最多 5s 的 `for _ in 1..10; do lsof ... || break; sleep 0.5; done` 等端口真正释放，避免新进程一启动就 EADDRINUSE。
- 之后才 `nohup` 新 hostd 并写 `$state/hostd.pid`。

`command -v lsof >/dev/null 2>&1` 的兜底保留，没有 `lsof` 的最小环境会跳过端口回收分支。

### 2. 让 post-deploy 失败原因可读

`packages/dsh-gateway/src/index.ts:698-702` post-deploy 健康检查失败时，把 host 上的 `inventoryError` 或 `healthy=false` 的具体原因拼进抛错：

```
deployed hostd did not pass its inventory health check: <reason>
```

`operationFailureDetail` 增加对 `inventory health check` 的匹配，把 reason 透出给用户，例如 `部署后 hostd 健康检查未通过：无法连接到 hostd。请确认远端服务已启动后再试。`，不再无声掉进"请检查日志"。

## 验证步骤

1. 重现旧故障：手工 `kill 27752` 后 `nohup` 起一个监听 127.0.0.1:3091 的旧版（HTTP-only）hostd 占位。
2. 在 100.96.156.60 上手工跑新 deploy 脚本（`/tmp/ssh-deploy-fixed.sh`）：
   ```
   killing port-holder pid=27752
   pid_file now: 40999
   COMMAND  PID  USER  ...  TCP 127.0.0.1:3091 (LISTEN)
   ```
   旧 pid 被 SIGTERM，新 pid 40999 绑到端口。
3. 用 `ws://127.0.0.1:<tunnel-port>/v1/ws` 直连新 hostd：
   ```
   RX: {"direction":"response","id":"1","ok":true,"result":{...,"hostdVersion":"unknown+896ed0ce9fea","healthy":true,"backends":[...]}}
   ```
   inventory RPC 走 WS 返回 healthy。新 `hostdVersion` 与本机 build 出来的 `896ed0ce9fea` 短哈希一致，说明跑的就是升级上传的最新 artifact。
4. `npm run typecheck`：通过。
5. `npm run build`：通过。
6. `npx vitest run`：27 个测试文件，285 个测试，全部通过（4 个 ssh-manager 测试包含新增的两条 source-level assertion）。

## 相关测试

- `packages/dsh-gateway/tests/ssh-manager.spec.ts` 新增：
  - `reclaims the hostd port on macOS / non-systemd hosts before nohup` —— 校验 deploy 脚本包含 `lsof` 端口回收 + 等待循环，并保证 pid 文件路径在 lsof 之前、systemd restart 路径仍在。
  - `post-deploy inventory failure surfaces the underlying reason` —— 校验 `deployed hostd did not pass its inventory health check` 仍在，且 reason 取自 `host.inventoryError`。

## 设计建议

1. 端口回收的等待循环最多 5s。如果远端 hostd 没响应 SIGTERM，循环结束 → nohup 启动的新进程还是会 EADDRINUSE 退出，post-deploy inventory 失败。原因会经 `operationFailureDetail` 透出（"无法连接到 hostd" 或 "listen EADDRINUSE"）。比当前的"请检查日志"已经前进一大步。
2. systemd 路径用 `systemctl --user restart`，本身由 systemd 负责替换监听进程，不需要这个端口回收。
3. `hostd.log` 已在远端累计，但本文档没把它的 tail 拉回来。如果将来要更精准的根因，可以加一个 post-deploy 诊断步骤：当 inventory 失败时，对 SSH host 跑 `tail -n 50 ~/.local/state/threadharbor/$channel/hostd.log`，把关键 stderr 拼进 failure detail。
