# Bug Fix: 部署 DSH 在 Homebrew Python 上报 externally-managed-environment

## 问题描述
- 日期: 2026-09-03
- 严重程度: High
- 影响范围: 主机设置里对 DSH 点「部署」，目标主机使用 Homebrew / PEP 668 Python

报错：`DSH installer exited with status 1: externally-managed-environment`。这是部署失败，DSH runtime 没有装上。

## 根因分析
- 问题位置: `packages/hostd/src/agent-manager.ts` `installDshRuntime()` / `installPlan('dsh')`
- 原因 1: 安装命令是 `python3 -m pip install --user --upgrade deepseek-harness-runtime-bin==0.1.1rc1`。本机 PATH 上的 `/opt/homebrew/bin/python3` 是 3.14，带 `EXTERNALLY-MANAGED` 标记，Homebrew 连 `--user` 也会拒绝，除非加上 `--break-system-packages`。
- 原因 2: 加上旗标后 pip 会成功，但 `deepseek-harness-runtime-bin` 不会往 PATH 安装 `dsh-jsonrpc-agent`。官方入口是 Python API `bundled_runtime_path()`，二进制名为 `dsh-jsonrpc-agent-pkg-<platform>-<arch>`，位于 site-packages。hostd 旧逻辑只在 PATH / pip user scripts 里找 `dsh-jsonrpc-agent`，于是报 “installer finished but the command is not on PATH”。
- 代码流程: 浏览器确认计划 → hostd `agent.install` → pip 退出码 1（PEP 668）或 pip 成功但发现失败。

## 修复方案
- 计划与执行统一为：`python3 -m pip install --user --upgrade --break-system-packages <spec>`。
- 安装后用官方 `deepseek_harness_runtime.bundled_runtime_path()` / `bundled_default_config_path()` 定位 runtime；库存和 hold 启动使用该绝对路径，并在未设置时注入 `DSH_CORDIS_CONFIG`。
- 客户端把旧 hostd 仍可能返回的 PEP 668 错误翻译成「先升级并重启 hostd」。

## 验证步骤
1. ✅ `packages/hostd/tests/agent-manager.spec.ts`：PEP 668 旗标；wheel locator 无 PATH 命令也能发现
2. ✅ `packages/dsh-client/tests/store.client.spec.ts`：错误文案
3. ✅ 重启本机 hostd（`127.0.0.1:62846`）后 inventory 返回 DSH `installed: true`
4. ✅ 用本机已有 DeepSeek 凭据调用 `agent.credential.set` 后，hostd 与 3081 gateway 均返回 DSH `authenticated: true`
5. ✅ 3081 `session.start` backend=dsh 成功，会话 `channelState: open`

## 相关测试
- `packages/hostd/tests/agent-manager.spec.ts`
- `packages/dsh-client/tests/store.client.spec.ts`

## 设计建议
- 库存发现已经读取 pip user scripts，不必为 DSH 再做一个独立 venv 前缀。
- 若主机已安装 pipx/uv，也可以自行 `pipx install deepseek-harness-runtime-bin`；hostd 只要能在 PATH 或 user scripts 里发现命令即可。
