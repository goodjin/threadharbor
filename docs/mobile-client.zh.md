# 手机端访问方案（Android）

本文讨论如何让手机访问 ThreadHarbor 已有的远程会话能力。结论先行：**ThreadHarbor 已经能在远程主机上持续执行 Codex、Grok 与 DSH 会话，缺的只是"手机怎么接进来"和"手机上的界面"**；但接入之前有一个必须先补的鉴权缺口。

参考项目 `ds-harness-remote` 的源码放在 `reference/ds-harness-remote/`（Git 忽略，仅供开发时核对；用 `npm run reference:checkout-mobile` 更新）。本文不引入它作为运行时依赖。

## 现状

已有能力（详见 [architecture.zh.md](architecture.zh.md)）：

- hostd 在远程主机上持有 Agent 原生连接，浏览器断线不终止会话；重连按 journal cursor 补齐。
- 会话统一走 Agent Client Protocol，Codex / Grok / DSH 三种后端已能建会话；Claude Code 的登录与配置已支持，但还没有会话 adapter，不会出现在"新建会话"里。
- Gateway 持有 SSH tunnel，hostd 只监听远程 loopback。

手机端目前**不存在**：`packages/dsh-client` 只向 DSH Web 的 `sidebar` 与 `conversation` 两个 slot 注册 occupant，界面形态由 DSH Web 的 layout 决定，没有独立入口，没有窄屏适配，也没有移动端可达的任何网络路径。

## 三条硬约束

### 1. DSH 不允许把服务开到网卡上

`dsh --profile web` 的启动参数解析会直接拒绝 `--host 0.0.0.0`，报错原文说明理由是这会把远程代码执行暴露到网络上。底层 HTTP 服务本身接受 `0.0.0.0`，但 Web 组合层在入口处挡住。

ThreadHarbor 运行在 DSH Web 内，因此**不能靠改绑定地址让手机连进来**。任何方案都必须让手机主动去找 Mac，而不是让 Mac 开放端口。

### 2. 控制面目前没有鉴权——这是接入前必须先补的

Gateway 的两条对外路径挂在 DSH 的 HTTP 服务上：

| 路径 | 类型 | 位置 |
| --- | --- | --- |
| `/remote-agent/control` | 精确路由，仅 POST | `packages/dsh-gateway/src/index.ts` |
| `/remote-agent/ws` | upgrade 路由 | `packages/dsh-gateway/src/index.ts` |

这两条路由**都没有调用 DSH 的准入检查**。DSH 的栅栏是 `connection.admit(request)`：先校验 Host 是否为本机或可信地址、浏览器来源标记是否同源，再校验进程 token 换取的签名 cookie；两条都过才"代表操作者说话"。Gateway 的 HTTP handler 直接读 body 就进入 dispatch，WS upgrade 直接交给 broadcaster，代码里没有这一步。

DSH 的 HTTP 服务本身是一个不带任何 harness 语义的路由注册表，栅栏**不是全局中间件，而是每条路由自己选择加入**。ThreadHarbor 这两条路径没有加入，因此在 DSH Web 的浏览器通道里不受保护。

**这在今天是安全的**，因为 DSH Web 默认只绑 `127.0.0.1`，能连到那个端口的只有本机进程。但一旦手机能连进来，`/remote-agent/control` 就是一条无凭据的完整控制通道——建会话、发 prompt、批权限、终止会话都在它的 dispatch 里。

所以鉴权不是手机端的配套工作，而是**接入的前置条件**。至少要做到：手机凭据通过独立校验才放行，且 WS upgrade 走同一套校验。

### 3. 网页在后台会被冻结

页面前台时 WebSocket 很稳；一切后台或锁屏，安卓 Chrome 会在秒级到分钟级冻结页面，定时器停摆、长连接被挂起，系统省电模式还会直接限制后台网络访问。原生 App 有网页拿不到的前台服务豁免，网页没有。

这决定了**通知只能走 App**，任何纯网页方案都给不了"人不在电脑前被叫醒"。

## 参考项目 ds-harness-remote 现状

已核实的部分（基于 `reference/ds-harness-remote`，commit 5865d70，Plugin/Android 0.5.1）：

| 维度 | 现状 |
| --- | --- |
| 定位 | DSH bundle 插件 + 浏览器客户端 + 安卓 App + 中转 Server + VS Code 扩展的 monorepo |
| 网络模型 | Host 与 Client **都主动外连** Remote Server；数据面按 LAN → P2P → TURN → Relay 降级；Host 不监听公网端口，不需要路由器转发 |
| 加密 | 业务消息始终在 Client 加密、Host 解密，走 Noise 端到端通道；中转与 TURN 只搬运密文 |
| 安卓技术栈 | Expo / React Native（TypeScript），**不是 Flutter** |
| 通知 | **没有实现**。全仓搜索 `expo-notifications`、`POST_NOTIFICATIONS`、Firebase、messaging 均无命中；`apps/android/app.json` 的权限清单里只有安装包一条 |
| 后端接入 | Codex 走自带 `app-server` 协议；Cursor 与 Antigravity 走 ACP；Kimi / 自定义命令行可配 |
| 许可证 | `package.json` 声明 MIT，**仓库根目录没有 LICENSE 文件**——比有完整许可证文本的授权要弱，借鉴代码时需注意 |

其中"把不同后端包装成同一种会话形状"的做法值得看：`packages/plugin/src/acp/virtual-harness.ts` 里的 `AcpVirtualHarness` 把外部 ACP 后端投影成与本地一致的会话视图，新增后端时客户端无需改动；Codex 侧另有一份同名的 `packages/plugin/src/codex/virtual-harness.ts`，说明这个投影层是按后端分别实现的。

### 可借鉴

1. **主动外连而非开放端口**。与约束 1 完全同向，思路可以直接采纳。
2. **端到端加密**，让中转只搬运密文。若引入中继，这条是必需的。
3. **后端归一化**：`virtual-harness` 的思路。ThreadHarbor 已经统一走 ACP，比它更干净，但"新增后端时客户端零改动"这个目标是一致的。

### 不该混淆

- 它的 Gateway / hostd 与本项目是**两套并行实现**，功能高度重叠（都能远程控制 Codex）。引入它等于同时维护两套远程执行栈。
- 它的状态在 Host 插件与中转 Server 上；ThreadHarbor 的状态所有权在 gateway，每个 Web 部署独立 catalog、互不接管。这条不能替换。
- 它的安卓 App 源码在 `apps/android`，是 Expo 工程。真要做一个 App，更现实的是新建 ThreadHarbor 自己的客户端，而不是 fork 别人的。

## 方案

### 接入点：手机连 gateway，不连 hostd

hostd 在远程主机上、只听 loopback、且会话与 journal 都归它持有。手机若直连 hostd，会同时破坏两条现有不变量：**状态所有权分散**，以及**gateway 的 SSH tunnel 与 catalog 成为旁路**。

因此手机一律连 gateway。这也让第一阶段可以完全复用现有协议：`packages/protocol` 的控制协议与 WS 实时流都已经存在，手机端只是它们的新消费者。

### 网络通道

手机到 Mac 的这段是新增的，三种选择：

| 方案 | 说明 | 代价 |
| --- | --- | --- |
| **私网 overlay** | 复用 Tailscale 等，手机拿到私网地址后访问 Mac 的 loopback 端口 | 要求两台设备都装客户端并常在线；不解决 Mac 关机 |
| **自建中继** | 参考项目的模型，手机与 Mac 都外连中继，业务消息端到端加密 | 新增一个需要长期运维的服务 |
| **页面内渠道** | 借用已有浏览器的 WebRTC/ICE 打洞能力建立旁路 | 需要服务端协助信令，仍绕不开可达性 |

第一阶段建议先跑通：**私网 overlay 验证功能，中转作为第二阶段**。这样第一阶段不引入新的运维负担，代价是只能在私网下用。

### 鉴权（前置）

- 为 `/remote-agent/control` 与 `/remote-agent/ws` 增加独立准入：请求凭据通过校验才放行，upgrade 走同一套校验。
- 凭据形态待定。可参考的是 ds-harness-remote 的**账号 + 设备名册**模型：中转侧维护账号授权、设备在线状态与凭据吊销。但它依赖一个自建或官方的中转 Server 才成立；ThreadHarbor 若走私网通道，只需要等价的"设备 + 可吊销令牌"这层，不该把中转 Server 一起搬进来。
- 手机端凭据存储用系统安全存储，不进 gateway catalog 的明文字段。

### 手机端形态

第一阶段做**独立 Web 入口**，而不是塞进 DSH Web 的 sidebar：窄屏下 DSH Web 的 layout 不是为手机设计的，复用它会继承整套桌面交互。

- 复用 `packages/protocol`，新增一个不依赖 DSH slot 的挂载点。
- 独立鉴权与独立入口，与桌面浏览器共用后端、不共用会话。

第二阶段再评估要不要原生 App。判据是"网页端在真机上到底差在哪"，而不是预先假定需要。

### 通知

只有原生 App 能做到，分两档：

- **App 常驻连接**：App 在前台服务里保持到 gateway 的连接，收到待批准状态就弹本地通知。优点是内容不出私网；缺点是耗电，且 **Mac 关机或 gateway 退出后就没有通知了**。
- **系统推送**：覆盖 Mac 关机场景，但通知内容至少经过推送厂商。

这一档的能力需要单独排期，且要验证目标 App 的后台连接在实际 ROM 上是否稳定——不同厂商的省电策略差别很大，不能假设。

## 分阶段计划

| 阶段 | 内容 | 完成标志 |
| --- | --- | --- |
| 0 | 为两条控制面路由补鉴权 | 未持凭据的请求被拒；这条独立于手机端，值得先做 |
| 1 | 独立手机 Web 入口 + 私网通道 | 手机上能看到会话列表、发 prompt、批权限、终止 |
| 2 | 评估原生 App | 用阶段 1 的真机体验决定要不要做，而不是先做 |
| 3 | 通知（仅在阶段 2 结论为需要时） | 后台收到待批准能弹本地通知 |

阶段 0 无论后续走哪条路都要做，且当前控制面无凭据可用的状态不应长期存在。

## 未决问题

- 手机端是否需要管理"主机与部署"这类运维操作，还是只管会话？这决定第一阶段的接口范围。
- 是否需要多手机同时在线，以及配对凭据的粒度。
- 阶段 1 的入口是否复用 DSH Web 的进程与端口，还是 gateway 单独监听一个端口。前者省事但与桌面浏览器共享入口，后者隔离更干净。
- 阶段 2 的原生 App 是否需要复用参考项目的 Expo 技术栈，取决于是否愿意承担一个新的客户端代码库。

## 参考

- `reference/ds-harness-remote/`：`docs/network.md`、`docs/end-to-end-encryption.md`、`docs/acp-remote.md`、`apps/android/`
- [architecture.zh.md](architecture.zh.md)：现有状态所有权、断线恢复与 Agent adapter
- [landscape.zh.md](landscape.zh.md)：相近项目的对比写法
