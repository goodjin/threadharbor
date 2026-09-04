# Transcript 持久化策略：决策记录与实施计划

- 日期: 2026-09-04
- 范围: gateway 端 `transcript` KV 表的容量策略
- 非范围: hostd native journal 的容量策略（已由 `max-journal-events` / `max-journal-bytes` 控制，本地行为独立）
- 状态: 待用户拍板

## 问题

当前 gateway 在 `packages/dsh-gateway/src/index.ts:1722-1726` 对单会话超出 `maxTranscriptEntriesPerSession`（生产 `deploy/channels/stable.patch.yml:8` 默认 10000）的条目执行**直接 delete**，且**没有给消费者发任何信号**：

```ts
const excess = [...this.requireTables().transcript.entries()]
  .filter(([, candidate]) => candidate.sessionId === sessionId)
  .sort((left, right) => left[1].seq - right[1].seq)
  .slice(0, -this.config.maxTranscriptEntriesPerSession)
for (const [id] of excess) await this.requireTables().transcript.delete(id)
```

后果：

1. **数据无声丢失**：旧条目被删，浏览器重新 attach / 刷新时只看到截断后的尾部。
2. **没有 gap 信号**：浏览器以为 `seq` 是连续的，cache / replay / 跨设备 follow 都会"看到"一个被截断的历史却无法提示用户。
3. **不对称**：hostd native journal 有 `droppedThrough` + `gap:` 事件（`packages/hostd/src/hold-worker.ts:408-419`、gateway `index.ts:1502`），但 gateway projected transcript 没有任何 gap 机制——下层做了，上层被绕过了。
4. **用户预期不匹配**：用户以为 ThreadHarbor 持久化"远程会话"，实际会话正文有上限。`docs/README.md:3` 的承诺是"浏览器或 SSH 断开时，会话仍由远程 `threadharbor-hostd` 与 detached hold worker 继续运行；Web 重连后按 journal cursor 补齐记录"——这层承诺被静默打破。

## 现状

### 全部 transcript 访问路径

- `gateway/src/index.ts:1244-1253` `deleteSessionRecords`：`session.delete` 触发的全量清理
- `gateway/src/index.ts:1249-1250` 同一函数里按 sessionId 删 transcript
- `gateway/src/index.ts:1301-1303` `prompt`：user 消息 append
- `gateway/src/index.ts:1330-1333` `prompt`：failure 状态条目 append
- `gateway/src/index.ts:1630-1633` turn 状态切换（idle/running）时 append status
- `gateway/src/index.ts:1501-1502` hostd gap 投影：append `gap:` 假条目
- `gateway/src/index.ts:1650-1655` `sessionTranscriptEntries`：readTranscript 的 helper
- `gateway/src/index.ts:1697-1704` `appendTranscript`：单条 append
- `gateway/src/index.ts:1706-1733` `appendTranscriptBatch`：批量 append + **环删（1722-1726）**
- `gateway/src/index.ts:1779-1781` `replayTranscriptTail`：WebSocket 推尾页

### hostd 的归档现状

- `hostd/src/hold-worker.ts:408-419` `trimJournal` 已经做环裁
- 用 `droppedThrough` seq 标记"以下都已丢"
- hostd → gateway 的 `hold.read` 返回值带 `gap: boolean` + `droppedThrough` 字段（`hostd/src/hold-worker.ts:436-441`）
- gateway 在 `index.ts:1501-1502` 把 `gap: true` 投影成 `transcriptId: gap:...` 的假条目并 append
- **但 projected transcript 自己的环裁没有产生任何 gap 标记**

### 客户端的 transcript 消费

- `RemoteConversation.tsx:1951, 2286` 直接 `state.transcript.filter(entry => entry.sessionId === ...)` 然后 `transcript.map(...)` 渲染
- 没有搜索 / 全文检索 / 导出功能（`grep -rn "search\|export" packages/dsh-client/src/` 无命中相关功能）
- 客户端缓存（本次接好的 `TranscriptCache`）只缓存 gateway 当前持有的内容
- 因此**当前没有"必须保留历史 transcript"的消费场景**——但用户看到"刷新后空白"的体感来自环裁，与是否有消费场景无关

## 选项评分

评分标准（5 分制，分越高越好；weight 是重要度）：

| 准则 | 权重 | 含义 |
|---|---|---|
| 数据保护 | 5 | 是否减少信息丢失 |
| 实施成本（低=高） | 4 | 代码 + 测试 + 部署成本 |
| 存储可预期 | 3 | gateway 磁盘是否可控 |
| 用户清晰度 | 3 | 用户能否理解"什么丢了 / 怎么找回来" |
| 长期运维 | 2 | 持续运行的复杂度和出错面 |
| 测试覆盖 | 2 | 验收测试需要的工作量 |

### 选项 A：冷归档到第二个 KV 表 + `transcript.read.archive` RPC

把"环裁即 delete"改成"环裁即迁移"。`appendTranscriptBatch` 把超额条目写到 `transcript-archive` 表（同样的 keyPath：`${sessionId}:${transcriptId}`），加 RPC `transcript.read.archive` 让浏览器按需拉归档段。归档表本身需要一个独立的 retention（建议 90 天）。

- 数据保护：**5**（条目全部保留可读）
- 实施成本：**1**（gateway + protocol + client + tests 共约 280 LOC；新 RPC + 新 UI panel）
- 存储可预期：**1**（归档表无上限，需要单独 cron 清理；运维风险高）
- 用户清晰度：**4**（用户能看到归档，但需要知道"看老消息要去另一个 panel"）
- 长期运维：**2**（cron 任务 / 配额监控 / 归档索引）
- 测试覆盖：**2**（迁移、archive 读取、retention cron 都得测）
- **加权总分：54**

### 选项 B：UI 提示（加 gap 信号，不动数据）

加 `droppedThrough: number` 到 `RemoteSessionView`，gateway 在环裁时把已删 seq 的边界写入 session 视图；浏览器 attach 时若发现 `droppedThrough > 0`，渲染一个常驻 banner："Earlier history was rotated. <N> earlier entries are no longer available."

- 数据保护：**1**（条目仍然 delete，无补救）
- 实施成本：**5**（gateway 1 行 / protocol 1 字段 / client 1 个 banner；总约 80 LOC + 50 LOC tests）
- 存储可预期：**4**（沿用当前 cap，无新增长）
- 用户清晰度：**5**（明确告诉用户丢了什么、无法找回）
- 长期运维：**4**（零新组件）
- 测试覆盖：**4**（单一信号通路）
- **加权总分：85**

### 选项 C：把默认上限从 10000 降到比如 3000

一行配置变更。问题更早触发，但**机制完全不变**——还是无声删除。

- 数据保护：**1**
- 实施成本：**5**
- 存储可预期：**4**（少占一些）
- 用户清晰度：**1**（仍然无声）
- 长期运维：**5**
- 测试覆盖：**5**
- **加权总分：73**

但 C 是**反优化**——把"长会话能保留的历史"从 10000 砍到 3000，对有真实长会话的用户是更糟的体验，只是把问题提前到更短的时间窗。**不推荐**。

### 选项 D：用户显式归档（gateway 默认不裁，按需触发）

取消自动环裁；加 `session.archive.history` RPC 接受 `{ sessionId, keepLatest, archiveOlder }` 参数，把 keepLatest 之外的条目迁移到归档表（或直接 delete，依参数决定）。浏览器加一个"Archive old messages"按钮给用户主动触发。

- 数据保护：**4**（数据保留完全由用户控制；如果用户不主动归档，存储会涨）
- 实施成本：**3**（gateway + protocol + client；约 180 LOC + 100 LOC tests）
- 存储可预期：**3**（依赖用户行为；需要"硬上限"兜底——比如 50 万条强制 delete）
- 用户清晰度：**5**（用户主动操作、决定保留多少）
- 长期运维：**3**（需要监控 + 兜底逻辑）
- 测试覆盖：**3**（多路径）
- **加权总分：81**

### 评分汇总

| 选项 | 加权总分 | 推荐阶段 |
|---|---|---|
| A 冷归档 + 新 RPC | 54 | 阶段 2（次里程碑） |
| **B gap 信号 + banner** | **85** | **阶段 1（本周）** |
| C 降默认 | 73 | **不推荐** |
| D 显式用户归档 | 81 | 阶段 3（A 之后可作为 A 的补充） |

## 决策

**采用分两阶段路线**：

### 阶段 1（立即，~1–2 天）：选项 B

- gateway 端：维护 `droppedThrough[sessionId]` 状态；环裁时记录 `droppedThrough = max(deleted seq) + 1`
- protocol：`RemoteSessionView` 加 `droppedThrough?: number`
- gateway 投影：在 `state` 返回的 session 列表里带 `droppedThrough`
- client：检测 `droppedThrough > 0` 时在 conversation view 顶部渲染 banner
- 测试：1 个 gateway 测试（环裁触发 `droppedThrough` 更新）+ 2 个 client 测试（banner 出现 / 不出现）

**这个阶段的承诺**：诚实告诉用户"历史被轮转了"，不做任何数据保留。

### 阶段 2（下一里程碑，~1 周）：选项 A

在阶段 1 的 `droppedThrough` 之上，加归档表和 RPC：

- gateway：新增 `tables.transcriptArchive`，`appendTranscriptBatch` 改成"move not delete"
- protocol：加 `transcript.read.archive` RPC + `RemoteArchivePage` 类型
- client：加一个"Earlier history"折叠面板，点击后调 RPC 拉归档段
- 归档 retention：默认 90 天，可配置；超出后**真正 delete**（这次用户知情）
- 测试：move / read.archive / retention cron

**阶段 2 完成后**：B 的 banner 升级为"Earlier history available (N entries, click to load)"。

### 阶段 3（探索性）：选项 D 作为 A 的补充

A 让"归档总是存在"，D 让用户**主动控制保留多少**。两个可以共存：

- D 的"keepLatest=3000, archive rest" 复用 A 的归档表
- 用户从"被动看到 banner"升级为"主动按需归档"
- 仅在用户反馈"想控制保留量"时实施

### 明确不采纳

- **C 降默认**：反优化，不解决根因
- **A 单独上**：投资大、风险高，先做 B 收窄行为面
- **D 单独上**：把"是否保留"的责任完全推给用户，与 ThreadHarbor "持久化远程会话"的产品定位不匹配

## 实施计划

### 阶段 1 详细计划

1. **gateway：track droppedThrough per session**
   - 新增 `droppedThrough: Record<sessionId, number>` 到 gateway global state
   - `appendTranscriptBatch` 在 `excess.delete` 前，把 `excess[excess.length - 1].seq + 1` 写入 `droppedThrough[sessionId]`
   - `deleteSessionRecords` 时也清掉对应 key
   - `RemoteSessionView` 投影时取 `droppedThrough[sessionId]`
   - 改动位置：`packages/dsh-gateway/src/index.ts:1244-1253, 1706-1733, 1698-1701`（parse session 段落）

2. **protocol：加字段**
   - `packages/protocol/src/index.ts:255-269`（`RemoteSessionView`）加 `droppedThrough?: number`
   - 不动 RPC 列表（`state` 投影自动带新字段）

3. **client：banner 组件**
   - `RemoteConversation.tsx:2286` 渲染前查 `session.droppedThrough`
   - `droppedThrough > 0` 时在 transcript 上方插一个 sticky banner
   - 文案建议："Earlier history was rotated. <N> earlier entries are no longer available."
   - 不动 transcript 列表本身

4. **测试**
   - `packages/dsh-gateway/tests/gateway.spec.ts`：构造场景让一个 session 累计 > cap 10000 条，断言下一次 `state` 投影里 `droppedThrough` = 第一个被删的 seq
   - `packages/dsh-client/tests/store.client.spec.ts`：mock 一个带 `droppedThrough: 42` 的 session，断言 `RemoteConversation` 渲染出 banner 文案
   - 不需要新增 e2e 测试

### 阶段 2 详细计划（待阶段 1 完成后细化）

参见上文"阶段 2"段。关键点：

- 环裁逻辑改为 `await tables.transcriptArchive.put(...)` 替代 `delete`
- 归档表的 retention 走一个独立的 `setInterval`，每 24h 跑一次
- RPC 走和 `transcript.read` 一样的分页形态

## 假设与风险

**假设**：

- ThreadHarbor 当前没有 transcript 搜索/导出/合规归档功能（已 grep 验证）；A 的"用户主动查归档"动机主要来自好奇/不放心，不是合规需要
- Browser 端 `TranscriptCache`（本任务上一阶段已接好）的 50MB IDB 配额能覆盖活跃会话的 10000 条上限；A 上线后活跃会话 cache 不变，归档不会进 cache
- hostd native journal 的环裁跟 gateway projected 环裁是独立事件，**互不感知**；阶段 1 只解决 gateway 侧 gap 信号，hostd 的 gap 已经走 `gap:` 假条目机制

**风险**：

- 阶段 1：banner 文案需要 UX 复核——"rotated"是工程术语，用户可能不理解（建议下一轮 UX pass）
- 阶段 2：归档表无上限；如果 retention 配错，gateway 磁盘可能涨到 GB 级。需要 monitoring 配合（独立任务）
- 阶段 3：D 的"硬上限"参数需要拍一个数；如果某用户 hard cap 设得太大，仍然会涨

## 未决问题（需要用户拍板）

1. **阶段 1 的 banner 文案**：是否需要先用"Earlier history was rotated (engineering term)"还是更用户友好的"This conversation's older messages are no longer available"？
2. **阶段 2 的 retention 默认值**：90 天合理吗？还是按"项目 / session"分配置？
3. **阶段 1 的部署顺序**：先在 stable channel 灰度一周再推 test，还是直接 stable？
4. **是否同步给用户发一个 release note**：解释"rotated"机制变化？

## 后续动作

- 等用户对阶段 1 文案 / 部署顺序 / retention 默认值三件事拍板
- 拍板后由一个独立任务实施阶段 1（不在本次任务范围）
- 阶段 2、阶段 3 在阶段 1 上线后另立 ADR