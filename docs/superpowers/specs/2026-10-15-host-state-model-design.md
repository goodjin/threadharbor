# 主机状态模型：把「这台机器到底怎么了」读出来

> 状态：四段设计已与用户逐段对齐，待审阅
> 日期：2026-10-15
> 范围：主机设置里的状态词、配套按钮、Tailscale 选择器接线、SSH 读取层扩一条
> 存活探测、新增「启动对方 DSH」动作。
> 前置：本文接续 [docs/ssh-deploy.zh.md](../../ssh-deploy.zh.md)。那份文档第 15 行
> 已经写明「从 Tailscale 选」只用来填写 SSH 目标、不让 DSH 听在 Tailscale 地址上——
> 本文让代码真正做到这句话。

## 1. 背景与目标

主机设置里，一台 Tailscale 显示在线、选进来的机器，点「检测可达」却报
「网络层失败：地址不可达、端口没有监听」。追下来是两个独立问题叠在一起：

1. **接线接错了。** Tailscale 选择器把 tailnet 地址填进了「主机地址」栏，而那一栏
   是 DSH 网页的地址。远端 DSH 只听自己的 `127.0.0.1`，tailnet 地址上没有任何端口
   在听——选择器填进去的东西从来就不是一个能打开的网页地址。
2. **状态只有一根轴。** 主机行的连接状态只有已连接 / 可达 / 未连接 / 检测中四态，
   判定只看「这台机器此刻在不在频道上」加「刚才那次浏览器探测通没通」。没有
   「装没装」和「起没起」这两根轴，一台压根没部署过的主机和一台部署好但隧道断掉
   的主机长得一模一样。

目标：

1. 每一台主机在列表行有且只有一个状态词，如实区分未部署 / 未启动 / 不可用 /
   不可达 / 可用 / 已连接 / 本机 / 未知；
2. 每种状态配对应的按钮，按钮就是那台主机此刻真正需要的动作；
3. 「装没装」「起没起」必须是**从对方机器读回来的事实**，不是从登记簿里有没链接
   猜出来的；
4. Tailscale 选择器填 SSH 目标，不再填主机地址。

明确不做：常驻轮询（§3 否决理由）；把部署与探测合并成一次动作；远程改对方的
DSH 配置。

## 2. 已核对的关键事实（2026-10-15，基准本仓库 HEAD）

| # | 事实 | 出处 |
|---|---|---|
| 1 | Tailscale 选择器选中后写入的是地址栏与名称栏，IP 栏只拿到裸 IP、无端口 | `packages/dsh-client/src/panel.tsx:1143-1149` |
| 2 | 该行为被测试锁定：选中即登记 `address: 'http://100.101.1.7'` | `packages/dsh-client/tests/panel-interact.spec.ts:602` |
| 3 | IP 栏无协议时补 `http://`，不补默认端口；登记层只保留 origin，也不注入端口 | `packages/dsh-client/src/panel.tsx:352-356`、`packages/dsh-host-federation/src/registry.ts:90-103` |
| 4 | 「检测可达」用 `mode: 'no-cors'` 请求登记地址，`TypeError` 一律翻成「网络层失败」 | `packages/dsh-client/src/panel.tsx:1465`、`packages/dsh-client/src/reach.ts:30-55` |
| 5 | `peer.json` 在安装时写一次，此后不再更新——「装过」不等于「现在跑着」 | `packages/dsh-host-federation/src/ssh/manager.ts:559` |
| 6 | 部署脚本自己判活时把 `200\|401` 都当作健康——有 HTTP 应答即证明有东西在听 | `packages/dsh-host-federation/src/ssh/manager.ts:563`、`:575` |
| 7 | 部署永远绑 `127.0.0.1`，访问一律走 SSH 隧道 | `packages/dsh-host-federation/src/ssh/manager.ts:200`、`src/ssh/access.ts:49-55` |
| 8 | 远端启动方式：有 systemd 走 `systemctl --user enable --now`，否则杀旧 pid 再 `nohup` 拉起 | `packages/dsh-host-federation/src/ssh/manager.ts:566-573` |
| 9 | 主机行状态是一根轴，由「在频道上」与「探测结果」两件事推出 | `packages/dsh-client/src/panel.tsx:211-236` |
| 10 | 「未部署」只存在于左侧会话树，判据是「登记里有没有 launchUrl」 | `packages/dsh-client/src/host-roll-up.ts:68`、`src/host-session-tree.tsx:313-332` |
| 11 | 现有 `readPeer` 是一次 SSH 往返，只 `cat` 那份记录文件 | `packages/dsh-host-federation/src/ssh/manager.ts:81-102` |
| 12 | 密码与粘贴私钥**不落盘**，只有密钥文件方式能免输入复用 | `packages/dsh-client/src/panel.tsx:1477-1488` |
| 13 | 主机密钥不匹配时读取失败是 fail-closed 的既有设计 | `packages/dsh-host-federation/src/ssh/manager.ts:82-87` |

## 3. 方案选择

| 方案 | 结论 | 理由 |
|---|---|---|
| **A. 状态读回来**（进详情页 SSH 读一次，缓存喂列表） | **采用** | 「装没装 / 起没起」来自对方机器的真实应答；一次 SSH 往返，成本不增 |
| B. 本地推断（用登记里有无链接 + 隧道口通不通） | 否决 | 隧道断与对方没跑被混为一谈——这正是「靠猜」 |
| C. 后台常驻轮询（每 30s 遍历所有主机） | 否决 | N 台 × 每 30s 次 SSH 登录，笔记本合盖与网络抖动全受影响；列表数字变新的收益远小于代价 |

## 4. 状态模型

### 4.1 事实层

**对方机器上的事实**（要 SSH 才知道）：

| 事实 | 取值 |
|---|---|
| `deployment` | `undeployed` / `deployed` / `unknown` |
| `liveness` | `stopped` / `running` / `unknown` |
| 附带 | 远端网页端口、带 token 的启动网址 |

**本机自己知道的**（不用 SSH）：

| 事实 | 取值 |
|---|---|
| `readable` | 这台主机的远端状态读得到吗（有可用的已批准 SSH 凭据）。直连主机为 `false` |
| `reach` | `unchecked` / `checking` / `reachable` / `unreachable` |
| `reported` | 对方页面开着时有没有回连本机频道（取自频道在场快照，即今日 `HostListRow.online`） |

`readable` 是必需的而非冗余：直连主机与「SSH 凭据不可用」的主机，`deployment` 与
`liveness` 同为 `unknown`，只有 `readable` 能让推导函数把两者分开——前者按本机探测
给状态词，后者如实说不知道。

### 4.2 推导表

主机行的状态词，按顺序取第一个成立的：

| 状态词 | 条件 |
|---|---|
| 本机 | `self` |
| 读取中 | 正在 SSH 读；**已有上次读数则继续显示旧词**，不闪回未知 |
| 未部署 | `deployment = undeployed` |
| 未启动 | `deployment = deployed` 且 `liveness = stopped` |
| 已连接 | `liveness = running` 且 `reach = reachable` 且 `reported` |
| 可达 | `liveness = running` 且 `reach = reachable` 且未回连 |
| 未连接 | `liveness = running` 且 `reach = unreachable`（隧道未建或已断） |
| 未验证 | `liveness = running` 且 `reach` 为 `unchecked` 或 `checking`（没探测过 / 正在探测） |
| 未知 | `readable` 为真但读不到（`deployment = unknown`）：没凭据 / 凭据错 / 连不上 / 超时 |

三条约束：

- **「未连接」必须建立在「对方确实在跑」之上。** 今天没探测过也显示未连接，那是拿
  「没查」冒充「查过了坏的」；以后「从未探测」一律叫未验证。
- **直连主机不被冤枉。** 没有 SSH 凭据的主机，`deployment` / `liveness` 为
  `unknown`，但状态词仍由 `reach` 给出——打得开就是可达或已连接，打不开就是未连接。
  「不知道对方装没装」与「实实在在打得开」不冲突。
- **详情页四行摊开，列表只给一个词。** 详情页逐行显示部署 / 运行 / 本机入口 /
  对方回连，哪一环出的问题一眼看到，按钮随之逐行对应。

### 4.3 状态推导的实现边界

状态推导是一个**纯函数**：输入 4.1 的事实集合，输出状态词与该显示哪些按钮。它不碰
DOM、不发请求、不读时钟，独立文件、独立单测。面板只负责取事实与渲染。

```ts
export type HostDeployment = 'undeployed' | 'deployed' | 'unknown'
export type HostLiveness = 'stopped' | 'running' | 'unknown'
export type HostReach = 'unchecked' | 'checking' | 'reachable' | 'unreachable'

export type HostFacts = {
  readonly self: boolean
  /** 这台主机的远端状态读得到吗；false = 直连主机，退回本机探测。 */
  readonly readable: boolean
  readonly deployment: HostDeployment
  readonly liveness: HostLiveness
  readonly reach: HostReach
  readonly reported: boolean
}

export type HostStatus =
  | 'self' | 'reading' | 'undeployed' | 'stopped'
  | 'connected' | 'reachable' | 'disconnected' | 'unchecked' | 'unknown'

/** The word the host list shows. */
export function hostStatus(facts: HostFacts, reading: boolean): HostStatus

/** The buttons the detail page offers for one status, primary first. */
export function hostActions(status: HostStatus): readonly HostAction[]
```

`HostDeployment` / `HostLiveness` 不另起一套：直接复用 §10 里登记簿存的那个
`RemoteReport` 的同名字面量联合，避免两份同义类型。

## 5. 按钮表

**主机行**只放状态词与一个「刷新对方状态」小按钮（读取中转圈）。其余按钮一律不上行。

**详情页**：

| 状态 | 主按钮 | 次按钮 | 常驻 |
|---|---|---|---|
| 未部署 | 部署 DSH（SSH） | 读一次对方状态 | 删除登记 |
| 未启动 | 启动对方 DSH | 重新部署（完整装一遍） | 删除登记 |
| 已连接 | 打开页面 | 检查能否打开 | 复制带 token 链接、删除登记 |
| 可达 | 连接并打开 | 检查能否打开 | 同上 |
| 未连接 | 连接并打开 | 检查能否打开 | 同上 |
| 未验证 | 检查能否打开 | 连接并打开 | 删除登记 |
| 未知 | 去填写连接方式 | 重试读取 | 删除登记 |

本机与读取中不出按钮：前者不是可连接的对象，后者正在读，按钮要等读数出来再定；两
者此时只有主机行上的那个刷新小按钮可用。

### 5.1 两个按钮合并

「检测可达」（登记区块）与「检查隧道」（使用区块）问的是同一件事——登记里那个地址在
本机打得开吗。合并为**「检查能否打开」**：SSH 主机问隧道口，直连主机问它自己的地址。

### 5.2 未批准主机密钥

自动读取同样需要主机密钥已批准。未批准时状态显示「未知（还没批准这台机器的主机密钥）」，
主按钮换成**「批准并读取」**：先扫描、让操作者认指纹、再读。

## 6. 读取层

### 6.1 一次往返问两件事

在现有 `readPeer` 的**同一次 SSH 连接**里追加存活探测，成本不增。

| 对方的回答 | `liveness` |
|---|---|
| 任何 HTTP 应答（含 401 / 403） | `running` |
| 连接被直接拒绝 | `stopped` |
| 超时，或对方既无 `curl` 也无 `node` | `unknown`（附一句人话原因） |

- 401/403 证明有东西在听，**不得**当成没跑（与事实 6 的既有判据一致）。
- 探测命令优先 `curl`，无 `curl` 退回 `node`（远端本就要求 Node 22），两者皆无才
  `unknown`。
- 记录文件不存在直接判 `undeployed`，不再探测。

### 6.2 返回形状

在既有字段（`pluginsInstalled` / `listen` / `port` / `bindHost` / `launchUrl`）之外
增加 `liveness`（三态）与 `livenessNote`（判不出来时的一句原因）。读到的时刻由面板盖
本机时钟，远端不提供时间。

`parsePeerStatus` 保持为纯文件解析器，不动。

### 6.3 读失败不覆盖上一次成功读数

SSH 读失败（对方重启、网络抖、主机密钥变更）时：状态显示「未知（这次没读到：原因）」，
并在下方小字保留「上次读到的是：已部署 · 已启动 · N 分钟前」。

瞬时故障不得把一台好主机从「已连接」变成「未知」。

### 6.4 超时

一次读取 8 秒总预算，到点按「未知（读取超时）」处置，不悬挂。

### 6.5 缓存

进详情页总是重读；列表行显示上次读到的值。详情页显示「读到的时刻」并给「刷新对方状态」。
**不做过期打标**——超过 N 分钟变灰是个没人会看的细节，只会多一个状态词。

## 7. 启动对方 DSH

「未启动」给的是轻量启动，不是完整重装。部署脚本里的启动分支（事实 8）抽成一段能
单独执行的脚本，「启动对方 DSH」直接复用：

- 有 systemd：`systemctl --user enable --now <service>`
- 否则：杀 pid 文件里的旧进程 → 等端口腾空 → `nohup` 拉起 → 写 pid 文件

**成功判据是「起来之后端口有 HTTP 应答」，不是「kill 成功」**——macOS 无 systemd，
pid 文件可能留着早已消失的进程号。

「重新部署」（完整重装）保留为次按钮。

## 8. Tailscale 选择器改接线

选中一台之后：

| 栏位 | 填什么 |
|---|---|
| 名称 | 节点名（MagicDNS 名优先，`tailscale.ts` 既有取舍不变） |
| SSH 目标 | 该 peer 的 tailnet 地址（没开 MagicDNS 也能用） |
| 主机地址 | **留空**，旁注「部署或连接成功后自动写入」 |

主机地址从此只由部署/连接结果决定。地址栏保持可编辑（直连主机需要），但标签注明
「留空 = 由部署或连接自动写入」。

### 8.1 添加页选中之后自动切到 SSH 部署区

地址留空意味着「按确定」会撞上既有的「地址不能为空」。所以在**添加页**选中一台之后：

- 名称栏、SSH 目标栏填好，地址栏留空；
- 页面自动切到「SSH 自动部署」区块，SSH 目标输入框已带值；
- 操作者按「部署 DSH 并登记」，部署成功时写入地址与带 token 的网址。

这条路径就是原始需求本身：选机器 → 部署 → 连过去用。详情页没有这层问题——地址栏
已经存在，选择器只改名称与 SSH 目标，登记里的地址原样不动。

## 9. 直连主机的退化路径

没有 SSH 凭据的主机走浏览器探测：`deployment` / `liveness` 均为 `unknown`，状态词由
探测结果给出（§4.2 约束二）。

探测文案补一条诚实性：地址没带端口时，明确写出检测目标——
「正在检测 `http://100.101.1.7` 的 80 端口（地址没写端口）」——而不是笼统的
「网络层失败」。让人一眼知道是自己少填了端口。

## 10. 存储

登记条目增加两个字段：上次读到的结果（`deployment` / `liveness` / `livenessNote` /
`readAt`），随登记簿一起持久化。与既有 `launchUrl`（含 token）同属敏感数据，沿用同一
套存储与校验口径。

## 11. 已知限制

1. **密码认证的主机读不了。** 密码与粘贴私钥不落盘（事实 12），这些主机自动读取必然
   失败。状态必须明写「这台主机用密码认证，凭据不保存，读不了对方状态」，并在 SSH
   区块里前置提示：在这个页面再输一次才能读。不处理的话，这些主机会永远停在
   「未知」，比今天的「未连接」更让人困惑。
2. **无 systemd 的机器走 pid 文件路径**，可能留下陈旧 pid（§7 已定成功判据）。
3. **慢网络下 8 秒可能不够**——宁可报「未知（读取超时）」也不报「未启动」。把一台
   只是慢的机器说成没跑，后果比含糊严重。
4. **主机密钥变更仍然读不到**，fail-closed 保持不变（事实 13），不为新功能放松。
5. **两边时钟不对齐**——时刻一律本机时钟。

## 12. 验证

**单测为主。**

- 状态推导：4.1 事实集合的完整组合表，断言状态词；逐状态断言按钮集合。
- 读取层：假 SSH 执行面，喂「有 HTTP 应答 / 连接被拒 / 既无 curl 也无 node /
  记录文件不存在」四种回答，断言分到 `running` / `stopped` / `unknown` /
  `undeployed`；断言 401 判为 `running`。
- 读失败：断言旧读数被保留且标注时刻。
- 启动动作：断言 systemd 分支跑 systemctl、无 systemd 分支跑 nohup，断言成功判据是
  端口应答而非 kill 结果。
- 界面接线：沿用现有挂面板测试，喂假端口，逐状态断言按钮在不在、文案对不对。
- 选择器：断言选中后名称栏与 SSH 目标栏填上、地址栏留空。

**真机闭环（唯一能证明它真对的一步）：** 一台真机器 → 全新登记（未部署）→ 部署 →
已连接 → 在对方杀掉进程 → 详情页重读变未启动 → 点「启动对方 DSH」→ 恢复已连接。
另单独验一次：手动删掉地址栏端口，看检测是否把「在检测 80 端口」明说出来。

## 13. 文档同步

`docs/ssh-deploy.zh.md` 的「界面：会话树与主机状态」一节与状态相关描述需按 §4、§5
改写；该文档第 15 行关于选择器的句子在代码对齐后保留，并在正文注明已实现。
