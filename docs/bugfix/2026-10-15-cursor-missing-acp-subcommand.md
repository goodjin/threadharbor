# 2026-10-15 · Cursor 一直握手超时：stdio 传输只传了命令，漏了 `acp` 子命令

## 问题描述

会话里选 Cursor 发消息，每轮都在 60 秒后失败：

> 本轮运行失败 外部 agent 连接已断开：acp agent did not answer within 60000ms

## 现场证据

- 会话事件日志（`~/.dsh-threadharbor-test`，workspace `nexa-service/apps/desktop`）三轮
  形状一致，都是等满 60 秒才报错，不是抖动。
- 直接实测拉起二进制：
  - `cursor-agent`（无参数）：进程活着，**一个字节都不回**，stdin 写进去的
    initialize 石沉大海；
  - `cursor-agent acp --trust`：initialize 287ms、authenticate 3s、session/new
    7.2s 拿到 sessionId。
- 代码侧：stdio 传输构造时只给了 `command`，没给 `args`。

## 根因分析

Cursor 的 `agent` 二进制是通用 CLI，`agent acp` 才是 stdio 上的 ACP 服务。裸跑
起来的是交互式界面，它占着 stdin 等终端输入，因此永远不会应答 JSON-RPC——而
进程还活着，于是失败表现成「握手超时」，读起来像 agent 慢，而不是少了个子命令。

官方文档（<https://cursor.com/docs/cli/acp.md>）写明 `agent acp`；avante.nvim、
Zed 等现成集成也都是 spawn + `acp` 子命令，没有别的路子。我们的握手顺序
（initialize → initialized → authenticate(`cursor_login`) → session/new）与官方
一致，问题只出在拉起进程这一层。

这个坑 10-13 已经踩过一次（提交 f7a0283「spawn cursor-agent acp --trust」），
但那次**只改了 live 测试文件的一行**，生产代码的 factory 没动。所以真机测试是
通的，线上一跑就超时——两份「都需要这个参数」的知识，一份在测试里、一份根本没
写。

## 修复方案

- 参数表移到 dialect 所在的包（`dsh-acp-agent/spawn-args`），factory 与 live 探针
  共用同一份。知识放在「认识各个 agent 的地方」，两份拷贝才是分叉的源头。
- preset 配置新增 `args` 字段，可整体覆盖默认命令行（换端点、换认证方式时运维
  要能完全接管）；不写就用按 agent 的默认值。
- live 探针里硬编码的那行删掉，改走同一张表。

## 验证步骤

- 全仓 `npm run check` 通过（typecheck + 945 个测试 + 构建）。
- 新增三条回归：cursor 带上 `acp --trust`；claude/codex 不加参数（它们的二进制
  本身就是 ACP 服务）；配置写了 `args` 时以配置为准。测试用真实子进程记录自己
  被拉起时的 argv——传输没有注入口，只有真拉一次才能看见命令行长什么样。
- **真机活测 4 条 Cursor 全过**（98 秒，含真实模型回答）：取消、图片、工具卡片、
  会话重放。

## 相关测试

- factory.spec：三个 spawn argv 用例（真实子进程）。