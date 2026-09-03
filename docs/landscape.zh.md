# AgentHarbor、SessionPort 与 ThreadHarbor

这三个项目名称相近，但解决的是不同层次的问题。以下结论只采用各项目自己的 README、文档和 release 信息。

## AgentHarbor

[`abhiunix/AgentHarbor`](https://github.com/abhiunix/AgentHarbor) 是 macOS/Windows 原生托盘应用，主要统一查看 Claude Code、Cursor、Codex、Gemini CLI 等工具的额度、token、session 用量和估算花费，并把 MCP、rules、skills、hooks、plugins 与 sub-agent 定义部署到各工具的本地配置。它还读取本机 transcript、plans、memory 与权限配置，使用 OS keychain 保存部署 secret。

AgentHarbor 的目标是本机多工具运营、配置治理和用量观测。它没有公开的远程 host daemon、detached per-session worker、Agent 原生连接持有或跨 Web 断线 journal 重放机制。它与 ThreadHarbor 可以互补：前者管本机工具配置与消费，后者管远程执行生命周期。

## SessionPort

[`Den1style/sessionport`](https://github.com/Den1style/sessionport) 是 Chrome MV3 扩展。它让当前模型把对话提炼为 JSON snapshot，再把 snapshot、prompt 或附件注入 Claude、ChatGPT、Grok、Gemini、Mistral、DeepSeek、Perplexity 等网站。它提供 snapshot 历史、搜索、项目过滤、diff、mind map、导入导出和可选 Google Drive 同步。

SessionPort 所称的 session/context transfer 是模型生成的上下文交接，不是迁移或恢复平台原生 session。它没有继续运行 Agent 进程；snapshot 保存后可以在另一个网站重新建立语境。配套的 [`sessionport-ios`](https://github.com/Den1style/sessionport-ios) 是 iOS 键盘扩展，但公开资料不足以确认 Chrome↔iOS 同步是否已经完成。

## 差异表

| 维度 | AgentHarbor | SessionPort | ThreadHarbor |
| --- | --- | --- | --- |
| 主要目标 | 本机多工具配置、额度与用量 | 跨 AI 网站搬运上下文 snapshot | 远程 Agent 持续执行与控制 |
| 运行位置 | Tauri 桌面/托盘 | Chrome；另有 iOS 键盘 | DSH Web gateway + 远程 hostd/worker |
| 会话语义 | 读取本机已有 transcript | 模型提炼的 JSON snapshot | 后端原生 session、frame 与实时状态 |
| 断线后执行 | 不负责 Agent 执行 | 没有执行进程 | Agent 继续运行，重连后按 cursor 重放 |
| 控制能力 | 配置部署、备份、漂移检查 | 捕获、注入、历史与 diff | prompt admission、取消、权限、目录、子会话 |
| 数据所有权 | 本机 local-only | 浏览器 IndexedDB/用户 Drive | 每个 Web 部署独立 catalog；凭据留在远程主机 |

可以借鉴但不应混淆的能力：AgentHarbor 的 adapter registry、配置 diff 与 drift detection 适合用于 ThreadHarbor 的远端 Agent 发现和配置治理；SessionPort 的可移植 snapshot 与跨模型 handoff 适合作为以后独立功能。它们都不能替代 ThreadHarbor 的 detached execution、原生连接所有权和日志恢复。
