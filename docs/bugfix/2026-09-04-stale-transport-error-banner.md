# Bug Fix: 有输出时「实时通道失败」横幅不消失

## 问题描述
- 日期: 2026-09-04
- 严重程度: Medium
- 影响范围: 会话主区通道横幅
- 会话: `8b73ba1c-be4b-419e-8ff0-5e4b80d35957`

会话一直在输出，但横幅停在「实时通道失败 / 浏览器无法连上网关。稍后会自动重试。」

## 根因分析
- `snapshot.phase === 'error'` 来自任意 RPC 失败（`run()` / 目录刷新），不是 WebSocket 挂了。
- 界面把这个 phase 当成实时通道失败。
- 后续 transcript 推送走 `withoutError`，只去掉 `error` 字段，**不清 phase**。文案回落到默认的「无法连上网关」，横幅一直在，输出照常。

## 修复方案
- 通道横幅只在 `transportPhase === 'reconnecting'` 时提示断开重连。RPC 失败不再显示成「实时通道失败」。
- 通道仍为 `open` 时，error phase 不禁用输入。
- 实时推送到达且传输层是 ready 时，把残留的 error phase 收成 ready。

## 验证步骤
1. ✅ conversation-model：error phase + 正在输出 → 无通道失败横幅，可停止本轮
2. ✅ store：RPC error 后收到 transcript.append → phase 回到 ready
