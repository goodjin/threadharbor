# Bug Fix: 会话重连 ECONNREFUSED 与 hold 就地重启

## 问题描述
- 日期: 2026-09-04
- 严重程度: High
- 影响范围: 会话「重新连接」、hold worker 控制 socket、lost/reconnecting 主区

会话 `c774dba7-42ce-4a70-b6b4-163ad08c826c` 点重新连接后报：

```text
Error: connect ECONNREFUSED /tmp/threadharbor-hostd-501/h-93fbc3f4-0311-4a3a-8d33-3d78eca09f9a.sock
```

界面只有原始错误，没有可执行的恢复流程。

## 根因分析
- 问题位置:
  - `packages/hostd/src/server.ts` `shortHoldSocket` / `attachRecord`
  - `packages/dsh-gateway/src/index.ts` `attachSession`
  - `packages/dsh-client/src/client/RemoteConversation.tsx` 重连按钮
- 原因:
  1. 为避开 macOS Unix socket 路径长度限制，控制 socket 被放到 `/tmp/threadharbor-hostd-<uid>/`。`/tmp` 会被定期清理；进程崩溃时还会留下无人监听的 stale socket。`ECONNREFUSED` 表示文件还在、进程已死。
  2. `session.attach` 只 ping 现有 hold。worker 死后不会重启，错误原样抛到浏览器。
  3. journal / `state.json` 仍在 `dataDir`，会话其实可以在当前 session id 上重开，但没有这条路径。

## 修复方案
- 新 hold socket 优先放进运行目录：`$XDG_RUNTIME_DIR/th`，否则 `/run/user/<uid>/th`，再退回短路径 `/tmp/th-<uid>`。连接时仍识别旧 `/tmp/threadharbor-hostd-*` 与 `dataDir/.../control.sock`。
- `session.attach` 在 socket 已死时就地 revive：重启 worker、initialize，先 `session/load` 再 `session/new`。generation 与 ThreadHarbor session id 不变。
- 原生会话被重建时 attach 结果带 `reopened: true`，gateway 写状态记录，子会话标 lost。
- 仍失败时翻译成「在当前会话重开」说明，lost 状态按钮改为「在当前会话重开」。

## 验证步骤
1. ✅ hostd 在 XDG_RUNTIME_DIR 下创建 socket，shutdown 后再 attach 能 revive 并继续 prompt
2. ✅ gateway 把 ECONNREFUSED 译成重开说明，并把 session 标 lost
3. ✅ gateway 在 `reopened: true` 时保持同一 session id 并写入重开记录
4. ✅ 客户端 lost 文案与按钮、错误翻译
5. ⚠️ 升级并重启本机/远端 hostd 后，对已 lost 的会话点「在当前会话重开」

## 相关测试
- `packages/hostd/tests/hostd-integration.spec.ts`
- `packages/dsh-gateway/tests/gateway.spec.ts`
- `packages/dsh-client/tests/store.client.spec.ts`
- `packages/dsh-client/tests/conversation-model.spec.ts`
- `packages/dsh-client/tests/client-artifact.spec.ts`

## 设计建议
- hold worker 生命周期应与用户运行目录绑定，而不是通用 `/tmp`。
- 会话恢复优先就地重开，避免复制出第二条会话打乱当前界面。
- 远端仍运行旧 hostd 时，attach 不会自动 revive，需要先升级 hostd。
