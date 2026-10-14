# 2026-10-15 · 选了 Cursor 仍报「LlmError code must be a non-empty string」

## 问题描述

用户在会话里把模型切到 Cursor（`acp:acp-cursor`）再发消息，回合失败：

> 本轮运行失败 LlmError code must be a non-empty string

三轮重发都是同一句，看不出外部 agent 到底出了什么事。

## 现场证据

会话事件日志（`~/.dsh-threadharbor-test`，workspace `nexa-service/apps/desktop`）三轮
形状完全一致：

- `model/selection provider=acp:acp-cursor model=grok-4.7`，`request/context` 同路由。
- `assistant/attempt` 里只有一个 finish 块，失败内容写得很清楚：
  「外部 agent 连接已断开：acp agent did not answer within 60000ms。重新发送这条
  消息即可重试」——**只有 message，没有 code**。
- 紧接着的 `turn/end` 却变成 `message="LlmError code must be a non-empty string"
  code="UNKNOWN"`：真正的原因被自己的报错顶掉了。

## 根因分析

网关把外部回合的结束翻译成原生循环认识的 finish 块时，失败对象只带了
`message`，没带 `code`。而原生循环拿到一个失败结局后，会用它的
`message` 和 `code` 重新构造自己的失败类型（参考仓
`packages/core/agent-loop/src/agent.ts`），那个构造器要求 `code` 是非空字符串——
于是校验失败，抛出这句关于「参数不合法」的话，把 agent 已经说清楚的
「连接已断开、可以重发」整个盖掉。

两端的类型各写各的：网关自己的失败类型就只声明了 `message`，所以编译器
也认为没传 `code` 是对的。测试里所有失败用例都只断言 `kind`，没人断言
`code`，这条路径一直没有被看见。

## 修复方案

- 网关的失败类型把 `code` 变成必填，并在翻译结束结局时补齐：
  - 运行器已经分类过的失败（`ACP_ERROR` / `ACP_CONNECTION` / `ACP_PERMISSION` /
    `ACP_INTERNAL` / `REPLAY_REJECTED`）原样带过去，行上原有的诊断和
    「重发即可」提示都保留；
  - 运行器没给 code 的失败归到 `ACP_ERROR`；
  - 中止用 `ABORTED`——这是原生侧认得的码，被停下的回合显示为「已停止」
    而不是「出错、值得重试」。
- 回归测试两条：七种结束结局（error 带码 / 不带码 / 无 error / blocked /
  handover / aborted 带 reason / aborted 无 reason）产出的失败都带非空 message
  和非空 code；运行器自己的码原样透传。

## 验证步骤

- 全仓类型检查干净；全仓 942 个测试通过（4 个 live 探针按设计跳过）。
- 复现场景重放：finish 块现在带 `code="ACP_CONNECTION"`，turn/end 不再出现
  那句参数校验错误，改回 agent 自己的话。

## 备注：修好之后你会看到的真实原因

这次盖住的是**症状**。上面三轮日志里的真实原因是
「acp agent did not answer within 60000ms」——Cursor 那个外部会话在 60 秒
握手窗口内没有应答。修复后这句话会正常显示出来，连接问题需要另查
（先确认 `cursor-agent acp --trust` 能手工起会话）。

## 相关测试

- gateway.spec：失败结局必带非空 code；运行器的码透传。