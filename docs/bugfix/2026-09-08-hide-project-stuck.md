# Bug Fix: 隐藏主机/项目一直停在「隐藏中…」不收敛

## 问题描述
- 日期: 2026-09-08
- 严重程度: High
- 影响范围: 侧栏主机/项目行菜单 →「隐藏」→ 确认弹窗(RemoteSidebar.tsx `HideConfirmDialog`),确认按钮文案永远停在「隐藏中…」;pending 期间「取消」被禁用,只能刷新页面退出。设置面板树形列表里的隐藏入口(`RemoteConversation.tsx` 的 `act()`)同样受影响。

## 根因分析
- 问题位置:
  - `packages/dsh-client/src/client/store.ts` `hideHost`/`hideProject`(旧实现直接 `mutate('host.hide'|'project.hide')`)。
  - `store.ts` `mutate`:`await this.call(method)` 之后还要 `await this.reload()`——**用户可见的「隐藏成功」被绑在两次串行 RPC(隐藏 + 全量 `state`)上**。
  - `packages/dsh-client/src/client/RemoteSidebar.tsx` `HideConfirmDialog`:`confirm()` 裸 `await` store promise,没有任何兜底超时。
  - `packages/dsh-gateway/src/index.ts` `hideHost`/`hideProject`:**标记隐藏的同时在 hide RPC 内部串行 `archiveProjectSessions`**,把该项目全部会话逐条写归档,再返回响应。
- 原因:
  1. **UI 兜底缺失(与 09-04 归档按钮同款 bug 的漏网入口)**。09-04/09-07(`docs/bugfix/2026-09-04-archive-button-stuck.md`,commit `60b1061`)给归档菜单和设置面板 `act()` 加了 90s `Promise.race` watchdog,唯独侧栏这个隐藏确认弹窗没有;store promise 一旦长时间不 settle,按钮就永久停在「隐藏中…」,且 pending 时「取消」禁用,用户只能刷新。
  2. **网关 hide 是串行大事务**。hide 期间要把该项目所有会话归档完才返回;会话多时单次 hide RPC 就很慢,而且它是排在全局 `enqueue` 串行队列里的——队列里还混着 `session.prompt`/`events.read` 等要同步等 hostd 的调用,任何一次卡顿都会让 hide 排队,客户端要等 75s 传输超时(两段 RPC 最坏 ~150s)才报错,观感就是「一直没成功」。
  3. **store 把「可见成功」与第二次 `state` 刷新耦合**。`mutate` 必须在 reload 完成、行从目录消失后才 resolve;只要 reload 慢或断网重连,弹窗就一直挂着。
- 代码流程: 用户点「隐藏」→ store 发 `project.hide` RPC → 网关标记隐藏并串行归档全部会话 → 返回后 store 再等一次全量 `state` → 行消失、弹窗才关。任一环慢/卡,弹窗停在「隐藏中…」。

## 修复方案
- 修改文件:
  - `packages/dsh-client/src/client/store.ts`:
    - 把 `reload()` 的「投影合并」逻辑抽成 `commitProjection(projection, preferredSessionId, draft)`:in-flight 会话保留、current/draft/promptProgress 重新锚定——reload 与 hide 后的本地移除共用同一套规则,不再各写一遍。
    - `hideHost`/`hideProject` 改为:**只 await 一次 hide RPC**;RPC 确认后立刻 `dropHiddenRows` 把主机/项目行及其会话从本地投影移除(走 `commitProjection`,与被隐藏项目同属的 draft 一并丢弃),随后 `void this.reload()` fire-and-forget 收敛服务端时间戳等。目标行不在本地投影时回退旧 `mutate`(服务端仍需记录)。
  - `packages/dsh-client/src/client/RemoteSidebar.tsx`:
    - 常量 `ARCHIVE_TIMEOUT_MS` 更名 `ACTION_TIMEOUT_MS`(归档与隐藏共用)。
    - `HideConfirmDialog` 的 `confirm()` 用 `Promise.race` 包 90s 兜底,超时提示「隐藏请求超时,请检查网关连接后重试。」并恢复按钮;用 `settled` 标志避免超时后迟到的成功误关弹窗。
    - 顺手修掉项目隐藏文案里 `主机 ${host?.title ?? ''} 仍可见` 的空插值(项目行场景 host 未定义),改为「所属主机仍可见」。
  - `packages/dsh-gateway/src/index.ts`:
    - `hideHost`/`hideProject` **只标记 hiddenAt/updatedAt 并返回**,不再在 hide RPC 里等归档。
    - 新增 `deferSessionArchival(projectIds, archivedAt)`:**把归档扫尾作为独立步骤排进同一个 `enqueue` 串行队列**——hide 响应即刻返回,而后续任何操作(unhide/unarchive/delete…)仍在归档完成后执行,绝不会观察到「隐藏了一半」的树;归档失败仅记日志,不污染队列。
  - `packages/dsh-client/tests/store.client.spec.ts`、`packages/dsh-gateway/tests/gateway.spec.ts`:见「相关测试」。

- 设计取舍:
  - hide 的可见成功 = 「行离开界面」,由一次 hide RPC 确认 + 本地投影提交达成;第二次 `state` 只是让快照与服务端时间戳等收敛,不再绑架按钮。与 09-04 归档修复同一个原则:任何长链路 store 操作都要把「用户已经看到的成功」与后续收尾解耦,UI 层再有最长等待兜底。
  - 网关归档放后台但仍走 `enqueue` 串行队列,而不是裸 fire-and-forget:必须保证 hide 之后立刻 unhide 时,会话仍处于已归档状态(测试 `hides, restores, and deletes hosts, projects, and archived sessions` 钉死该语义);裸并行会引入竞态。
  - `commitProjection` 保留 reload 的 in-flight 规则:正在跑/被选中的会话在隐藏后仍作为孤儿行留在投影里(会话不中断、会话面板不闪断),等用户切换会话后由下次 reload 自然移除——与改动前行为完全一致,只是不再等第二次 RPC。

## 修改内容(关键片段)
```ts
// store.ts: hideProject —— RPC 确认即提交本地投影,reload 后台收敛
async hideProject(projectId: ReturnType<typeof RemoteProjectId>): Promise<void> {
  const target = this.snapshot.state.projects.find(candidate => candidate.projectId === projectId)
  if (target === undefined) {
    await this.mutate('project.hide', { projectId }) // 不在本地投影:回退 mutate
    return
  }
  await this.run(async () => {
    await this.call('project.hide', { projectId })
    this.dropHiddenRows(new Set(), new Set([projectId]))
  })
  void this.reload().catch(() => undefined)
}
```

```ts
// RemoteSidebar.tsx: HideConfirmDialog —— 90s watchdog,超时可恢复、可重试
let settled = false
task.then(() => { settled = true }, () => { settled = true })
void Promise.race([
  task,
  new Promise<never>((_, reject) => {
    window.setTimeout(() => { reject(new Error('隐藏请求超时，请检查网关连接后重试。')) }, ACTION_TIMEOUT_MS)
  }),
])
  .then(() => { if (settled) { setPending(false); onClose() } })
  .catch((reason: unknown) => { setError(String(reason)); setPending(false) })
```

```ts
// dsh-gateway/src/index.ts: hideProject —— 只标记,归档排队到 hide 之后
private async hideProject(params: Record<string, JsonValue>): Promise<RemoteProjectView> {
  const projectId = RemoteProjectId(stringField(params, 'projectId'))
  const current = this.requireProject(projectId)
  if (current.hiddenAt !== undefined) return current
  const now = new Date().toISOString()
  const hidden: RemoteProjectView = { ...current, hiddenAt: now, updatedAt: now }
  await this.requireTables().projects.put(projectId, hidden)
  this.deferSessionArchival([projectId], now)
  return hidden
}
```

## 验证步骤
1. ✅ `pnpm typecheck` 通过。
2. ✅ `pnpm test` 全量 308 测试通过(原 302 + 新增 6 条中的 2 条属本修复,另 4 条为并行进行中的会话延迟调优工作);关键覆盖:
   - `resolves project hide from the hide RPC alone, without waiting for the follow-up catalog reload`:mock 在 hide RPC 之后冻结所有 `state`,断言 `hideProject` 仅凭 hide 确认即 resolve、项目行已离开投影且当前会话按 in-flight 规则保留——旧 `mutate` 实现会永远挂起。
   - `keeps a hidden project's sessions archived even when the project is unhidden right away`:断言 hide 响应先返回、归档扫尾仍排在 unhide 之前,取消隐藏不会复活会话。
3. ✅ `pnpm build` 全包构建通过,`packages/dsh-client/lib/client.js` 产物含「隐藏请求超时」与「隐藏中…」。
4. 真实环境(可选):连接 hostd 后对项目行执行 隐藏 → 确认,项目应立即消失、弹窗立即关闭;断网/杀掉网关时再隐藏,按钮应在 90s 内恢复并提示超时,不再需要刷新页面。

## 相关测试
- `packages/dsh-client/tests/store.client.spec.ts`:
  - `resolves project hide from the hide RPC alone, without waiting for the follow-up catalog reload`
- `packages/dsh-gateway/tests/gateway.spec.ts`:
  - `keeps a hidden project's sessions archived even when the project is unhidden right away`
  - `hides, restores, and deletes hosts, projects, and archived sessions`(原测试,验证语义未回归)

## 设计建议
- 网关把所有写操作串行在一条全局队列上,任何「大而慢」的操作(如 hide 里归档整个项目)都应该拆成「快速返回 + 队列内收尾」两段;客户端绝不把用户可见的成功与第二次全量刷新绑定。
- UI 对任何长链路 store 操作保留最长等待上限;侧栏这类确认弹窗的「取消」在 pending 时也不该被禁用成无法逃生。
