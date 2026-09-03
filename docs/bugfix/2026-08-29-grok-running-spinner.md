# Bug Fix: Grok 已就绪但持续显示转圈

## 问题描述

- 日期: 2026-08-29
- 严重程度: Medium
- 影响范围: DSH Web 的主机库存和 Agent 管理界面
- 表现: 本机 Grok 已安装、已认证且服务已运行，但状态点持续旋转；没有项目时主区仍提示添加主机，用户无法判断下一步。

## 根因分析

- 问题位置: `packages/dsh-client/src/client/RemoteSidebar.tsx`、`RemoteConversation.tsx`
- 原因: 前端把库存字段 `running` 映射成 DSH `StateDot` 的 `ongoing`。`ongoing` 是操作进行中的动画状态，而库存中的 `running` 表示后台服务已经就绪。
- 后端原因: hostd 依赖未配置的 `GROK_AGENT_SECRET` 环境变量；发现端口已有监听时仍继续连接，导致 hold worker 永久等待未经认证的 WebSocket，最终只显示 `control.sock` 不存在。
- 附带问题: 空会话页只判断有没有会话，没有区分“无主机”“有主机但无项目”“有项目但无会话”。

## 修复方案

- 新增共享的 `backendInventoryState`，将“已安装、已认证、支持会话”映射为 `done`。
- 主机库存和 Agent 管理面板统一使用该映射。
- 空会话页根据当前准备阶段展示“添加主机”“添加项目”或“新建会话”的正确入口。
- hostd 在私有数据目录生成并持久化 Grok Agent 密钥，重启后复用；密钥只写入 owner-readable hold 配置。
- Grok WebSocket 连接增加明确超时，detached worker 输出写入每个 hold 的 `worker.log`，启动失败时回传日志尾部。

## 验证步骤

1. ✅ 直接请求 hostd inventory，确认 Grok 返回 `installed/authenticated/running/sessionCapable = true`。
2. ✅ 直接请求 gateway state，确认本机库存同步成功。
3. ✅ 客户端针对性测试通过；完整 `npm run check` 通过（12 个测试文件、31 个测试及构建）。
4. ✅ 重载 3081 页面，确认 Grok 显示绿色就绪点且主区显示“添加项目”。
5. ✅ 使用独立临时端口运行真实 Grok，`session.start` 成功完成 ACP `initialize + session/new` 并返回原生会话 ID。

## 相关测试

- `packages/dsh-client/tests/store.client.spec.ts`

## 设计建议

- `running` 只表示后台服务进程状态；只有会话 turn 或真实异步操作才应使用 `ongoing` 动画。
