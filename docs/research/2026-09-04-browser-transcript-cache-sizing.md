# 浏览器端 Transcript 本地缓存可行性调研

- 日期: 2026-09-04
- 触发问题: 刷新页面后"会话内容都没了"，是 3081 用户在问：现在会话内容是不是只存 gateway、浏览器本地没缓存？
- 范围: 仅调研事实与体量，不包含实现方案。

## 问题

为"在浏览器端为会话内容（transcript）做持久缓存、缓解刷新后正文丢失"做事实依据：

1. 单条 `RemoteTranscriptEntry` 的体积构成与典型字节数。
2. Gateway 端单会话条数上限的默认值与配置位置。
3. 浏览器一次 `catchupTranscript` / `backfillOpenedTranscript` 的加载上限。
4. "1万 token / 1000 条"的会话折合多少 KB、能否放进 `localStorage` 的 5 MB / origin 配额。
5. 是否还有更上游的丢失源（gateway 自己裁剪、journal 丢失）。

## 结论

- 单条 `RemoteTranscriptEntry` JSON 体积**主要由 `text` 决定**；外壳固定开销约 150–180 B；不含 `nativeFrame` 的纯文本消息通常 250 B – 2.2 KB；含 `nativeFrame` 的工具事件可达 2–10 KB。
- Gateway 端单会话**上限默认 10000 条**（稳定 / 测试 channel 同值）。超出按 `seq` 升序删除最早条目——这是浏览器缓存之前就发生的丢失源。
- `transcript.read` 单页默认 **100 条**，硬上限 **256 条**。浏览器 `catchupTranscript` 在 `priority='high'` 时递归拉完当前会话的全量；`backfillOpenedTranscript` 再向前翻页直到 `oldest.seq <= 0` 或 `!hasMore`。**当前会话会被一次性全部加载到浏览器内存**。
- 用户的 "1万 token / 1000 条" 场景折合约 **1–3 MB JSON**，可放进 `localStorage`。
- 按 gateway 10000 条 cap 估算的"长会话"体量约 **10–30 MB JSON**，**超过 `localStorage` 5 MB / origin 上限**，必须用 **IndexedDB**。
- 推荐方案：**IndexedDB** 替代 `localStorage`，并把 gateway 的裁剪行为当作不可绕过的丢失源另行处理（参见"建议的下一步"）。

## 证据

### 1. `RemoteTranscriptEntry` 字段构成

`packages/protocol/src/index.ts:271-282`：

```ts
export interface RemoteTranscriptEntry {
  readonly transcriptId: RemoteTranscriptId   // 字符串 ID，30–80 字符
  readonly sessionId: RemoteSessionId          // ~24 字符 ULID-like
  readonly seq: number                          // 1–5 字符
  readonly role: 'user' | 'assistant' | 'system' | 'tool' | 'permission'
  readonly kind: 'message' | 'reasoning' | 'tool-call' | 'tool-result' | 'status' | 'permission'
  readonly text: string                         // 0 ~数十 KB；正文主项
  readonly createdAt: string                    // ISO 24 字符
  readonly nativeFrame?: JsonValue // 可选，工具事件会带，整段原生 frame JSON
  readonly requestId?: string
}
```

`transcriptId` 的实际拼接形态：

- `packages/dsh-gateway/src/index.ts:1040` `user:${sessionId}:${clientId}:${requestId}`
- `packages/dsh-gateway/src/index.ts:1138` `reopen:${session.sessionId}:${attached.generation}:${attached.latestSeq}`
- `packages/dsh-gateway/src/index.ts:1502` `gap:${session.sessionId}:${page.generation}:${page.droppedThrough}`
- `packages/dsh-gateway/src/index.ts:1525` `native:${session.sessionId}:${page.generation}:${event.seq}:${fragmentIndex}`
- `packages/dsh-gateway/src/index.ts:1630` `turn:${session.sessionId}:${turnState}:${...}`

`nativeFrame` 只在 ACP / DSH 协议事件里塞原 frame（`packages/dsh-gateway/src/projection.ts:179-183` 的 `projectNativeFrame`），但 entry 字段保留它意味着 `nativeFrame` 本身可能 1–10 KB。

### 2. Gateway 单会话上限

- 默认值（生产 stable channel）：**10000 条**
  - `deploy/channels/stable.patch.yml:8` `maxTranscriptEntriesPerSession: 10000`
  - `deploy/channels/test.patch.yml:7` 同上
- Schema 校验：`packages/dsh-gateway/src/index.ts:335` `z.natural().min(1).required()`
- 裁剪代码：`packages/dsh-gateway/src/index.ts:1722-1726`

  ```ts
  const excess = [...this.requireTables().transcript.entries()]
    .filter(([, candidate]) => candidate.sessionId === sessionId)
    .sort((left, right) => left[1].seq - right[1].seq)
    .slice(0, -this.config.maxTranscriptEntriesPerSession)
  for (const [id] of excess) await this.requireTables().transcript.delete(id)
  ```

  按 `seq` 升序保留最新 N 条，老条目直接 `delete`，不进冷库也不打标记——**先于浏览器缓存被删**的丢失源。

### 3. 浏览器侧加载上限与行为

- 单页常量：`packages/protocol/src/index.ts:285-287`
  - `REMOTE_TRANSCRIPT_PAGE_SIZE = 100`
  - `REMOTE_TRANSCRIPT_PAGE_MAX = 256`
- Gateway 处理：`packages/dsh-gateway/src/index.ts:524` 收到 `transcript.read` 后用 `limit` 参数（默认 100、硬顶 256）。
- `catchupTranscript`（`packages/dsh-client/src/client/store.ts:1609-1632`）：
  - `priority: 'high'`（当前会话、attach 后跟新）：**递归**拉直到 `latest <= localLast`。
  - `priority: 'low'`（后台）：只拉一页，不够就 `enqueueBackgroundTranscript` 再排队。
- `backfillOpenedTranscript`（`packages/dsh-client/src/client/store.ts:1634-1651`）：当前会话**向前翻页**直到 `oldest.seq <= 0` 或 `!page.hasMore`，所以单会话**最多会被一次性全部拉入浏览器内存**。

### 4. 体积估算

UTF-8 计：1 个汉字 = 3 B，1 个 ASCII = 1 B；JSON 编码后再加 ~10–20% 包装。`text` 之外的字段加起来约 150 B 固定开销。

| 场景 | 单条 entry 字节 | 1000 条 | 10000 条（cap） |
|---|---|---|---|
| 用户短句（text 50 B）+ 元数据 | ~300 B | ~300 KB | ~3 MB |
| Assistant 中等回答（text 2 KB） | ~2.2 KB | ~2.2 MB | ~22 MB |
| 工具事件 + nativeFrame | ~5 KB | ~5 MB | ~50 MB |
| 1万 token 回复（text 40 KB） | ~42 KB | — | — |

"1万 token / 1000 条"的典型混合（1 条 1万 token + 999 条普通消息）：

- 1 × 42 KB + 999 × 0.5 KB（中位数，含部分 reasoning、tool-call）≈ **0.5 MB JSON**
- 折算 `localStorage` 配额（典型 5 MB / origin）：**完全够用**。

"全量 10000 条"的典型混合（200 条工具事件 5 KB + 9800 条短文本 300 B）：

- ≈ **11 MB JSON**
- 折算 `localStorage`：**超出 5 MB**。

### 5. 浏览器存储 API 现状

- `localStorage` 同步、5 MB / origin（实测 Chrome 5 MB、Firefox 10 MB、Safari 5 MB），所有 key 共享配额。
- `localStorage.setItem` 单 key 在写入时会一次性同步序列化全部字符串——超过 1 MB 时主线程 jank 已可见。
- 当前 `localStorage` 已用 key（grep `packages/dsh-client/src/`）只存元数据：

  | Key | 内容 | 位置 |
  |---|---|---|
  | `dsh.remote-agent.current-session-id` | 当前选中的会话 ID | `store.ts:230-247` |
  | `dsh.remote-agent.display-preferences` | 侧栏每项目上限、自动归档阈值 | `display-preferences.ts:62-77` |
  | `dsh.remote-agent.session-preferences` | 会话视图偏好 | `RemoteConversation.tsx:1019-1032` |
  | `dsh.remote-agent.transcript-scroll-memory` | 滚动位置 | `transcript-scroll-memory.ts:19-47` |
  | `dsh.remote-agent.browser-id` | 浏览器实例 id | `ws-transport.ts:114-121` |
  | `dsh.remote-agent.client-id` | 客户端 id（sessionStorage） | `store.ts:1832-1835` |

  没有 transcript 写入压力，但也**没有任何 key 缓存消息正文**——这是"刷新后变空白"的根因之一。

## 推断与不确定性

- "1万 token"对应中文字符约 1 万个 → UTF-8 30–40 KB，基于 1 char ≈ 1 token 的粗略估计；如果 token 是更细的 BPE，单条 entry 可能更大，但仍受 `maxTranscriptEntriesPerSession: 10000` 约束。
- "典型会话"的混合比例是从代码里出现的 `kind` 推断（user / assistant 占多数，tool / nativeFrame 在工具类 backend 才高频）。没有真实样本，1 KB 中位数是合理估计、不是测量值。
- Gateway KV 是否对单 value 设字节上限：grep 仓库内未发现 per-value 限制（`maxRequestBytes: 1048576` 只约束 HTTP 请求体，不约束 KV value）。Cap 按条目数裁剪，不会因为单条过大导致超容——这一点**需要确认 Cordis KV 的实际行为**。
- `localStorage` 5 MB 配额在不同浏览器表现略不同；Firefox 是 10 MB、严格来说更宽松。但本文结论按最严格的 5 MB 估算。

## 建议的下一步

1. **首选 IndexedDB**，不要再上 `localStorage`：
   - 5 MB 上限无法安全覆盖 gateway 10000 条上限对应的会话；
   - 同步 API 在 1 MB 以上会卡主线程；
   - IndexedDB 异步、能存几百 MB，正好对应 cap 后单会话 ~11 MB 的体量。

2. 缓存策略（写到 doc 后再实施）：
   - 每个浏览器实例一个 IndexedDB store，`key = sessionId`，`value = { entries: RemoteTranscriptEntry[], lastSeq: number, updatedAt: number }`。
   - 写入时机：每次 `applyTranscriptEntries` 后 debounce 写盘（避免每条一次 IPC）。
   - 读取时机：`catchupTranscript` 之前先 `transcript.read(afterSeq)`，再用 cache 补 `beforeSeq` 的历史（取代或并行于 `backfillOpenedTranscript`）。
   - 容量策略：单会话上限 ≈ 10000 条（与 gateway 对齐），超限按 `seq` 删最早；整个 DB 上限可设 50–100 MB。
   - 数据校验：`parseTranscript` 反序列化失败就丢弃该条目，不要让脏数据卡住后续 reload。

3. **顺手修一个更根上的问题**：gateway `maxTranscriptEntriesPerSession: 10000` 默认值会让长会话**永远丢历史**，跟浏览器缓存无关。需要决策方：要么降级到"归档到文件 / 冷库"而不是直接 `delete`，要么给一条 UI 提示让用户知情。

4. 在动手前需要拍板的两点：
   - 是否接受"本地缓存只是兜底、gateway 仍是 source of truth"——不做 conflict resolution？
   - 单浏览器所有会话的 IndexedDB 总配额预算（50 MB / 100 MB / 不限）？