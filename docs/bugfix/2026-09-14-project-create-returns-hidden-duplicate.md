# Bug Fix: 新建项目命中已隐藏的同目录记录时提示成功但侧栏不显示

## 问题描述
- 日期: 2026-09-14
- 严重程度: Medium
- 影响范围: 所有主机上"添加项目"流程。用户在 Mac-good 上登记 `/Users/good/qg/nexa-service`，UI 提示"已登记项目 nexa-service"，侧栏却没有出现该项目。

## 根因分析
- 问题位置: `packages/dsh-gateway/src/index.ts` `createProject`
- 原因: 按"同主机 + 同目录"查重命中了 9 月 8 日被隐藏（`hiddenAt` 有值）的旧记录，网关直接原样返回该记录并回 `ok=true`。侧栏投影会过滤掉 `hiddenAt !== undefined` 的项目，因此浏览器收到成功响应却什么都看不到。
- 代码流程: 浏览器 `store.createProject` → 网关 `project.create` → `fs.list` 规范化目录 → 查重命中隐藏记录 → 返回 → 客户端 `setSuccess('已登记项目 …')`。网关日志三次 `dispatch method=project.create ok=true`，hostd 侧无任何报错。

## 修复方案
- 修改文件: `packages/dsh-gateway/src/index.ts`
- 修改内容: 查重命中隐藏记录时，视为"重新登记 = 恢复"：清除 `hiddenAt`，用本次请求的标题覆盖旧标题，刷新 `updatedAt` 后写回并返回。命中可见记录时行为不变（直接返回已有项目）。

## 验证步骤
1. ✅ 新增回归测试 `re-registering a hidden directory restores the project instead of returning it hidden`，在未修复代码上运行失败。
2. ✅ 应用修复后 `npm run typecheck` 通过，`npm test` 33 个文件 395 个用例全部通过。
3. ✅ 重新构建并重启 3081 测试 GUI，直接向 `/remote-agent/control` 发送 `project.create`（Mac-good，`/Users/good/qg/nexa-service`），`state` 返回该项目且 `hiddenAt` 为空，`hidden.list` 中不再包含它。

## 相关测试
- `packages/dsh-gateway/tests/gateway.spec.ts` › `re-registering a hidden directory restores the project instead of returning it hidden`

## 设计建议
- 隐藏项目时会把其会话一并归档（`deferSessionArchival`），恢复项目不会自动反归档会话，与 `project.unhide` 行为一致；需要旧会话时在设置面板的"已隐藏"列表中单独取消归档。
- 客户端提示文案统一为"已登记项目"，无法区分新建与恢复。若后续要区分，可让 `project.create` 在返回值里带 `restored: true`。
