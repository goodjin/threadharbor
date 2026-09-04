# Bug Fix: 发送失败只提示、不能恢复也不能重开

## 问题描述
- 日期: 2026-09-04
- 严重程度: High
- 影响范围: 会话主区发送失败 / 本轮失败
- 会话: `992ee62d-892c-434d-a0e0-dd24f1bfcf66`（Claude）

该会话发送消息一直失败，界面只显示失败，没有恢复，也没有「在当前会话重开」。

## 现场证据
- catalog：`channelState=open`、`turnState=failed`、`binding.state=active`、`holdId=f9e394a6-2c2e-4569-bfc6-132cf002c16c`
- `web.log`：`turn failed session=992ee62d-… reason=hold-unreachable connect ENOENT /tmp/th-501/h-f9e394a6-….sock`
- 之后 hold 可能被别的路径拉起来，但 catalog 仍把通道标成 open，输入框可发，`session.prompt` 再打到死 hold 就只剩「发送失败」

## 根因分析
- 问题位置:
  - `packages/dsh-gateway/src/index.ts` `prompt` / `projectJournalPage`
  - `packages/dsh-client/src/client/conversation-model.ts` `sessionActionGates`
  - `packages/dsh-client/src/client/RemoteConversation.tsx` 失败横幅
- 原因:
  1. `session.prompt` 在 hold 不可达时只把 `turnState` 写成 `failed`，通道仍是 `open`。
  2. `projectJournalPage` 只要不是 `lost` 就把通道改回 `open`。follow 循环已经标了 `reconnecting`，排队的旧 journal 一投影，按钮又没了。
  3. 「在当前会话重开」只挂在通道横幅上，且 `canReconnect` 只看 `reconnecting` / `lost`。发送失败横幅没有按钮。

## 修复方案
- hold 死后发消息：先 `session.attach` 拉起 hold 再重试同一条 prompt；仍失败则标 `lost`，文案指向「在当前会话重开」。
- 浏览器同样在 hold 死亡时 attach 一次再重试，兼容尚未加载新 gateway 的运行实例。
- journal 投影不再把 `reconnecting` / `lost` 改回 `open`。
- 本轮失败或发送失败也给出 `canReconnect`，按钮挂在用户实际看到的那条失败横幅上。

## 验证步骤
1. ✅ gateway：死 hold 的 prompt 会 attach 后重试；attach 也失败则 `lost` 并提示重开
2. ✅ gateway：reconnecting 会话投影后续 journal 仍保持 reconnecting
3. ✅ store：ENOENT 的 prompt 会 attach 再试；attach 失败则 `promptProgress=failed` 且文案含「在当前会话重开」
4. ✅ conversation-model：`turnState=failed` 或发送失败时 `canReconnect=true`
5. ⚠️ 刷新 3080 后打开 `992ee62d-…`，失败横幅应有「在当前会话重开」；点了应能继续发。若 hold 仍活着，下一条消息应直接发出

## 相关测试
- `packages/dsh-gateway/tests/gateway.spec.ts`
- `packages/dsh-client/tests/store.client.spec.ts`
- `packages/dsh-client/tests/conversation-model.spec.ts`
