# Bug Fix: SSH 上传 EPIPE 导致测试通道退出

## 问题描述

- 日期：2026-08-31
- 严重程度：High
- 影响范围：DSH Web 网关执行 SSH 部署或文件上传时，远端命令若提前退出，测试通道可能整体退出。
- 表现：`3081` 不再监听，运行日志包含未处理的 `Error: write EPIPE`，错误对象为 Node.js `Socket`。

## 根因分析

- 问题位置：`packages/dsh-gateway/src/ssh-manager.ts` 的 SSH 子进程执行函数。
- 原因：上传内容通过 `child.stdin.end(...)` 写入 SSH 子进程，但代码只监听了 `ChildProcess` 的 `error`，没有监听 `child.stdin` 这个可写 Socket 的 `error`。
- 当远端命令在内容写完前退出时，Node.js 会在 `child.stdin` 上发出 `EPIPE`。该事件没有监听器，因此成为未捕获异常并终止承载网关的 DSH Web 进程。

## 修复方案

- 为 SSH 子进程 stdin 增加错误监听，阻止流错误升级为进程级未捕获异常。
- 保留子进程退出码作为远端命令失败的主要结果；如果子进程以成功状态退出但 stdin 写入失败，则将写入错误返回给调用方。
- 所有失败路径统一清理超时计时器，并捕获同步写入异常。
- 增加大文件上传期间远端提前退出的回归用例。

## 验证步骤

1. ✅ EPIPE 回归用例模拟 SSH 在消费完 8 MiB 上传内容前退出。
2. ✅ `packages/dsh-gateway/tests/ssh-manager.spec.ts` 5/5 通过。
3. ✅ TypeScript 项目类型检查通过。
4. ✅ 全项目构建通过。
5. ✅ 测试通道以修复后的构建重新启动，PID `75718` 监听 `127.0.0.1:3081`。
6. ✅ 启动后立即和 5 秒后真实请求均返回 HTTP 200，通道报告 `healthy: true`。

## 设计建议

- 所有使用 `stdio: 'pipe'` 的子进程都应分别处理 `ChildProcess`、stdin、stdout 和 stderr 的错误边界。
- 长任务应把子进程失败转换为操作级失败状态，不能让流错误逃逸并终止宿主 Web 进程。
