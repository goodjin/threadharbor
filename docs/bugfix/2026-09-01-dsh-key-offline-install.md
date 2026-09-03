# Bug Fix: DSH Key 保存后仍显示输入框；Grok/Codex/Claude 安装失败

> 历史记录：本文中的 Agent 安装失败来自已废弃的离线安装实现。当前架构不再安装或升级 Grok/Codex/Claude/DSH；ThreadHarbor 只部署 hostd/hold-worker，并从远端通用 `PATH` 发现管理员已安装的 Agent。

## 问题描述
- 日期: 2026-09-01
- 严重程度: High
- 影响范围: 主机设置里的 Agent 安装和 DSH API Key

DSH 保存 API Key 后输入框还在。另外三个 Agent（Grok、Codex、Claude）安装失败。

## 根因分析
- DSH：保存成功只在输入框下面加一行绿字，输入框没有收起，也没有「修改」入口。
- 安装：Mac mini 上的 hostd 由 SSH `nohup` 拉起，进程 PATH 是 `/Users/jin/.cargo/bin:/usr/bin:/bin:/usr/sbin:/sbin`，没有 Homebrew。离线安装命令是 `npm install --offline ...`，hostd 找不到 `npm`，实际错误是 `spawn npm ENOENT`。DSH 走 bundle 文件拷贝，所以只有它能装上。
- 网关把这条错误收成「Agent 安装失败，请检查离线安装包和远端 hostd 日志。」，界面上看不出 ENOENT。
- 工作区 `packages/hostd/lib/bin.js` 仍是旧的 `@latest` 公网安装器，若此时点「升级 hostd」会把能工作的离线安装器覆盖掉。

## 修复方案
- DSH Key 已配置时显示成功卡片，只有点「修改」才出现输入框。
- hostd 用当前 Node 执行同目录的 `npm`，spawn 时把 `dirname(process.execPath)` 放到 PATH 前面。
- SSH 部署的 systemd / nohup 启动命令同样带上 Node 所在目录的 PATH。
- Agent 安装失败把 hostd 原始错误展示出来。
- 重新构建 `hostd/lib/bin.js`，去掉 `@latest`。

## 验证步骤
1. ✅ 本机 `curl` Mac mini hostd：`agent.install grok` 返回 `spawn npm ENOENT`
2. ✅ `npx tsc -b tsconfig.json`
3. ✅ 重建 hostd / gateway 制品；`bin.js` 不再包含 `@latest`
4. ✅ hostd / gateway / dsh-client 定向测试 20/20
5. ✅ 上传新 `bin.js` 并带 PATH 重启 Mac mini test hostd 后，Grok/Codex/Claude 均安装成功
6. ✅ 3081 下发的 `dsh-client` 含「DSH API Key 已配置」和「修改」

## 相关测试
- `packages/hostd/tests/agent-manager.spec.ts`
- `packages/dsh-gateway/tests/ssh-manager.spec.ts`
- `packages/dsh-client/tests/client-artifact.spec.ts`
