# ThreadHarbor 主机运维手册（人 + AI）

稳定路径：**`docs/ops.zh.md`**。界面「复制给 AI」失败时会引用本文；助手应**先通读本文**，再结合下文附带的失败上下文排查。

SSH 部署与 Tailscale Serve 的接口明细、状态词表见 [ssh-deploy.zh.md](./ssh-deploy.zh.md)；本文侧重**操作剧本**与**常见失败**。

## 1. 添加主机：连接方式怎么选

入口：**各主机 → 添加新主机**。

| 方式 | 适用 | 之后发生什么 |
| --- | --- | --- |
| **登记 URL** | 对方 DSH 已在浏览器或 tailnet 上可直接打开 | 填 `address` / `launchUrl`，不做 SSH |
| **SSH 自动部署** | 能 SSH 到对方，要在对方装/启 DSH 或走隧道访问 | 进入 SSH 表单（见 §2），可部署、只连接、或走逐项检测后保存 ts.net |
| **从 Tailscale 选** | tailnet 里已有节点，只想填 SSH 目标 | 只预填**名称与 SSH 目标**，**不写死 address**；仍走 SSH 表单完成部署或检测 |

原则：Tailscale「在线」只说明组网节点通，**不**代表对方 DSH 在跑；要以 peer 检测或 SSH 读 `peer.json` 为准。

## 2. SSH 表单：字段与本地辅助 API

### 2.1 操作者要填什么

- **SSH 目标**：主机名或 IP；可从 `~/.ssh/config` 的 **Host 下拉**选别名，选中后会带入 `HostName`、User、Port、IdentityFile（若有）。
- **用户名**：**必填**；不会用本机登录名默认值。漏填时「扫描主机密钥」等动作会拦下。
- **端口**：默认 22。
- **认证**：私钥文件 / 粘贴私钥 / 密码三选一。
  - **私钥文件**：从本机候选列表选，或 **浏览** 选路径；路径留在管理机，浏览器不传私钥内容。
  - 粘贴私钥与密码：**不会**写入登记簿；重连需重新输入（详情页「使用这台主机」会说明）。
- **扫描主机密钥**：得到对方公钥指纹，操作者**必须批准**一把后，才能读取对方状态、部署或连接。
- **访问方式**（添加/详情部署区）：按对方可达 IP 直连，或经典 SSH 隧道（对方只听 `127.0.0.1`）。

### 2.2 本机 OpenSSH 资源（DSH Web 主机端）

面板通过下列 API 读**运行 DSH Web 的那台机器**上的 `~/.ssh`（不是浏览器所在电脑，除非二者相同）：

| 路径 | 方法 | 作用 |
| --- | --- | --- |
| `/api/threadharbor.host-ssh.local.assets` | GET | `configHosts`（config 里 Host 别名与字段）、`identityFiles`（候选私钥路径） |
| `/api/threadharbor.host-ssh.local.pick-identity` | POST | 打开原生文件选择器；`{ cancelled: true }` 或 `{ path: "…" }` |

Linux 无 zenity 等选择器时，浏览私钥会失败——请手输绝对路径，或在本机装好文件选择器依赖。

### 2.3 远程 SSH 动作（摘要）

| 路径 | 方法 | 作用 |
| --- | --- | --- |
| `/api/threadharbor.host-ssh.inspect` | POST | 扫描主机密钥（body 里 `ssh.user` 必填） |
| `/api/threadharbor.host-ssh.peer` | POST | 读对方 `peer.json` |
| `/api/threadharbor.host-ssh.deploy` | POST | 异步部署；返回 `operationId` |
| `/api/threadharbor.host-ssh.operation` | GET | `?operationId=` 查进度与失败原因 |
| `/api/threadharbor.host-ssh.connect` | POST | 建隧道并返回本机 `launchUrl` |
| `/api/threadharbor.host-ssh.check` | POST | Tailscale Serve 逐项检测 |
| `/api/threadharbor.host-ssh.serve` | POST | 配置 serve 后重检 |
| `/api/threadharbor.host-ssh.service` | POST | systemctl 启停远端 DSH |

完整表与状态机见 [ssh-deploy.zh.md](./ssh-deploy.zh.md)。

## 3. 部署与检查：进度怎么读

### 3.1 SSH 部署（异步）

1. 点 **部署 DSH 并登记**（或添加主机流程里的 **开始部署**）→ `POST …/deploy`。
2. 面板轮询 `GET …/operation?operationId=`，**进度区逐行追加** `progress.phase` 对应的说明（同一阶段重复心跳不刷屏）。
3. 成功：`result.launchUrl`；失败：展示**原始 error 全文**，可 **重试** 或 **复制给 AI**。

当前阶段名（`phase`）常见如：`installing`、`starting` 等；以界面最后一行与 `progress.detail` 为准。

### 3.2 对方状态检测（check 清单）

用于 Tailscale Serve 接入：一次 SSH 跑完多项，**前序未过的项显示「待前序完成」**。每项有 **ok / fail / warn / skip**；失败行旁有 **部署、启动、配置 serve** 等动作。全部通过后 **用 ts.net 地址保存这台主机**。

### 3.3 连接并打开（已登记主机）

详情 **使用这台主机**：隧道状态 + **连接并打开**。失败时展示 SSH 客户端原始错误，可重试。

## 4. 常见失败与处理

| 现象 | 常见原因 | 建议 |
| --- | --- | --- |
| 要求先填用户名 | `ssh.user` 未填 | 填对方系统上的登录名，不要用本机默认 |
| 请先批准主机密钥 | 未点选扫描出的指纹 | 扫描 → 选一把公钥 → 再部署/连接 |
| `Permission denied (publickey)` | 用户错、密钥错、或未授权 | 核对 user、`identityFile` 路径、对方 `authorized_keys` |
| `Connection refused` / 超时 | 端口、防火墙、主机 down | `ssh -p … user@target` 在管理机命令行先试 |
| 部署 tar/安装中断 | 网络、磁盘、Node 版本 | 看 `operation` 的完整 error；对方需 Node 22+ |
| 私钥浏览不可用 | Linux 无 zenity | 手输路径或安装选择器；见 host 日志 |
| check 里 SSH 不过 | 同上认证/网络问题 | 先修 SSH，再重新检测 |
| serve 配置失败 | 无 tailscale 权限 | 按界面列出的 **手动命令** 在对方执行后重检 |
| 连接成功但页面打不开 | 隧道进程退出、token 过期 | **连接并打开** 重建隧道；必要时重新部署读 token |

**不要**把密码、粘贴私钥内容、`launchUrl` 里的 token 贴给 AI；**可以**贴 hostname、username、auth 模式、私钥**路径**、主机密钥指纹、失败阶段与原始错误。

## 5. AI 助手排查清单

读到用户从面板复制的上下文后，按顺序：

1. **对照场景**：部署失败 / 连接失败 / 逐项检测失败 / serve 手动步骤。
2. **核对面板字段**：`target`、`user`、`port`、`authMode`、`identityFile`（仅路径）、`hostKeyFingerprint` 是否已批准。
3. **对照 API**：本地 assets 是否 200；`inspect`/`peer`/`deploy`/`operation`/`connect`/`check` 哪一步失败（用户粘贴的 error 常含 `ssh:` 或 HTTP 正文）。
4. **读日志**（在 **运行 DSH Web 的机器**上）：`~/Library/Logs/dsh-web.log` 或文档中的 journal 路径；远端部署看对方 `threadharbor` 状态目录与 `peer.json`。
5. **代码位置**（需改产品时）：`packages/dsh-client`（面板）、`packages/dsh-host-federation`（SSH 路由与部署）、插件 `threadharbor-ssh-deploy`。
6. **回归**：`npm run typecheck`、`npm run test`；界面改动需 `npm run build` 后重启 DSH Web（本仓库测试实例见根目录 `AGENTS.md` 3080 铁律）。

## 6. 相关文档

- [ssh-deploy.zh.md](./ssh-deploy.zh.md) — API 全表、九态主机词、Tailscale Serve 流程
- [AGENTS.md](../AGENTS.md) — 仓库内 agent 守则（含 Web 测试实例启停）
