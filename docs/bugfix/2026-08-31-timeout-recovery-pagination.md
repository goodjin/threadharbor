# Bug Fix: 超时后会话长时间无法恢复

## 问题描述

- 日期: 2026-08-31
- 严重程度: High
- 影响范围: 长会话的 journal 恢复、Web 状态轮询和新会话创建等待
- 表现: 页面出现 `TimeoutError: signal timed out` 后，状态和恢复请求继续超时，看起来会话永久不可用。

## 根因分析

- 问题位置: `packages/dsh-client/src/client/store.ts`、`packages/dsh-gateway/src/index.ts`、`packages/hostd/src/server.ts`、`packages/hostd/src/hold-worker.ts`
- 浏览器控制请求固定 30 秒，但 Gateway 允许 hostd 请求执行 45 秒，外层可能先于实际后端结果超时。
- hostd 的 `events.read` 返回游标之后的整个 journal；实机会话一次返回约 2000–4000 个 native event。
- Gateway 对每个投影 fragment 分别写 transcript 和全局序号。DSH storage domain 的每次写都要求先完成后端 durability，大页因此占用事件循环数分钟。
- 浏览器超时不会取消已经进入 Gateway 的恢复操作；后续轮询继续到达，用户只能看到连续超时。hold worker、generation 和 journal 实际仍然存活。

## 修复方案

- hold worker 的 `read` 增加可选 limit；hostd 验证 1–1024 的范围，并在监督层再次截断，兼容仍在运行的旧 hold worker。
- Gateway 每次最多处理 64 个 native event，并按最后已处理事件推进 `lastSeq`，而不是跳到 journal 尾部。
- 连续 assistant message/reasoning delta 在一页内合并；native transcript id 由 session、generation、event seq 和 fragment index 稳定派生，重试不会重复追加。
- 一页 transcript 共用一次全局序号持久化和一次过期清理，避免逐 fragment 更新全局状态。
- 浏览器外层控制请求上限调整为 75 秒，覆盖 Gateway 的 45 秒 hostd 边界和投影持久化余量；定时同步在错误后继续运行。

## 验证步骤

1. ✅ 新增 130 个 native event 的 Gateway 恢复测试，三次调用分别推进到 seq 64、128、130，每页连续文本只产生一个 transcript entry。
2. ✅ hold worker limit 测试通过；hostd 使用故意忽略 limit 的旧 worker fixture 时仍只返回一条，验证滚动升级兼容。
3. ✅ 类型检查、14 个测试文件、64 个测试和全部构建通过。
4. ✅ 测试 Web `3081` 重启后，真实 `state` 为 54 ms、`events.read` 为 73 ms，会话保持 `open/idle`。
5. ✅ 本机 hostd 在不终止旧 hold 的情况下重启；generation 保持 `4ea4a303-af49-45dd-9351-bfdf47599211`，监督层把旧 worker 的大页截成 1 条，实测 16 ms。

## 相关测试

- `packages/dsh-gateway/tests/gateway.spec.ts`
- `packages/hostd/tests/hold-worker.spec.ts`
- `packages/hostd/tests/hostd-integration.spec.ts`

## 设计建议

- 所有可增长的恢复日志必须同时具有传输页大小和持久化工作量上限。
- 外层超时必须大于内层超时，并且不得把超时等同于远端执行失败。
- detached worker 滚动升级时由监督层兼容旧协议，不能为了升级分页能力强制终止现有会话。
