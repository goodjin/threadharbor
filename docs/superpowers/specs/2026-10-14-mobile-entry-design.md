# 手机端独立入口：Tailscale 通道 + 插件自带手机页

> 状态：已与用户对齐方向（方案 A），待审阅
> 日期：2026-10-14
> 范围：安卓手机经 Tailscale 访问各主机 DSH 的独立网页入口；第一版功能为
> 主机清单、看会话、发消息、批权限、停止回合。桌面端行为不变。
> 前置讨论：本文取代 [docs/mobile-client.zh.md](../../mobile-client.zh.md) 中
> 已过时的 gateway/hostd 架构设想（该文档将在阶段 1 重写）。

## 1. 背景与目标

多主机迁移完成后，每台机器各跑一个 DSH，agent 由插件在**提供页面的那台机器的进程内**
驱动。手机端始终不存在：浏览器插件只向 DSH Web 的 `sidebar` / `conversation` 两个
slot 注册 occupant，没有独立入口、窄屏适配与网络路径。

本设计补上「手机怎么接进来」。目标：

1. 安卓手机（装 Tailscale）打开网页，即可查看任一主机的会话、发消息、批准权限
   请求、停止回合；
2. **零新增常驻服务、零新增鉴权体系**——完全复用 DSH 官方支持的远程部署形态；
3. 桌面端日常使用完全不受影响（DSH 仍只听回环）。

明确排除（第一版不做）：

- 原生 App 与后台通知——网页在安卓后台被冻结，通知只有原生 App 能做，维持
  旧文档结论，留待真机体验后再评估；
- 新建会话、切换 agent 等桌面级操作；
- 自建中继/公网可达（见 §3 方案对比）。

## 2. 已核对的关键事实（2026-10-14，基准 deepseek-harness master `5badb15009`）

每条都来自官方源码，新会话执行时勿凭印象推翻。

| # | 事实 | 出处 |
|---|---|---|
| 1 | CLI 拒绝 `--host 0.0.0.0`，理由是会把远程代码执行暴露到网络 | `packages/bundle/web-app/src/startup.ts:85-87` |
| 2 | `--trusted-host` 可重复传入，进入 `/api` 准入围栏的信任名单；无端口条目匹配任意端口（官方文档点名适配「隧道每次绑不同端口」的场景） | 同上 `:63`；`docs/user/guide/public-deployments.md`「Trust the authority」节 |
| 3 | 官方支持「前缀剥离反向代理」部署：代理须保留浏览器侧 `Host`、转发 WebSocket 升级、改写 cookie 作用域 | `docs/user/guide/public-deployments.md`「What the proxy must do」节 |
| 4 | `/api` 前缀路由的处理器先 `connection.admit(req)`，拒绝时 401/403——准入是每条路由自选加入，不是全局中间件 | `packages/client/connection/src/index.ts:144-158` |
| 5 | WebSocket 多路复用路由（实时事件流）同样先 admit 再升级 | `packages/api/gateway/src/index.ts:240-263` |
| 6 | 准入通过后，请求以「操作者 Peer」身份进入 RPC 派发——手机与桌面同一凭据、同一权限 | `packages/api/gateway/src/index.ts:254-259`；cordis-client-runner API 目录对 `admit` 的描述 |
| 7 | 浏览器凭据：启动 URL 携带一次性进程令牌，打开后换签名 cookie；**签名密钥持久化存储**，cookie 默认 30 天 | `packages/client/connection/src/browser-auth.ts`（`StoredSecretPayload` / `PROCESS_LAUNCH_TOKENS`）；`src/index.ts:104-113`（`cookieMaxAgeDays` 默认 30） |
| 8 | cookie 名按授权方（authority）哈希区分——同一浏览器多台主机多个 cookie，互不冲突 | `browser-auth.ts:107` |
| 9 | WebServer 提供插件可用的路由注册：`exact` / `prefix` / 升级路由各一个表，命名路由优先于唯一的 fallback 席位（官方 SPA 占 fallback） | `packages/host/webserver/src/index.ts:38-56,160-203` |
| 10 | 迁移后本仓库无任何包触碰 WebServer 路由——手机页是全新挂载点，无旧包袱 | 2026-10-14 全仓 grep `webServer|registerUpgrade|registerFallback` 零命中 |
| 11 | 官方 SPA 的首页文档经 `authorizeIndex` 授权：带有效根令牌 → 铸 cookie 并 303 到 `./`；带有效 cookie → 放行；其余 401。**令牌交换只在 `pathname === '/'` 触发**；静态资源（JS/CSS）不经授权 | `packages/host/frontend-static/src/index.ts:121-139`（fallback 只对 index 文档调 authorizeIndex）；`packages/client/connection/src/browser-auth.ts:238-279`（根路径条件） |
| 12 | connection 服务面公开 `admit` / `requestRejection` / `authorizeIndex` / `authenticatedUrl`；`authenticatedUrl` 给任意干净网址加进程令牌，**保留 authority 与挂载路径**（文档原话 "a mount proxy strips its prefix before authorizeIndex"） | `packages/client/connection/src/rpc.ts:193-238` |

Tailscale 侧的前提（`tailscale serve` 的行为）**尚未真机核对**，列为 §8 阶段 0
验证项，不作为既成事实引用。

## 3. 方案选择

| 方案 | 结论 | 理由 |
|---|---|---|
| **A. 官方通道 + 插件自带手机页** | **采用** | 零新增常驻服务与鉴权体系；顺着事实 2/3/9 的官方形态走；Tailscale 掉线不影响桌面端 |
| B. 自建中继服务器（参考项目模式） | 否决 | 新增长期运维服务、自建账号/设备鉴权、需端到端加密——正是多主机迁移刚删掉的东西；私网场景下纯属多余 |
| C. 手机 SSH 隧道为主通道 | 降级为文档化备用通道 | 电脑端零改动、准入天然放行（回环 Host），但后台冻结、手动重连、端口记账体验差，且无配对/发现能力 |

否决的变体：「把 DSH 绑到所有网卡」。webServer 配置层留有 `0.0.0.0`（事实 9 的
Config 联合类型），但 CLI 明确拦截并写明安全理由（事实 1）；`tailscale serve`
达到同样可达性且 DSH 保持回环，不与产品安全姿态对抗。

## 4. 架构

### 4.1 每台主机的一次性配置（安装器完成）

1. `tailscale serve --bg <DSH 回环端口>`：把回环端口发布为
   `https://<机器名>.<私网>.ts.net/`（Let's Encrypt 证书，仅私网内设备可达）；
2. 安装器探测本机 ts.net 名称（读本机 Tailscale 状态），写入 DSH profile 的
   `trustedHosts`（connection 插件行，事实 4 的名单）；探测不到时提示手填；
3. serve 指向 DSH 实际监听端口——端口变更需重跑 serve 命令，安装文档写明
   「固定端口」建议。

不设 `publicUrl`：桌面端继续打印/打开回环地址，桌面可用性不依赖 Tailscale
在线（本机浏览器经 ts.net 域名访问在 tailscaled 离线时不可达，不能让它成为
桌面端的单点）。

### 4.2 新包 `packages/dsh-mobile-entry/`（宿主侧）

- **`prefix` 路由 `/threadharbor/mobile/`**（路径实施时可调，避开 `/api`）：
  服务包内自带的手机页静态资源。命名路由优先于官方 SPA 的 fallback（事实 9），
  互不干扰；
- **`GET /threadharbor/mobile/peers`**：本机 Tailscale 设备名单（设备名、
  ts.net 域名、在线状态）+ 对每台的 DSH 可达性探测结果。**先 admit 再应答**；
- **`GET /threadharbor/mobile/pair-url`**：返回带当前进程令牌的手机根网址
  （`https://<本机>.ts.net/threadharbor/mobile/?…` 形态，令牌经官方
  authenticated-url 机制生成）。**先 admit 再应答**——只有已通过准入的桌面端
  能取，见 §6；
- Tailscale 查询：优先本地状态查询（`tailscale status --json` 子进程或本地
  API socket），不可用时返回结构化错误（手机页显示「本机 Tailscale 不可用」）；
- 可达性探测：服务端对每台 peer 的 `https://<peer>.ts.net/` 发短超时请求
  （约 2s、并发、秒级缓存），按 DSH 实例的特征识别；特征标记实施时定，
  候选是官方 SPA 首页响应中稳定的元信息。探测只回答「是否 DSH」，不携带会话数据。

### 4.3 手机页（包内静态资源）

纯静态单页，**不进** DSH 客户端插件体系（cordis-client-runner / slots）——
避免继承桌面 shell 的构建链与运行时依赖；不要求 `window.__DSH_BOOT__`。
首屏即主机清单。数据通道全部复用官方表面：

- 会话列表 / 内容分页 / 发消息 / 批权限 / 停止：官方 `/api` RPC（事实 4/6）；
- 实时更新：官方 WebSocket 事件流（事实 5）；
- 同源 + cookie，与桌面端同一凭据。

### 4.4 桌面端「手机配对」入口（`packages/dsh-client/` 内新增 occupant）

- 小面板显示 `pair-url` 接口返回网址的二维码；
- 挂载优先 sidebar slot；若 occupant 挂载遇阻，降级为会话页顶部入口，
  实施时定（联邦面板「未挂进侧栏」是 KNOWN_UNWIRED 的既有事实，本入口
  不与它耦合）。

## 5. 配对与凭据生命周期

1. 桌面端打开「手机配对」→ 显示二维码。内容是 `pair-url` 返回的
   **手机页根网址 + 进程令牌**（`authenticatedUrl` 生成，事实 12）；
2. 手机扫码打开 `https://<机器>.ts.net/threadharbor/mobile/?…token…`。
   手机页处理器对**带令牌的到访**做一个「把请求路径视为根」的薄封装，委托
   官方 `authorizeIndex` 完成交换（事实 11）：令牌有效则铸 cookie 并 303 到
   `./`——相对重定向由浏览器按**手机页自身**的路径解析，正好落回手机页，
   此时 cookie 已带上。封装不接触密钥与签名，只是路径改写 + 响应转交；
3. 无令牌、cookie 有效 → 直接放行手机页；无令牌、无 cookie → 返回手机页的
   **配对引导屏**（公开的应用壳，见 §6 的口径说明），页面 JS 调 `/api`
   探测配对状态；
4. cookie 默认 30 天，**跨 DSH 重启有效**（签名密钥持久化，事实 7）；令牌
   随进程轮换，只在扫码那一刻消费一次；
5. 换手机 / 清浏览器数据 → 重扫；多部手机同时配对互不影响（cookie 按
   authority 区分，事实 8）；凭据过期（401）→ 回到配对引导屏。

## 6. 安全模型

- **不新增任何无凭据控制面**。新包只有三类出口：手机页应用壳（含配对引导屏）、
  `peers`、`pair-url`——后两者先 admit（照抄事实 4/5 的官方写法），未通过即
  401/403；
- 应用壳的公开口径与官方有一处**有意差异**：官方对 SPA 首页设授权（不向未配对
  浏览器输出应用壳，事实 11），手机页的应用壳**公开返回**——它同时承担配对
  引导屏的职责，内容无秘密，全部数据能力都在 `/api` 围栏之后。带令牌到访时
  仍经 `authorizeIndex` 走官方交换（§5）；
- 手机的能力边界 = 官方 `/api` 在操作者 Peer 身份下的能力边界（事实 6），
  不放大、不另设；
- `pair-url` 只在**已通过准入的桌面端**可见（操作者本人），二维码靠物理在场
  传递；打印 URL 的终端途径在文档中标注「含进程凭据，勿外传」；
- 私网边界：`tailscale serve` 仅对 tailnet 内设备可达，叠加 Tailscale 设备
  授权；`peers` 探测不越过私网；
- 旧文档「阶段 0 先补鉴权」的关切因「不自建控制路由」而消解——没有无凭据
  路由需要补墙。

## 7. 错误处理

| 现象 | 手机页呈现 | 说明 |
|---|---|---|
| 401（未配对/凭据过期） | 配对引导屏：指向该机桌面端二维码入口 | 官方语义 |
| 403（域名不在信任名单） | 「这台机器没配好信任主机」提示，指向安装文档 | 与 401 区分开 |
| 网络不可达 | 「检查 Tailscale」提示 | 手机或对端离线 |
| 本机 Tailscale 查询失败 | 主机清单区显示「本机 Tailscale 不可用」，其余功能不受影响 | 清单是本地增强 |
| 会话中 WS 断线 | 自动重连；回前台先拉一版最新状态 | 第一版整页级补齐，不做精确断点续传 |
| 对端 DSH 离线 | 主机清单该项置灰 | 探测结果 |

桌面端故障隔离：电脑 Tailscale 掉线 / serve 失效只影响手机可达性，桌面照常
（§4.1 不设 publicUrl 的理由同源）。

## 8. 前置验证（阶段 0，真机：一台 Mac + 安卓手机）

| # | 验证项 | 预期 | 不过时的退路 |
|---|---|---|---|
| V1 | `tailscale serve` 转发是否保留浏览器侧 `Host`（准入放行的前提，事实 3 的代理义务） | 保留 | 本机轻量转发小进程（自管转发天然可控） |
| V2 | serve 对 WebSocket 升级的转发 | 支持 | 同 V1 退路 |
| V3 | 电脑重启后 serve 配置自动恢复 | 恢复（tailscaled 持久化 serve 状态） | 文档写明重跑一条命令 |
| V4 | DSH 重启后手机 cookie 仍有效 | 有效（事实 7 密钥持久化） | 如意外失效，明确「重启后重扫码」并复核密钥路径 |
| V5 | 安卓 Chrome 信任 ts.net 证书 | 信任（Let's Encrypt） | 无——需换通道 |
| V6 | 审批与停止在官方接口中的确切形状（代码核对，非真机） | 存在可用端点 | 如缺失，审批改走桌面端、手机端降级只读（此为范围变更，需用户确认） |
| V7 | §5 的授权封装在真机走通：扫码 → 303 落回手机页 → cookie 生效 → `/api` 放行 | 走通 | QR 改指官方根路径完成交换（纯官方路径；交换后落在桌面 SPA，用户再打开手机页书签，体验降级） |

V1–V3 任何一条不过都**不推翻方案 A**，只把「serve」替换为「本机轻量转发」。

## 9. 分期

- **阶段 0**：§8 验证清单全过（或走退路定案）；
- **阶段 1**：新包（路由 + 静态页 + peers + pair-url）、桌面二维码入口、
  安装器探测与 `trustedHosts` 写入、文档（重写 `mobile-client.zh.md`、
  安装文档加「手机通道」一节、README 当前能力更新）；
- **阶段 2（打磨，另行排期）**：加到主屏的 manifest 与图标、断线补齐精细化、
  通知（维持「仅原生 App 可做」结论，评估是否立项）。

## 10. 测试

- 新包单元测试：三路由的准入行为（无凭据 401/403、有凭据 200）、授权封装的
  三个分支（带令牌换 cookie 并 303、带 cookie 放行、两者皆无返回引导屏）、
  Tailscale 不可用的错误形状、peers 数据映射、静态资源服务；
- **wiring 检查**：新包必须从宿主加载入口可达；不可达要么修挂载，要么在
  `tests/wiring.spec.ts` 的 `KNOWN_UNWIRED` 登记理由（仓库既有硬规矩）；
- 手机页：关键交互（配对引导、会话浏览、发消息、批权限、停止）的轻量 DOM
  测试；
- 真机验收：复用阶段 0 环境，按 §7 错误表逐项演练 + 第一版功能全流程。

## 11. 文档更新（随阶段 1）

- 重写 `docs/mobile-client.zh.md`：以本设计为准，删 gateway/hostd 时代的
  接法与「控制面无鉴权」的缺口描述；
- `docs/install.zh.md`：新增「手机通道」一节（serve 命令、trustedHosts 自动
  探测、SSH 备用通道一段）；
- `README.md`：当前能力清单加手机入口一行；仓库结构加新包一行。

## 12. 未决问题

- 手机页路径最终定名（`/threadharbor/mobile/` 为占位）；
- DSH 实例探测的特征标记选型（阶段 0/1 实施时定，见 §4.2）；
- 桌面二维码面板挂 sidebar 还是会话页顶部（§4.4，实施时定）。
