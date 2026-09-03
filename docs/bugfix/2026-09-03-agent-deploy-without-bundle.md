# Bug Fix: 3080 连接本机未部署 DSH 时没有部署按钮

## 问题描述
- 日期: 2026-09-03
- 严重程度: High
- 影响范围: 主机设置中的 Agent 部署入口；连接本机后 DSH/Grok/Codex/Claude 未安装时的操作

3080 稳定版连接本机后，DSH 显示未安装，但没有部署按钮。此前为了不再随 ThreadHarbor 打包 Agent 二进制，把 `agent.install` / `agent.install.plan` 和界面上的安装入口一并删除了。

## 根因分析
- 问题位置:
  - `packages/dsh-client/src/client/RemoteConversation.tsx`（Agent 行只提示“请在远端主机安装”）
  - `packages/hostd/src/agent-manager.ts`（不再提供 installPlan/install）
  - `packages/protocol/src/index.ts`（去掉 `agent.install` 与 `agent-install` 操作）
- 原因: 下线离线 bundle 时把“在目标主机执行官方安装命令”的部署能力一起删掉了。产品要求是不打包 Agent，但保留点部署后在相应主机上执行部署指令。

## 修复方案
- 恢复 `agent.install.plan` / `agent.install` 和后台操作 `agent-install`。
- hostd 在目标主机执行官方命令：`npm install -g` 写入该 Node 的 global prefix，DSH 用 `python3 -m pip install --user deepseek-harness-runtime-bin==0.1.1rc1` 写入 Python user scripts。不另开 ThreadHarbor 安装前缀，也不携带离线 bundle。
- 主机设置未安装行重新显示“部署”；确认前展示计划中的命令，确认后排队执行。

## 验证步骤
1. ✅ 定向测试：hostd Agent 安装计划/假 npm/假 pip、gateway `agent-install` 转发、client 解析与 `operation.start`
2. ✅ `npx tsc -b tsconfig.json`
3. ⚠️ 需重建 client 制品并硬刷新 3080/3081 后，在浏览器点本机 DSH 的部署按钮验证

## 相关测试
- `packages/hostd/tests/agent-manager.spec.ts`
- `packages/hostd/tests/hostd.spec.ts`
- `packages/dsh-gateway/tests/gateway.spec.ts`
- `packages/dsh-client/tests/store.client.spec.ts`
- `packages/dsh-client/tests/client-artifact.spec.ts`
