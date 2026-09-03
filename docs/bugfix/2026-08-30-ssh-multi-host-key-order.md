# Bug Fix: 多算法 SSH 主机密钥被误判为变更

## 问题描述

- 日期: 2026-08-30
- 严重程度: High
- 影响范围: Web 通过 SSH 自动部署远端 `threadharbor-hostd`

用户检查远端主机后批准了页面展示的 ECDSA SHA256 指纹，但确认部署立即返回 `SSH host key changed or does not match the approved fingerprint`。普通 SSH 可以到达目标主机。

## 根因分析

- 问题位置: `packages/dsh-gateway/src/ssh-manager.ts`
- 原因: OpenSSH 服务端通常同时提供 ECDSA、ED25519、RSA 等多把主机钥匙，`ssh-keyscan` 的输出顺序不稳定；旧实现每次只取第一行。
- 代码流程: 检查和部署会分别扫描一次。第一次第一行是用户批准的 ECDSA，第二次第一行可能变成 RSA 或 ED25519，即使已批准钥匙仍存在，也会被错误判定为主机密钥变更。

目标 `100.96.156.60` 的真实扫描同时返回三种算法；用户批准的 ECDSA 公钥指纹核对为 `SHA256:9P3JIKCAIlpe9Z4EYnT4FRRIUEn86+Sapf+2PRoVyJg`。

## 修复方案

- 扫描阶段收集并计算全部有效主机钥匙的 SHA256 指纹。
- 检查阶段继续展示本次扫描的一把明确钥匙供用户确认。
- 部署阶段在本次扫描的全部钥匙中精确寻找用户批准的指纹，找到后只持久化对应钥匙；全部不匹配时仍严格拒绝。
- SSH 进程返回 255 时展示真实连接/认证错误，不再误报成 Node.js 版本不满足。
- 探测并校验远端 Node.js 的绝对路径，兼容非交互 PATH 中缺少 `node` 的 macOS/Homebrew 环境；后续 hostd 启动复用该路径。

## 验证步骤

1. 回归测试模拟两次 `ssh-keyscan` 返回相同钥匙但顺序相反：通过。
2. 首轮完整门禁通过：13 个测试文件、42 个测试、类型检查与构建全部通过；最终 SSH 针对测试为 3/3，通过多钥匙顺序、认证诊断和 Homebrew Node 启动路径覆盖。
3. 重启固定端口 `3081`，真实检查目标主机时首行由上次 ECDSA 变化为 RSA，证明顺序确实不稳定。
4. 使用已批准 ECDSA 指纹执行真实部署请求：不再返回 host-key mismatch，并继续进入 SSH 认证阶段。
5. 从 Tailscale 状态识别目标为在线的 `jin 的 Mac mini`；`jin` 与 `/Users/good/.ssh/id_ed25519` 非交互登录成功。
6. 远端非交互 PATH 中没有 `node`，但 `/opt/homebrew/bin/node` 为 25.9.0；修复后完成真实上传和启动。
7. Gateway 创建主机 `9fb57052-645a-431e-8b69-46102e75984b`，本机 tunnel 为 `127.0.0.1:64095`；直接 inventory 返回 `healthy: true`。
8. 远端进程确认为 `/opt/homebrew/bin/node /Users/jin/.local/share/threadharbor/current/bin.js --port 3091`，3081 页面已显示 `jin 的 Mac mini`。
9. 最终 `npm run check` 通过：13 个测试文件、47 个测试、类型检查和完整构建全部通过。

## 相关测试

- `packages/dsh-gateway/tests/ssh-manager.spec.ts`

## 设计建议

主机信任应以用户批准的具体公钥指纹为准，不能依赖多值探测结果的输出顺序。连接探测也应区分 SSH 传输失败与远端命令返回失败。
