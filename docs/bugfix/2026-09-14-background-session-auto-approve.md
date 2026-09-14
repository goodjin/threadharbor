# Bug Fix: 自动批准的会话在后台时权限请求无人应答

## 问题描述
- 日期: 2026-09-14
- 严重程度: High
- 影响范围: 所有设置为"自动批准"（approvalChoice=auto）、"跳过确认"（Claude bypass）、"完全访问"（Codex full-access）或 Agent 自身处于 bypassPermissions / agent-full-access 模式的会话。只要浏览器当前显示的是别的会话，这些会话一收到权限请求就停在 `waiting-permission`，直到用户切换过去才被自动应答。

## 根因分析
- 问题位置: `packages/dsh-client/src/client/RemoteConversation.tsx` 中 `RemoteConversation` 组件内的 `useEffect`
- 原因: 自动批准是一个 React effect，依赖当前会话的 `session`、`sessionEntries`、`preferences`。该组件只为 `currentSessionId` 对应的会话渲染，后台会话的 `waiting-permission` 状态虽然通过 `session.view.changed` 推送到了 store，但没有任何代码去看它。
- 代码流程: hostd 转发 `session/request_permission` → gateway 投影为 permission 条目并把 turnState 置为 waiting-permission → 推送到浏览器 store → 只有当前会话的组件效果会去找 pending 卡片并调用 `store.permission`。

## 修复方案
- 新增 `packages/dsh-client/src/client/permission-autopilot.ts`：纯函数 `scanAutoApprovals(sessions, transcript, resolve)` 遍历全部会话，对处于 waiting-permission 且（浏览器偏好为自动 / 后端模式为 bypass）的会话，找出待答的权限卡片并算出应答选项。本地 transcript 落后于 `latestTranscriptSeq` 时不应答，而是报告需要先追 transcript，避免用过期卡片答错请求。
- `packages/dsh-client/src/client/store.ts`：
  - 新增 `setAutoApprovePreferences(resolver)`，由会话界面注入浏览器本地偏好（localStorage + 内存），store 自身不读偏好。
  - 每次 `publish()` 后以 `setTimeout(0)` 调度一次扫描；需要追 transcript 的会话触发 high 优先级 catchup，需要应答的调用 `permission()`。
  - `answeredPermissions` 集合按 (session, requestId) 去重，手动点击的 `permission()` 也会登记，避免同一请求被答两次。
- `RemoteConversation.tsx`：删除原来的自动批准 effect，改为注册偏好解析器；手动点击路径不变。

## 验证步骤
1. ✅ 新增 `packages/dsh-client/tests/permission-autopilot.spec.ts`（4 例）：后台会话被应答、过期 transcript 先追不答、非权限类提示（elicitation）与非等待会话不动。
2. ✅ `store.client.spec.ts` 新增 2 例：当前会话为 s-active 时，后台 claude 会话（bypassPermissions）收到权限请求后 store 自动读取 transcript 并发出 `session.permission`（optionId=allow），当前会话不变，重复的 view 推送不会二次应答；偏好为"每次询问"的会话不会被自动应答。
3. ✅ `npm run typecheck` 通过，`npm test` 34 个文件 401 个用例全部通过。
4. ✅ 重新构建并重启 3081 测试 GUI，服务端下发的 client bundle 已包含新逻辑。
5. ⏳ 真实 Agent 路径：当前网关里有一个 claude 会话（标题 "s"）正处于 waiting-permission；浏览器刷新页面后，若该会话的权限设置为自动批准/跳过确认，应在不切换会话的情况下被自动应答。本机 Chrome 扩展未连接，未能在浏览器内实际观测，需人工确认。

## 相关测试
- `packages/dsh-client/tests/permission-autopilot.spec.ts`
- `packages/dsh-client/tests/store.client.spec.ts` › `auto-approves a permission request on a background session without switching to it`
- `packages/dsh-client/tests/store.client.spec.ts` › `does not auto-approve a waiting session whose preferences say ask`

## 设计建议
- 现在的自动批准仍依赖浏览器在线。若浏览器关闭，自动模式的会话遇到权限请求依然会等到浏览器重新打开。要彻底解决需要把"自动批准"作为会话属性交给 gateway（例如随 `session.configure` 持久化），由 gateway 在投影 permission 帧时直接应答。
- `approvalChoice=auto` 目前只存在于浏览器；Claude/Codex 的 bypass/full-access 会通过 configOptions 同步到 Agent，后者不需要浏览器也能免确认，是当前更可靠的用法。
