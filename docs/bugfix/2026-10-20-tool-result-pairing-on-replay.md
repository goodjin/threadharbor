# 2026-10-20 · 切换模型后请求被拒：会话里的工具调用与结果没有配对

## 问题描述

用户反馈：会话 `session-7165a323-7364-42b8-bc2a-cba7b7aa7e7d` 切换 Agent 后，
MiniMax 一直报

```
MiniMax request failed (400): invalid params, tool call result does not follow tool call (2013)
```

同一个会话切到 zcode（GLM）却一直正常。

## 现场证据

- 日志里 MiniMax 从第 17 轮起连续 6 次这样失败（`turn/end` 的 reason 是
  `error`，错误码 `UNKNOWN`，正文就是上面那句 2013）。
- 该会话的模型路线换过三段：`acp:acp-codex/gpt-6-astra` →
  `acp:acp-zcode/GLM-5.3` → `acp:acp-minimax/MiniMax-M3.1-Flash` →
  `acp:acp-zcode/GLM-5.3`。失败都发生在 MiniMax 那段。
- 把这份日志按会话的可见历史重放一遍（重放用的是仓库里真实的请求体构造
  代码），得到 382 条 anthropic 消息，其中 **10 处配对不合法**：
  - 5 处「工具调用没有结果」：`01a158f9…`、`01a15901…`、`01a15903…`、
    `01a15906…`、`01a1590b…` 这 5 个 `subagent` 调用，发起它们的助手消息
    后面没有紧跟它们的结果；
  - 5 处「结果没有紧跟它的调用」：这 5 条结果挤在另一条 `other` 调用的
    后面（第 306 条消息），跟它们应答的调用隔了几百条消息。
- 这 5 个 `subagent` 调用就是上一轮事故（`2026-10-20-acp-total-cap-killed-a-live-turn.md`）
  里被总上限掐掉的那批子代理：它们的 `tool/call` 记了，结果一直没落盘。

## 根因分析

两层，各管一半：

- **保存层（DSH 核心，我们的代码之外）**：回合被打断时，核心的补救逻辑给
  还没结果的调用补一条「结果未知」的 `tool/result`，补在**日志末尾**，而不是
  补在它应答的那次调用旁边。日志因此忠实地记下了「调用在这里、结果在两百条
  消息之后」。
- **重放层（我们的代码）**：MiniMax / GLM 两条模型通道把会话历史转成
  anthropic 消息格式时，只做格式翻译，不检查配对，原样发出去。
  anthropic 消息格式要求「每个 tool_use 由紧跟其后的那条 user 消息里的
  tool_result 应答」，MiniMax 严格校验，GLM 宽松——这就是同一个会话切 GLM
  没事、切 MiniMax 就 400 的原因。

同样的历史交给 DSH 自带的 DeepSeek 通道也会被拒（它的序列化器对「结果没有
对应的调用」直接报 `INVALID_REQUEST`），所以这不是 MiniMax 独有的挑剔。

## 修复方案

**在发请求前把历史重新配对**（`packages/dsh-preset-dispatch/src/tool-pairing.ts`）：

- 结果记在别处的，搬回它应答的那次调用旁边；
- 调用始终没有结果的，补一条「结果未知」的错误结果——措辞与 DSH 核心的
  补救说法一致（可能仍在后台跑，不等于失败；只在只读或幂等时重试）；
- 找不到对应调用的结果（孤儿结果）不进这次请求；
- 同一个调用 id 出现两次时，后一次的那条调用块去掉（一个 id 只能被应答一次）。

**会话日志、界面显示、保存层都不动**：日志保留事实，界面看到的内容不变，
只有发给模型的那一份历史在每次请求时重新配对。

## 验证步骤

- 新增 `packages/dsh-preset-dispatch/tests/tool-pairing.spec.ts`（6 个用例）：
  配对正常时历史原样不动；结果搬回调用旁；调用没结果时补「结果未知」；
  孤儿结果不进请求；一条助手消息的多个调用在同一条用户消息里被应答；
  端到端过一遍真实的 anthropic 请求体，配对问题为零。
- 新增 `packages/dsh-preset-dispatch/tests/model-plugin-pairing.spec.ts`
  （3 个用例）：两条模型通道发给服务商的确实是重新配对过的历史。
- **修复前这两个文件是红的**（模块不存在 / 历史没配对）。
- 用报错的会话日志重放：配对问题从 **10 处降到 0 处**，请求体从 382 条消息
  变成 400 条（多出来的是搬回调用旁的结果）。
- **真机活测**（MiniMax 托管网关，本机 MiniMax Code 登录）：同一段漂移的历史，
  修复前 400 `tool call result does not follow tool call (2013)`，修复后 200
  并正常作答。
- 全仓 `npm run typecheck` + `npm run test`（1883 个用例）通过。

## 相关测试

- `packages/dsh-preset-dispatch/tests/tool-pairing.spec.ts`
- `packages/dsh-preset-dispatch/tests/model-plugin-pairing.spec.ts`
