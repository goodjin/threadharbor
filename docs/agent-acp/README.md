# 各 Agent 的 ACP 对接

每个 agent 一份。写的是**怎么接上去**和**哪里会出错**，不是协议教程。

| Agent | 状态 | 传输 | 文档 |
|---|---|---|---|
| **grok** | ✅ 已实现，已实测 | WebSocket（密钥在查询参数） | [grok.md](./grok.md) |
| **codex** | ✅ 已实现，已实测 | stdio | [codex.md](./codex.md) |
| **claude code** | ✅ 已实现，已实测 | stdio | [claude-code.md](./claude-code.md) |
| **Cursor** | 📄 官方支持，未接入 | stdio | [cursor.md](./cursor.md) |

已实现的三个共用的代码在 `packages/dsh-acp-agent/`：传输、客户端、投影、审批桥接是共用的，**每个 agent 只提供一个 dialect**。

## 三家的字段差异对照

这张表是分出 dialect 的全部理由。差异都在「读哪个字段」，协议本身三家一致。

| | grok | codex | claude |
|---|---|---|---|
| **工具名** | `title`（**仅第一帧**） | `kind`（如 `execute`；**根本没有名字**） | `_meta.claudeCode.toolName` |
| **工具输出** | `content`（**双层嵌套**） | `rawOutput.formatted_output`（**没有 content**） | `content`（双层）/ `rawOutput` / `_meta…toolResponse.stdout` |
| **模型列表** | `models.availableModels` | `models.availableModels` | `configOptions[id=model].options`（**没有 models 字段**） |
| **token 数** | 更新帧 `params._meta.totalTokens` | `session/prompt` **响应** | `session/prompt` **响应** |
| **终端子协议** | **要**（五个方法全实现） | 不需要 | 不需要 |
| **默认模式** | — | — | **`bypassPermissions`，须切 `default`** |

**共用的一条铁律**：工具名必须**锁定**——三家都会在后续帧覆写名字或标题，不锁定就会被冲掉。

## 四条踩过就会懂的通则

1. **权限请求必须用 JSON-RPC 响应回同一个 id。** 用通知回会被静默接受，回合永不返回。实测挂满 240 秒，无错误、无超时、无后续帧。
2. **`usage_update` 不是 token 数。** 它带的是上下文窗口占用 `{used, size}`。真实用量在别处。
3. **握手通过 ≠ 能用。** codex/claude/grok 的 `initialize` 和 `session/new` 都不需要登录；Cursor 更极端——本机实测握手一路绿灯，真发提示词返回「未授权」。
4. **终端子协议要五个方法全实现。** 只实现 `terminal/create` 看起来是「半能用」：回合结束，但工具结果是一句抱怨。

## 验收门

`packages/dsh-acp-agent/tests/live.spec.ts` 是接新 agent 的验收标准，需设 `THREADHARBOR_LIVE_ACP=1` 才跑（要真二进制、真模型、几分钟墙钟时间）。

每个 agent 必须独立跑通：**建会话 → 提问 → 拿到回答 → 工具调用投影正确**，外加**权限请求被批准后回合继续**。

默认套件是封闭且快的，不跑这个。「你改了投影」之后、相信它可用之前，跑一次。

## 加一个新 agent 要动的地方

1. `packages/dsh-acp-agent/src/dialects/<name>.ts` — 实现 `AcpDialect`：工具名、输出、模型列表、token、噪声过滤
2. `packages/dsh-preset-dispatch/src/factory.ts` — 在 `DIALECTS` 里登记
3. preset 配置里声明 `agent` / `command`（或 `url`）
4. **实测抓帧**，存进 `tests/fixtures/captured-frames.json`，补一份本文档式的说明

第 4 步不能省。三家的差异全都不是从代码或文档里能看出来的——codex 把输出放在 `rawOutput` 里、grok 的工具名只在第一帧、claude 自己跟自己不一致——全是跑起来才看见的。
