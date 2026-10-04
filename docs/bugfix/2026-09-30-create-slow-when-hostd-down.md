# 创建会话「很慢」：hostd 已停时每个请求死等 45 秒才报错，主机还显示在线

## 问题描述

- 日期: 2026-09-29 晚间发现，2026-09-30 修复
- 严重程度: High
- 影响范围: 3081 测试站的「新建会话」与所有主机 RPC；本机回环主机与 SSH 主机都受影响

用户反馈「创建会话现在很慢，以前是很快的」，等待期间界面一直停在
「正在连接 Agent / 正在与远程主机建立通信通道，通常只需几秒」。

## 现场证据

web.log（gateway 侧）同一份代码、同一天的对比：

| 时期 | session.start 耗时 |
|---|---|
| hostd 存活 | 第一次 728 ms（含起 Agent 进程），之后 24–36 ms |
| hostd 已停 | 整 45,000 ms 后 `hostd request session.start timed out`，会话变 failed |

- 慢会话 ffddad24（项目 agent_society）挂在本机主机 Mac-good（127.0.0.1:62846）。
- 该 hostd 16:43 正常退出后一直没再启动（pid 文件停在 12:32，日志尾部是成对的
  shutdown 记录）；18:19 重启 web 不会把 hostd 带起来。
- 同一时刻 us-box-2 的 SSH 隧道也在超时（清单报「连接 hostd 超时」），两台主机都在
  45 秒死等，所以体感是「创建很慢」而不是「某台主机坏了」。

## 根因分析

三件事叠加，把「主机下线」伪装成了「创建很慢」：

1. **请求不快速失败。** `HostdConnection.request()` 在 socket 未连上时，帧发不出去
   只是留在 pending 里等重连，计时器却是完整的请求预算（hostdRequestTimeoutMs=45s）。
   hostd 死透了的机器上，每个请求都要等满 45 秒才报一个笼统的 timed out。
2. **主机状态是旧的。** 目录里的主机清单没有过期机制：Mac-good 的记录停在 14:07 的
   `healthy: true`，侧栏徽章一直是「在线」，用户没有任何离线信号。协议里早有
   `host.changed` 推送事件，客户端也处理了，但 gateway 从来没发过。
3. **失败原因不落地。** completeStart 失败只把行标成 lost/failed，不写转录记录；界面上
   「原因见上方记录」指着的上方其实什么都没有。而且清单门禁在刷新失败后落到
   `backend is not installed` 的检查上，把「连不上」误报成「没装」。

## 修复方案

1. **未送达请求改用「连接预算」（默认 10 秒，可配 `hostdConnectDeadlineMs`）。**
   帧写到打开的 socket 之前，计时按连接预算走，超时报
   `not delivered: no hostd connection`；一旦真的发出去了，恢复完整的请求预算——
   大会话恢复 legitimately 慢，不能被误杀。socket 中途掉线时，已发送的帧退回
   「未送达」状态继续消耗剩余预算。预算期限在请求发出时就固定为绝对时刻：
   每次重连失败不续期（实测第一版每失败一次续 10 秒，把失败拖到 18.3 秒，
   回归测试钉住了这一点）。
2. **主机状态如实。** callHostd 失败且属于链路断裂（未送达 / 连接被拒 / 管道死等，
   不含「发出去但没回答」的超时，也不含主动关池）时，后台把主机记录标上
   inventoryError 并广播 `host.changed`，侧栏徽章立即翻「离线」，不用等手动刷新。
   成功的调用发现记录上还有离线标记时，后台自动刷新一次清单自愈。
   refreshHostInventory 本身（手动刷新、部署、升级）现在也广播 host.changed。
3. **失败原因落地。** 创建失败按既有边界区分：链路断开 → channelState `reconnecting`
   （下次成功调用自愈，与 markPromptUndelivered 同一条规则）；hostd 明确拒绝 →
   `lost`。同时在转录里写一行「会话创建失败：…」的真实原因。清单门禁在刷新失败时
   直接抛「主机 X 当前不可达：…」，不再落到误导性的「backend is not installed」。
4. **测试注入点对齐。** setHostdSocketFactory 重建连接池时同步带上连接预算（否则
   测试里的预算被默认 10 秒顶掉，正是修测试时抓到的坑）。

环境侧：本机 hostd 已用 `scripts/dev.sh start hostd` 拉起；本地回环 hostd 的
自动拉起明确不做（用户已选「快速失败 + 状态如实」）。

## 验证步骤

1. `npx vitest run`：500 条全绿（37 个文件，含新增 8 条）。
2. `npx tsc -b tsconfig.json`：退出码 0。
3. `npm run build` + `node scripts/verify-build.mjs`：通过。
4. 3081 实测（重建部署后，用一次性探针脚本走 gateway WS）：停掉本机 hostd 再
   新建会话——创建后 **10.07 秒**失败（修复前 45 秒），转录记录
   「会话创建失败：无法连接到主机上的 hostd（请求未送达）。主机恢复后可重新创建会话。」，
   主机徽章 10.05 秒翻「离线」（收到 host.changed 推送）；拉起 hostd 并刷新清单后
   徽章自愈回「在线」。探针会话已删除。

## 相关测试

- `packages/dsh-gateway/tests/hostd-connection.spec.ts`
  - rejects an unsent request at the connect deadline, long before the request timeout
  - still delivers a request that gets a socket within the connect deadline
  - narrows a sent request back to the connect deadline when the socket drops
  - keeps the full request budget for a request that was sent on an open socket
  - does not extend the connect deadline across failed reconnect attempts（续期回归）
- `packages/dsh-gateway/tests/gateway.spec.ts`
  - fails a session create fast and honestly when the host is already known unreachable
  - marks the host offline and records an honest failure when a create hits an unreachable hostd
  - clears the offline badge and creates sessions once hostd answers again
  - 测试环境新增 killPort/revivePort：死端口的 socket 模拟 ECONNREFUSED（创建后即
    error+close），重连阶梯照常推进，和真实拒连行为一致
