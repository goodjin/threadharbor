# Bug Fix: hostd hold worker socket path too long on macOS

## 问题描述

- 日期: 2026-09-03
- 严重程度: High
- 影响范围: `RemoteAgentHostd` detached hold worker 启动、`hostd-integration` 测试、stable 发布前 `npm run check`

`packages/hostd/tests/hostd-integration.spec.ts` 在 macOS 上稳定失败：

```text
hold <uuid> did not start: Error: connect EINVAL .../holds/<uuid>/control.sock
```

## 根因分析

- 问题位置: `packages/hostd/src/server.ts`
- 原因: hold worker control socket 放在 `dataDir/holds/<holdId>/control.sock`。macOS 下 `tmpdir()` 路径本身较长，再叠加测试前缀、UUID 和 `control.sock` 后超过 Unix domain socket path 限制，Node 在 `listen/connect` 层返回 `EINVAL`。
- 复现实证: 短路径 Unix socket 可正常 listen/connect；长路径 Unix socket 直接 `EINVAL`。

## 修复方案

- 新 hold worker 的 control socket 改到短路径：
  - `/tmp/threadharbor-hostd-<uid>/h-<holdId>.sock`
- 该 runtime 目录创建后校验 owner，并强制 owner-only 权限。
- `journal.jsonl`、`state.json`、`config.json` 仍保留在原 `dataDir/holds/<holdId>/` 下，不改变持久数据布局。
- `holdSocket()` 保留旧路径 fallback，兼容修复前已经运行的 hold worker。
- 测试清理逻辑从 `config.json` 读取真实 `socketPath`，避免 shutdown 时继续使用旧长路径。
- release 测试的正向 promote fixture 显式标记为 clean，避免测试结果依赖真实仓库 dirty 状态；真实发布的 dirty 保护不变。

## 验证步骤

1. ✅ 单独运行 `packages/hostd/tests/hostd-integration.spec.ts`
2. ✅ 运行 hostd 相关测试
3. ✅ 运行 `tests/release-scripts.spec.ts`
4. ✅ 运行完整 `npm run check`

## 相关测试

- `packages/hostd/tests/hostd-integration.spec.ts`
- `packages/hostd/tests/hold-worker.spec.ts`
- `packages/hostd/tests/hostd.spec.ts`
- `tests/release-scripts.spec.ts`
