# Bug Fix: hostd 代码更新后 Web 不显示升级按钮

## 问题描述
- 日期: 2026-09-04
- 严重程度: Medium
- 影响范围: 主机行「升级」徽章、主机设置「升级 hostd」

hostd 代码更新后，重启 gateway 不会重启 hostd。UI 比较的是版本字符串，但 hostd 把 `hostdVersion` 写死为 `0.1.0`，gateway 也读 `package.json` 的 `0.1.0`，所以永远显示已部署。

## 根因分析
- 问题位置:
  - `packages/hostd/src/server.ts` `inventory()`
  - `packages/dsh-gateway/src/index.ts` `hostdArtifactVersion()`
- 原因: 升级按钮依赖 `inventory.hostdVersion !== state.hostdArtifactVersion`。两边都是固定 semver，代码变化不会反映到字符串上。

## 修复方案
- hostd 启动时用 `package.json` 版本 + `bin.js`/`hold-worker.js` 摘要作为 `hostdVersion`，进程内不再重读。
- gateway 对当前制品目录用同一规则计算 `hostdArtifactVersion`，文件 mtime/size 变化后刷新缓存。
- 旧 hostd 仍报 `0.1.0` 时，新 gateway 会报 `0.1.0+…`，Web 立即显示「升级 hostd」。

## 验证步骤
1. ✅ 制品文件内容变化后版本摘要变化
2. ✅ inventory 报告 `0.1.0` 或 `0.1.0+<12 hex>`
3. ✅ 客户端把不同摘要判为 outdated / 「已连接，待升级」
4. ⚠️ 重启 3081 后，未升级的本机/远端 hostd 应出现「升级」按钮

## 相关测试
- `packages/hostd/tests/version.spec.ts`
- `packages/hostd/tests/hostd.spec.ts`
- `packages/dsh-client/tests/store.client.spec.ts`
