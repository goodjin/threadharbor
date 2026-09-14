# Bug Fix: Agent 提问时用户在聊天框作答，消息被排到阻塞轮次后面，10 分钟后报"prompt timed out"

## 问题描述
- 日期: 2026-09-14
- 严重程度: High
- 影响范围: 所有 Claude 会话（AskUserQuestion 经 ACP `elicitation/create` 下发）。实例：远程主机 us-box-2 上的会话 f35e6c4e，08:14 Claude 提问"bugfix 分支从哪个基线建？"，用户 08:41 在聊天框回复"从远程dev基线建"，Claude 没有任何反应；08:51 hostd 报"远程轮次失败：prompt timed out after 600000ms"；用户重发后再次等待。

## 根因分析
- 问题位置: `packages/dsh-gateway/src/index.ts` `prompt()`；远端 hostd 版本过旧（`0.1.0+9f2e162f562a`）
- 原因一（产品逻辑）: Claude Code 在 AskUserQuestion 期间把新的 `session/prompt` 排队到当前轮次之后，而当前轮次要等 elicitation 的答案才能结束。用户在聊天框输入的答案永远到不了 Claude；卡片又只提供固定选项，没有"其他（自定义）"输入，用户自然会去聊天框打字。
- 原因二（部署）: us-box-2 上的 hostd 早于 2026-09-11 的 1e78f83，没有"后端请求未答时暂停 prompt 空闲守卫"的逻辑，10 分钟后把阻塞的轮次判成超时；旧版超时后还会把排队的 prompt 直接灌给 Agent，进一步堆积。本机 Mac-good 的 hostd（`c7f1bcf5ca54`）已含该逻辑。
- 代码流程: elicitation 帧 → 网关记入 `pendingRequestIds` 并钉 waiting-permission → 用户 `session.prompt` → 网关直接转发 → Claude 排队 → 旧 hostd 10 分钟超时 → 失败帧清空 `pendingRequestIds` → 用户重发 → 再次排队。

## 修复方案
- `packages/dsh-gateway/src/projection.ts`：新增 `elicitationFreeTextField(frame)`，识别表单里的自由文本字段（Claude 标记 `_askUserQuestionCustomAnswer` 的 "Other" 字段，或没有固定选项的 string 属性）。
- `packages/dsh-gateway/src/index.ts`：`prompt()` 先走 `answerOpenRequestWithText`。会话有未答请求时：
  - 请求是带自由文本字段的表单 → 把用户消息作为该字段的答案通过 `session.permission` 送回，记录用户消息、清除未答请求、刷新 lastPromptAt，返回 `accepted` 并附 `answeredRequestId`；不再发 `session/prompt`。
  - 请求只接受固定选择（工具授权）→ 拒绝并提示"请先在卡片中回答"，不把消息排到阻塞轮次后面。

## 验证步骤
1. ✅ 新增网关测试两例：聊天消息作为 AskUserQuestion 自定义答案送达且不发 `session.prompt`；授权卡片打开时聊天消息被拒绝并保持 waiting-permission。
2. ✅ `npm run typecheck` 通过；`npm test` 35 个文件 408 个用例通过。
3. ✅ 重新构建并重启 3081 测试 GUI。
4. ✅ 真实路径：对 f35e6c4e 直接以 `session.permission` 送出 `{action:'accept', content:{question_0_custom:'从远程dev基线建'}}`，Claude 数秒内恢复运行（transcript 从 211 推进到 225，开始执行 git 命令）。
5. ⏳ us-box-2 的 hostd 需要升级到当前版本（主机设置里的"升级 hostd"），否则 10 分钟 prompt 超时仍会误判阻塞在提问上的轮次。

## 相关测试
- `packages/dsh-gateway/tests/gateway.spec.ts` › `delivers a chat message as the free-text answer of an open AskUserQuestion instead of queueing it`
- `packages/dsh-gateway/tests/gateway.spec.ts` › `refuses a chat message while a tool permission card is open, pointing the user at the card`

## 设计建议
- 选择卡片应渲染表单里的自由文本字段（"其他"），让用户不必绕道聊天框。
- 主机版本落后时，侧栏或主机设置应更显眼地提示升级；旧 hostd 的 prompt 超时和新网关的 pending 逻辑互相打架，是这次排查耗时的主因。
