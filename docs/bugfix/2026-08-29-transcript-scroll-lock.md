# Bug Fix: 会话滚动条持续自动拉到底部

## 问题描述

- 日期: 2026-08-29
- 严重程度: High
- 影响范围: 所有持续轮询或流式输出的远程会话

用户向上滚动阅读历史内容时，会话区域会在下一次轮询或新片段到达时立刻回到底部。

## 根因分析

- 问题位置: `packages/dsh-client/src/client/RemoteConversation.tsx`
- 原因: transcript 每次轮询都会得到新引用，effect 无条件执行 `scrollTop = scrollHeight`，没有记录用户是否主动离开底部。

## 修复方案

- 监听 transcript 容器的滚动事件，以距离底部 48px 为“仍在跟随”阈值。
- 仅在以下情况自动滚到底部：
  - 切换到另一个会话；
  - 用户原本就在底部；
  - 用户主动发送新消息。
- 用户向上滚动离开底部后，轮询和流式片段不再改变当前位置。

## 验证步骤

1. ✅ TypeScript 类型检查通过。
2. ✅ 滚动阈值与 transcript 视图模型测试通过。
3. ✅ client store 回归测试通过。
4. ✅ browser artifact 构建和校验通过。

## 相关测试

- `packages/dsh-client/tests/conversation-model.spec.ts`
- `packages/dsh-client/tests/store.client.spec.ts`

## 设计建议

- 实时消息列表应采用 sticky-bottom 语义，而不是在每次数据刷新时无条件滚动。
