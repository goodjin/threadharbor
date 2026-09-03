# Bug Fix: Grok 点登录不出现授权链接

## 问题描述
- 日期: 2026-09-01
- 严重程度: High
- 影响范围: 主机设置里 Grok / Codex 的交互登录

在 Mac mini 上点 Grok「登录」后，界面一直停在「Waiting for the agent to provide an authorization link」，没有链接和一次性代码。

## 根因分析
- 问题位置: SSH 拉起的 hostd 进程环境；`packages/hostd/src/bin.ts`
- Mac mini 访问 `auth.x.ai` 必须走 Clash 代理 `http://127.0.0.1:7877`。该代理写在用户 `~/.zshrc` 里，交互 shell 有 `https_proxy`。
- hostd 由 SSH `nohup` 启动，没有继承这些变量。`grok login --device-auth` 卡在请求 `auth.x.ai`，stdout/stderr 都不输出，hostd 就解析不到 URL。
- 带上代理后，Grok 把链接打到 stderr：`https://accounts.x.ai/oauth2/device?user_code=...`。hostd 本来就会读 stderr，缺的是代理。

## 修复方案
- hostd 启动时若自身没有 proxy，从用户 login shell 的 `export -p` 拷贝 `http_proxy` / `https_proxy` 等变量。
- SSH 部署把同一组变量写入 `hostd.env`，systemd 用 `EnvironmentFile`，nohup 启动前 `source`。
- 若 8 秒仍停在 starting，更新提示，说明需要访问 `auth.x.ai` 或继承代理。

## 验证步骤
1. ✅ 无代理时 `auth.start` 一直是 starting，无 verificationUri
2. ✅ 带 `https_proxy=http://127.0.0.1:7877` 重启 hostd 后，4 秒内返回 `waiting-user` 和 `https://accounts.x.ai/oauth2/device?user_code=...`
3. ✅ `parseProxyExport` 与 SSH 部署脚本测试

## 相关测试
- `packages/hostd/tests/login-proxy.spec.ts`
- `packages/dsh-gateway/tests/ssh-manager.spec.ts`
- `packages/hostd/tests/agent-manager.spec.ts`
