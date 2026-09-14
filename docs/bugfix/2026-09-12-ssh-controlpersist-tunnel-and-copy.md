# Bug Fix: SSH 多路复用后隧道被误判失败（主机"连不上"）+ 全站文字可复制

## 问题描述
- 日期: 2026-09-12
- 严重程度: High（主机不可用）/ Low（复制）
- 影响范围:
  1. 所有走 SSH 的主机。用户报告 100.96.156.60（Mac-mini）"连不上"，日志持续 `SSH tunnel exited with status 0:`（stderr 为空），inventory 失败、会话无法 attach。实际上 22 端口可达、密钥可用、hostd 也在跑。
  2. 页面上 DSH 壳层的多处文字（trajectory 面板、工作区行、标签、行号槽等）带 `user-select: none`，无法选中复制。

## 根因分析
1. **隧道判活方式错误**（`packages/dsh-gateway/src/ssh-manager.ts` `startTunnel` / `ensureTunnel`）。commit 74b44ff 引入了 `ControlMaster=auto` + `ControlPersist=120`。在这种模式下：第一个 `ssh -N -L` 会 fork 出一个后台 master（PPID 1）持有转发，前台进程注册完转发后立即以 0 退出；之后再起的 ssh 只是 mux 客户端，向 master 注册转发后同样立即以 0 退出（`-vv` 可见 `Received exit status from master 0`）。而 `startTunnel` 把"子进程退出"一律当失败 reject，`ensureTunnel` 又用 `child.exitCode === null` 判活，于是每次都重新起 mux 客户端、每次都"失败"，同时在 master 上堆了十几个无人使用的转发端口。本机实测 master pid 85733 一直在监听 127.0.0.1:56336，通过它 curl 远端 hostd 正常返回。
2. **复制限制**来自 DSH 自带包（`dsh-client-ui-trajectory`、`dsh-client-ui-workspace`、`dsh-web-frontend` 等）的 CSS，ThreadHarbor 自己的样式里没有 `user-select: none`。

## 修复方案
1. `ssh-manager.ts`
   - 新增 `portListening(port, attempts)`：对 127.0.0.1:port 发 TCP 连接探测。
   - `startTunnel`：子进程在 350ms 窗口内以 0 退出时，不再 reject，而是探测本地端口（最多 8 次、间隔 250ms），端口在监听即成功；非 0 退出或端口不通才抛错并带上 stderr。
   - `ensureTunnel`：已有记录的隧道，子进程仍在或本地端口仍在监听即复用，不再重复开。
   - `releaseTunnel` / `close`：杀子进程之外，对多路复用的连接补 `ssh -O exit`，让后台 master 一起退出。`OwnedTunnel` 记录 config 供此用。
2. `RemoteSurface.module.css`：文件开头加全局规则 `:global(*) { user-select: text !important }`（含 `::before/::after` 与 `-webkit-` 前缀），覆盖 DSH 壳层所有 `user-select: none`；原有 `.setupCard code { user-select: all }` 加 `!important` 保留点击全选。

## 验证步骤
1. ✅ 复现：用网关同样的参数手动执行 `ssh -vv -N -L …`，看到 `auto-mux: Trying existing master` → `Received exit status from master 0` → exit 0；`lsof` 显示 master 在监听转发端口；`curl http://127.0.0.1:56336/` 得到 hostd 的 404（服务在）。
2. ✅ typecheck、全量 vitest（32 文件 / 391 用例）通过；ssh-manager.spec.ts 新增 1 例（源码断言 + `portListening` 真端口探测）。
3. ✅ build 后重启 3081 web，`inventory` Mac-mini：`inventoryError` 为空、`healthy: true`、hostd `0.1.0+9f2e162f562a`，grok/codex/claude/dsh 均 installed+authenticated。
4. ⚠️ 复制规则已确认打进 `packages/dsh-client/lib/client.js` 并随 web 重启生效；浏览器扩展未连接，未做页面级实测，请在页面上任选一段 DSH 壳层文字（例如 trajectory 面板里的标签）确认可选中。

## 相关测试
- ssh-manager.spec.ts: judges a tunnel by its local port, so a ControlPersist master that daemonised counts as alive

## 设计建议
- master 85733 上堆积的旧转发端口（53191、56730、…）随 master 存活；网关 `close()` 现在会 `-O exit`，重启一次 web 即可清掉。
- 网关日志仍无时间戳，本次也是靠手动复现定位；建议补上。
