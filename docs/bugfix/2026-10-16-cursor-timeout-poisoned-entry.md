# 2026-10-16 · Cursor 反复握手超时：实例载着修复前的旧构建 + 失败不清 entry 让重试永远撞同一堵墙

## 问题描述

会话 `session-f60dcf2b-9923-4df1-ac3a-f5a6defd8e4a`（3081 实例，DSH home
`~/.dsh-threadharbor-test`）选 Cursor 发 "hello"，60 秒后失败：

> 本轮运行失败 外部 agent 连接已断开：acp agent did not answer within 60000ms。
> 重新发送这条消息即可重试，下一次会自动连接新的外部会话。

重发依旧失败，同一台实例上另外两个会话也是同样形状（应答迟到、in-place error）。

## 现场证据

- 会话事件日志：17:04:23 turn/start，17:05:23（整整 60 秒）超时收尾——是
  deadline 打死，不是中途断流。
- 3081 实例拉起的 cursor-agent 进程（17:04:23 生）：命令行**没有 `acp` 参数**，
  存活 17 分钟以上，`lsof` 无任何 TCP 连接，`sample` 全线程空闲在 kevent——
  交互模式占着 stdin 等终端输入，永远不会应答 JSON-RPC。
- 直接实测二进制：裸跑 initialize 150 秒零应答；`cursor-agent acp --trust`
  initialize 260ms、authenticate 3.3s、session/new 6.2s 拿到 sessionId。
- 磁盘上的构建（lib）经 `stdioArgsFor` 验证返回 `["acp","--trust"]`，修复
  （45c81fa，10-14）在 main 上且完整。
- 3081 实例 15:03 启动；lib 在 15:08 被重新构建过——进程加载的是修复前的
  旧产物，之后不会自己更新。

## 根因分析

两层叠加：

1. **运行中的实例载着修复前的旧构建**。10-14 已修过「spawn 漏 `acp` 子命令」
   （见 `2026-10-15-cursor-missing-acp-subcommand.md`），但 3081 是在旧 lib
   上启动的，修复对它不存在。进程内存里的模块不会因磁盘重建而换血——
   这不是代码 bug，是「改了代码必须重启实例」的运维事实。
2. **连接类失败不清 entry，重试永远复用卡死的连接**（真 bug，本次修）。
   网关把 `entry.session` 存进表后，握手超时只让这一轮报错结束，entry 原样
   留着；runner 忘掉的只是外部会话号，transport、client、卡死的子进程都还在
   entry 里。下一次「重试」复用同一个 transport，再等满 60 秒再超时——错误
   文案承诺的「下一次会自动连接新的外部会话」没有兑现，直到重启 dsh。

## 修复方案

`gateway.ts`：回合以 `ACP_CONNECTION` 结束时调用自身的 `close(sessionId)`——
删 entry、杀子进程，下一问重新 open、重新握手、重新 prime 全部历史。
非连接类错误（`ACP_ERROR` 等）保留会话：agent 自己报的错，会话还活着，
继续同一场对话省掉全量 primer。`GatewayStepEnd` 的 error 成员补上可选
`code` 字段（运行时本来就在流，类型先前没写）。

运维侧：重启 3081（以及桌面 App——它 15:02 启动，同样载着旧构建；顺带装载
10-16 新增的套餐限额插件行）。

## 验证步骤

- 新增两条网关测试：连接类失败后丢弃 entry（下一问开新会话、旧 client 被
  close 一次）；非连接类失败保留会话（重试继续同一场对话、只喂增量）。
- 全仓 typecheck + 1161 个测试通过 + 构建过新鲜度门禁。
- 真机链路：手动以 `acp --trust` 拉起真二进制，握手三步计时如上。

## 相关测试

- gateway.spec：「连接类失败自动丢弃会话」「非连接类失败保留外部会话」。

---

# 附：同日关联问题 ·「被打断且无正文」的轮次在历史里整个消失

## 现象与根因

会话 ef20f6ac 第 17 轮（58 步、70 次工具调用、零段正文）重启打断后，重开
会话界面只剩用户的请求，所有过程内容不可见、也没有可点的折叠行。对照同会话
第 1、2 轮（同样 interrupted 但有正文）一直显示正常，定位为显示层死角：已
结束轮次的过程内容默认折叠，aborted/error 豁免而 interrupted 不豁免，无
正文锚点时折叠行也渲染不出来。数据从未丢失（磁盘记录完整）。

## 治本（2026-10-16 用户拍板）

客户端新增 `interrupted-turn-recovery.ts`：往轮次结尾的
`conversation.chat.turnTail` 列表座位（折叠范围之外）挂一条兜底行，只在
「已关闭 + interrupted + 无正文锚点 + 确有过过程内容」命中时渲染，按钮调用
聊天存储现成的 `setTurnProcessOpen(turn, 0, true)`——与官方折叠行的展开
同一条路，展开后本行自动消失。见
`packages/dsh-client/tests/interrupted-turn-recovery.spec.ts`。
