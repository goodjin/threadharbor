# Bug Fix: 对话记录投影延迟 4～9 秒 —— transcript 放错了存储后端

## 问题描述
- 日期: 2026-09-12
- 严重程度: High
- 影响范围: 所有会话的实时展示。Agent 每产出一页 journal（十几条 tool 帧），浏览器要晚 1～9 秒才看到；web 进程 CPU 常驻 100%、RSS 1.6GB。用户反馈"会话响应很慢"，实测 grok 侧每轮思考 5～16 秒是真实耗时，但 ThreadHarbor 自己又在上面叠加了中位 4.3 秒、最大 9.1 秒的投影延迟。

## 根因分析
- 问题位置: `packages/dsh-gateway/src/index.ts` `appendTranscriptBatch`（逐条 `tables.transcript.put`）+ `packages/dsh-gateway/src/spec.ts`（transcript 表定义在 `remote_agent` 存储域内）。
- 原因: DSH 的 json 存储后端（`@deepseek-ai/dsh-storage-json`）每写一条记录就把整个域文档 `JSON.stringify(…, null, 2)` 后 tmp 写入、fsync、rename。`remote_agent.json` 累积到 121MB（29,461 条 transcript，其中 `nativeFrame` 占 50MB）。实测单次写 = stringify 120ms（阻塞事件循环）+ 写盘 fsync 200ms。一页 12 条 tool 帧 = 12 次 put + global.set + session.put ≈ 14 次整文件重写 ≈ 5～7 秒。
- 佐证: 用 hostd journal 帧时间戳与网关 transcript `createdAt` 按内容对齐，87 条样本 p50 4.34s / p90 6.91s / max 9.10s；hostd 侧 wait-page 推送 0.7ms 即时返回，排除 hostd。存储文件每秒被整体重写约两次。

## 修复方案
1. **transcript 移出存储域**（`packages/dsh-gateway/src/transcript-store.ts`，新增）：内存 Map + 每会话一个追加式 JSONL 文件（`<dirname(sshKnownHostsPath)>/transcripts/<sessionId>.jsonl`，可用 `transcriptDir` 配置覆盖）。一页只做一次 `appendFile`；超出每会话上限的行写 tombstone，tombstone 超过 256 条时按内存重写该会话文件；删除会话即删文件。存储域只剩 hosts/projects/sessions 三张小表和 seq 计数器。
2. **一次性迁移**：启动时若 `transcripts/legacy-domain-imported` 标记不存在，用 `remoteAgentLegacyDomainSpec`（含 transcript 表）打开旧单元，把行导入新 store 后关闭，再用新 spec 打开；下一次目录写入时后端自动丢掉旧表。本机实测导入 29,767 行耗时 553ms，`remote_agent.json` 从 138MB 收缩到 29KB，transcript 文件共 11MB。
3. **不再为 tool 行保存 nativeFrame**（`projection.ts` `retainsNativeFrame`）：前端只在 permission/elicitation 卡片和 plan 条目上读原始帧；tool-call/tool-result 从不使用。迁移时同样剥掉。
4. **顺带修掉一个重启即崩的既有 bug**（`hostd-connection-pool.ts` `subscribe`）：`void this.ensureConnection(host).then(…)` 没有 `.catch`，SSH 隧道起不来时 rejection 无人处理，DSH 的 fail-loud 钩子直接 `process.exit(1)`。旧进程之所以没崩，是因为它早先成功连过该主机、走的是"已有连接"分支；新进程连接池为空必踩。现在记日志并保留 pending 订阅，等 follow 循环的退避重试。

## 验证步骤
1. ✅ typecheck、全量 vitest（32 文件 / 390 用例）通过；新增 transcript-store.spec.ts 5 例、gateway.spec.ts 2 例（nativeFrame 保留规则、legacy 导入）、hostd-connection-pool.spec.ts 1 例（订阅失败不产生 unhandled rejection）。
2. ✅ build 后重启 3081 web：日志出现 `transcript rows imported … count=29767 elapsedMs=553`，catalog 三张表条数与迁移前备份一致，a04bb345 的 transcript 可读（latestSeq 1040）。
3. ✅ 复测延迟：用一次性 grok 会话跑一条含工具调用的短指令，同样的对齐方法 21 条样本 p50 0.00s / p90 0.04s / max 0.05s。web 进程 CPU 从 103% 降到 0.2%，RSS 从 1.6GB 降到 210MB。

## 相关测试
- transcript-store.spec.ts: appends rows as one file write per batch and reloads them on reopen / rotates … and compacts / honours tombstones … / deletes a session … / imports legacy rows once
- gateway.spec.ts: keeps the native frame only on choice and plan rows, never on tool rows / imports transcript rows left in the storage domain once and drops tool frames on the way
- hostd-connection-pool.spec.ts: does not leak an unhandled rejection when a subscription cannot open its tunnel

## 设计建议
- 迁移前的原文件备份在本次会话的 scratchpad（`backup/remote_agent.before-migration.json`），确认无误后可删。
- 网关 `session.delete` 不会通知 hostd 结束 hold worker（hostd 也没有 close 方法），被删会话的 worker 会一直挂着；建议补一个 hostd `session.close`。
- 网关日志没有时间戳，这次只能靠 journal 帧与 transcript `createdAt` 对齐来量化延迟；给 trace 行加时间戳会省很多事。
