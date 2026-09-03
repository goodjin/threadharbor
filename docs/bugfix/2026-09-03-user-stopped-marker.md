# Bug Fix: 用户主动停止缺少独立标记

## 问题描述
- 日期: 2026-09-03
- 严重程度: Low
- 影响范围: 远程会话点「停止」后的状态展示

点停止后 gateway 把 turnState 写成 `idle`，transcript 只有「已停止本轮」。会话头回到「已就绪」，侧栏仍显示 backend 名，看不出这是用户主动停的。

## 根因分析
- 问题位置:
  - `packages/protocol/src/index.ts` `RemoteTurnState`
  - `packages/dsh-gateway/src/index.ts` `cancel` / `concludeTurn` / `applyJournalPage`
  - `packages/dsh-client/src/client/conversation-model.ts` `conversationStage`
- 原因: 停止只复用 idle，没有独立 turnState，界面也无法和「本轮正常结束」区分。

## 修复方案
- 增加 `turnState: stopped`。
- `session.cancel` 先 `concludeTurn(..., 'stopped', '用户主动停止')`，再转发 native cancel。
- 后续 native `end_turn` 不能把 `stopped` 改回 idle/running。
- 会话头、transcript 尾和侧栏徽章显示「用户主动停止」/「已停止」。下一轮 prompt 仍会把状态改回 `running`。

## 验证步骤
1. ✅ gateway：cancel 后 turnState 为 `stopped`，transcript 含「用户主动停止」
2. ✅ gateway：native cancel 失败仍留下 `stopped`
3. ✅ gateway：迟到的 `end_turn` 不会覆盖 `stopped`
4. ✅ conversation-model：`stopped` 阶段可见
5. ⚠️ 3081 点停止后，会话头和记录应出现「用户主动停止」

## 相关测试
- `packages/dsh-gateway/tests/gateway.spec.ts`
- `packages/dsh-client/tests/conversation-model.spec.ts`
- `packages/dsh-client/tests/store.client.spec.ts`
