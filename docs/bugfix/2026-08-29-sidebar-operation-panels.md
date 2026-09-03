# Bug Fix: sidebar 操作区拥挤且 SSH 主机添加缺少结果确认

> 历史记录：本文的 UI 复盘发生在旧的 Agent 安装入口仍存在时。当前主机设置只做 Agent 发现、登录、配置和会话创建，不提供 Agent 安装计划。

## 问题描述

- 日期: 2026-08-29
- 严重程度: High
- 影响范围: DSH Web 中 ThreadHarbor 主机、项目、Agent 配置和会话创建操作

原实现把添加主机、添加项目、当时的 Agent 安装/登录/配置和新建会话表单全部放在左侧 sidebar。sidebar 宽度有限，操作密度过高。SSH 自动部署流程中，检查主机密钥后缺少足够明显的结果展示和确认部署路径，用户无法判断下一步如何添加远程主机。

## 根因分析

- 问题位置:
  - `packages/dsh-client/src/client/RemoteSidebar.tsx`
  - `packages/dsh-client/src/client/RemoteConversation.tsx`
- 原因:
  - sidebar 同时承担导航和复杂表单，违反主区域/侧栏职责边界。
  - SSH scan 结果嵌在 sidebar 内，空间不足且反馈不明显。
  - sidebar 与 conversation 之间没有共享的“当前操作面板”状态。

## 修复方案

- 在 `RemoteAgentStore` 增加 browser-local `panel` 状态：
  - `add-host`
  - `add-project`
  - `agent-setup`
  - `new-session`
- sidebar 改为只保留导航和动作按钮：
  - 添加主机
  - 添加项目
  - 当时的安装 / 登录 / 配置 Agent
  - 新建会话
- conversation 主区域新增操作面板：
  - 添加主机表单；
  - SSH 主机密钥检查结果；
  - 指纹确认后部署并添加主机；
  - 添加项目与远端目录浏览；
  - 当时的 Agent 安装计划、登录、配置编辑；
  - 新建会话表单。
- SSH 自动部署现在明确展示：
  - scan target；
  - algorithm；
  - SHA256 fingerprint；
  - “指纹正确，部署并添加主机”按钮；
  - 本地错误和成功反馈。

## 验证步骤

1. ✅ `npm test -- packages/dsh-client/tests/store.client.spec.ts packages/dsh-client/tests/client-artifact.spec.ts`
2. ✅ `npm run check`
3. ✅ 重启 DSH Web
4. ✅ 请求实际服务出的 `/plugins/@threadharbor/dsh-client/client.js`
5. ✅ 确认产物包含：
   - `添加主机`
   - `添加项目`
   - `检查结果：请确认 SSH 主机密钥`
   - `2. 指纹正确，部署并添加主机`
   - `安装 / 登录 / 配置 Agent`
   - `新建会话`
6. ✅ 确认产物不再包含 `@threadharbor/protocol` 外部化泄漏

## 相关测试

- `packages/dsh-client/tests/store.client.spec.ts`
- `packages/dsh-client/tests/client-artifact.spec.ts`

## 设计建议

- sidebar 只做导航和动作入口；任何需要多字段输入、确认、安全信息展示或长文本编辑的流程都应进入主区域。
- SSH host-key 属于安全确认信息，必须在宽区域完整展示，不能只通过按钮状态隐式表达。
