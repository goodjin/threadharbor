# AgentHarbor、SessionPort 与 ThreadHarbor

这三个项目名称相近，但解决的是不同层次的问题。以下结论只采用各项目自己的 README、文档和 release 信息。

> ThreadHarbor 一列的描述按 2026-10-10 仓库现状复核过：多主机迁移完成后，hostd 与
> gateway 已下线，agent 以 DSH 原生 ACP 插件的形式跑在提供页面那台机器的进程内。

## AgentHarbor

[`abhiunix/AgentHarbor`](https://github.com/abhiunix/AgentHarbor) 是 macOS/Windows 原生托盘应用，主要统一查看 Claude Code、Cursor、Codex、Gemini CLI 等工具的额度、token、session 用量和估算花费，并把 MCP、rules、skills、hooks、plugins 与 sub-agent 定义部署到各工具的本地配置。它还读取本机 transcript、plans、memory 与权限配置，使用 OS keychain 保存部署 secret。

AgentHarbor 的目标是本机多工具运营、配置治理和用量观测。它没有公开的远程 host daemon、detached per-session worker、Agent 原生连接持有或跨 Web 断线 journal 重放机制。它与 ThreadHarbor 可以互补：前者管本机工具配置与消费，后者管远程执行生命周期。

## SessionPort

[`Den1style/sessionport`](https://github.com/Den1style/sessionport) 是 Chrome MV3 扩展。它让当前模型把对话提炼为 JSON snapshot，再把 snapshot、prompt 或附件注入 Claude、ChatGPT、Grok、Gemini、Mistral、DeepSeek、Perplexity 等网站。它提供 snapshot 历史、搜索、项目过滤、diff、mind map、导入导出和可选 Google Drive 同步。

SessionPort 所称的 session/context transfer 是模型生成的上下文交接，不是迁移或恢复平台原生 session。它没有继续运行 Agent 进程；snapshot 保存后可以在另一个网站重新建立语境。配套的 [`sessionport-ios`](https://github.com/Den1style/sessionport-ios) 是 iOS 键盘扩展，但公开资料不足以确认 Chrome↔iOS 同步是否已经完成。

## 差异表

| 维度 | AgentHarbor | SessionPort | ThreadHarbor |
| --- | --- | --- | --- |
| 主要目标 | 本机多工具配置、额度与用量 | 跨 AI 网站搬运上下文 snapshot | 外部 ACP agent 的持续执行与控制（接进 DSH Web） |
| 运行位置 | Tauri 桌面/托盘 | Chrome；另有 iOS 键盘 | DSH Web 本体 + 进程内 ACP 插件；agent 子进程/连接由 DSH 进程持有，无独立 daemon |
| 会话语义 | 读取本机已有 transcript | 模型提炼的 JSON snapshot | DSH 原生会话日志：ACP 帧投影成原生会话事件，界面直接复用 |
| 断线后执行 | 不负责 Agent 执行 | 没有执行进程 | 网页断开不影响回合（agent 归 DSH 进程所有）；DSH 进程重启则回合结束，历史从会话日志恢复 |
| 控制能力 | 配置部署、备份、漂移检查 | 捕获、注入、历史与 diff | 提问、取消、权限审批桥接、按会话隔离的外部对话、真机活测 |
| 数据所有权 | 本机 local-only | 浏览器 IndexedDB/用户 Drive | 会话归各自主机的 DSH；agent 凭据留在各自机器，不经过浏览器 |

可以借鉴但不应混淆的能力：AgentHarbor 的 adapter registry、配置 diff 与 drift detection 适合用于外部 agent 的发现与配置治理；SessionPort 的可移植 snapshot 与跨模型 handoff 适合作为以后独立功能。它们都不能替代 ThreadHarbor 的持续执行（agent 进程与连接由宿主持有）、原生会话日志投影和真机活测。
