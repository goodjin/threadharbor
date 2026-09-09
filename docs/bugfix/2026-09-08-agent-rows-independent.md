# Bug Fix: 主机设置里每个 Agent 的展开收起与部署进度相互独立

## 问题描述
- 日期: 2026-09-08
- 严重程度: Medium
- 影响范围: 主机设置（`HostPanel`）里的 Agent 列表（`AgentSetupPanel`）

主机设置的 Agent 列表是手风琴式互斥的：点开一个 Agent 会收起另一个，且所有 Agent 共用同一份部署计划、operationId、busy 标记等瞬时状态。收起/切换行会把另一个 Agent 的行内内容（配置编辑器、登录流程、DSH Key 表单）清掉或覆盖；同时部署多个 Agent 时，后一个部署会覆盖先前的 `operationId`，前一个的部署进度、完成后的刷新互相干扰。

## 根因分析
- 问题位置: `packages/dsh-client/src/client/RemoteConversation.tsx` `AgentSetupPanel`
- 原因: `AgentSetupPanel` 用单个 `openBackend: RemoteAgentBackend | undefined` 表示展开状态（天然只允许一行展开），并把 `auth` / `config` / `configOpen` / `plan` / `operationId` / `dshApiKey` / `busyAction` / `localError` 等所有行内数据放在面板级共享。展开行 B 时 `clearOther` 清掉行 A 的数据；同一面板里后启动的部署会覆盖共享的 `operationId`。

## 修复方案
- 把每一行抽成独立的 `AgentSetupRow` 组件：展开/收起状态、部署计划、install operationId、配置编辑器、登录流程、DSH Key 表单、busy 与错误全部是该行自己的 state。
- 多行可同时展开；收起只影响当前行，行内瞬时状态保留，重新点开接着上次进度。
- 每个 Agent 独立跟踪自己的部署 operation，进度按 `hostId + backend` 从 operation 列表派生，A 的部署/进度不影响 B。
- 部署成功后的 plan 清理与 inventory 刷新改为每行各自的 effect，并用 `settledOperationRef` 保证只刷新一次（已完成 operation 会留在 gateway operation 列表里，不加守卫的话每次快照变化都会重触发刷新）。

## 验证步骤
1. ✅ `npm run typecheck`：`dsh-client` 无错误（工作区另有 `dsh-gateway/src/run-usage.ts` 的既有错误，与本次改动无关）
2. ✅ `npx vitest run packages/dsh-client/tests`：8 个文件 144 个用例通过
3. ⚠️ 刷新 3080，打开某台主机的设置：连续点开两个 Agent，应都保持展开、互不收起
4. ⚠️ 在未安装的两个 Agent 上先后部署，两行应各自显示各自的部署计划与进度；部署完成各自刷新状态，互不清空

## 相关测试
- `packages/dsh-client/tests/store.client.spec.ts`
- `packages/dsh-client/tests/conversation-model.spec.ts`
