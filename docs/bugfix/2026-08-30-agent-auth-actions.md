# Bug Fix: Claude 与 DSH 认证操作不匹配

## 问题描述

- 日期：2026-08-30
- 严重程度：High
- 影响范围：主机设置中的 Agent 状态、Claude 操作入口、DSH 凭据配置与新会话启动

Claude 被统一显示为需要交互登录；DSH 在缺少 `DEEPSEEK_API_KEY` 时显示“未登录”，但界面没有可用的登录或凭据配置入口。

## 根因分析

- `packages/dsh-client/src/client/RemoteConversation.tsx` 按统一的 `authenticated` 状态渲染登录按钮和“未登录”文案，没有区分 Agent 的凭据模型。
- `packages/hostd/src/agent-manager.ts` 为 DSH 正确地禁用了交互登录，但协议只支持 Grok、Codex、Claude 的普通配置文件，没有 DSH 密钥写入接口。
- DSH 进程只继承 hostd 启动时已有的 `DEEPSEEK_API_KEY`，运行中的 Web UI 无法补充凭据。

## 修复方案

- Claude 改为配置型 Agent：安装完成即不再要求交互登录，界面只保留配置入口。
- 新增 `agent.credential.status` 与 `agent.credential.set` 控制方法，专门管理 DSH API Key。
- 密钥写入远程用户目录下的 owner-only 文件，响应只返回 `configured`，永不回传已保存的密钥。
- 启动新的 DSH hold worker 时把保存的密钥注入其环境；已有的部署环境变量仍作为后备来源。
- DSH 状态文案改为“API Key 已配置/未配置”，并提供密码输入框。

## 验证步骤

1. ✅ Claude inventory 在安装完成后标记为可用，调用交互登录会被拒绝。
2. ✅ DSH API Key 文件权限为 `0600`，状态响应不包含密钥。
3. ✅ 网关只转发 `apiKey`，不把 Web catalog 的 `hostId` 转发给 hostd。
4. ✅ 客户端保存后刷新 inventory，且不请求读取已保存密钥。
5. ✅ TypeScript 类型检查与生产构建通过。

## 相关测试

- `packages/hostd/tests/agent-manager.spec.ts`
- `packages/hostd/tests/hostd.spec.ts`
- `packages/dsh-gateway/tests/gateway.spec.ts`
- `packages/dsh-client/tests/store.client.spec.ts`

## 设计建议

认证、普通配置和密钥配置是三种不同能力。后续新增 Agent 时应由协议显式声明其能力，而不是仅依赖一个通用 `authenticated` 布尔值推断所有操作按钮。
