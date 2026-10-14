# 阶段 0 真机验证 · SSH 隧道换 cookie 与 WS 带 Cookie 头（Task 1 探针实测）

- **核对时间：2026-10-16**（简报指定；探针实际执行时两台机器系统时钟均为 2026-10-14，特此注明）
- **执行者：** mobile-relay 分支 Task 1（探针脚本 `scripts/probe-relay-wire.mjs`，提交见分支历史）
- **结论速览：** 简报要求的 6 项探针条目在两个方向（本机→tencent01、tencent01→本机）**全部实测通过**（Run A / Run B 各 7/7，含一次前提反转的单独记录）。方案的承重链路（SSH 隧道 → 读日志取令牌 → 换 cookie → RPC → WS 事件流）成立。有 3 条实测结论与简报/设计的既有表述不一致，见「需要改设计的发现」。
- **参考源码钉死基准：** `reference/deepseek-harness` @ `d743267388641bc76f17c45ce8b4c231aed1d32c`（master，2026-10-09；DSH 0.2.1-alpha.2）。本文所有「源码钉死」行号以该 ref 为准（设计文档里的 `api-request-trust.ts:103` 是旧 ref 的行号，本 ref 对应主函数在 `api-request-trust.ts:121`）。

---

## 1. 环境与安装明细（全部为增量安装）

### 1.1 tencent01（未来云主机，212.64.11.60 / tailnet 100.84.120.35）

| 项 | 值 |
|---|---|
| 系统 | OpenCloudOS 9.4，x86_64，2 vCPU，1.9 GiB 内存 |
| Node | **v24.18.1**，装在 `/usr/local/node-v24.18.1-linux-x64`（官方 tar，SHA256 校验通过），软链 `/usr/local/bin/{node,npm,npx,corepack}`；系统自带 `/usr/bin/node` v20.20.2 **未动** |
| DSH | `@deepseek-ai/dsh` **0.2.0-rc.2**，`npm install -g '@deepseek-ai/dsh@>=0.2.0-rc.2 <0.3'`（与部署脚本 `buildInstallScript` 同款命令），软链 `/usr/local/bin/dsh` |
| ThreadHarbor | 源码安装（`threadharbor` 未发 npm）：`git clone --depth 1 https://github.com/goodjin/threadharbor.git /root/threadharbor`（main@d5c055f）→ `npm i -g pnpm@11.7.0` → `pnpm install` → `pnpm run build`（exit 0）→ `dsh plugin --profile web add link:/root/threadharbor` |
| 独立家目录 | `/root/.dsh-threadharbor-stable`（`DSH_HOME` 指向它；不触碰机器上任何既有配置） |
| 启动命令 | `DSH_HOME=/root/.dsh-threadharbor-stable nohup dsh --profile web --no-open --port 3080 --host 127.0.0.1 --trusted-host relay.example.invalid >> /root/.local/state/threadharbor/stable/dsh-web.log 2>&1 &` |
| 启动日志 | `/root/.local/state/threadharbor/stable/dsh-web.log`（0600），启动后由部署侧回写 `LAUNCH_URL=<url>` 标记（复刻 `buildInstallScript` 的 `emit_success` 语义） |
| 占位域名 | **`relay.example.invalid` 是占位符——公网域名待用户确认，当前为占位**；它只出现在 `--trusted-host` 里，本次全部验证走回环/隧道地址，未做任何 DNS 或证书操作 |
| 健康基线 | `curl 127.0.0.1:3080/` → 401（服务活、未认证即拒），`ss` 确认只监听 `127.0.0.1:3080` |

### 1.2 本机（对端测试机，Mac；tailnet `gooddemacbook-pro` 100.108.29.119）

| 项 | 值 |
|---|---|
| 一次性对端实例 | 家目录 `~/.dsh-threadharbor-relay-spike`（全新，未触碰既有家目录）、端口 3082、**不带 `--trusted-host`**（顺带实测设计 §3 的回环免信论断） |
| 启动命令 | `DSH_HOME=~/.dsh-threadharbor-relay-spike nohup node <dsh全局>/lib/bin.js --profile web --no-open --port 3082 --host 127.0.0.1 >> ~/.local/state/threadharbor/relay-spike/dsh-web.log 2>&1 &`（dsh 0.2.0-rc.2；纯 web profile，不含 ThreadHarbor 插件——正是生产对端形态） |
| 启动日志 | `~/.local/state/threadharbor/relay-spike/dsh-web.log`（0600，含 `LAUNCH_URL=` 标记）；**验证完成后此实例停掉** |
| SSH 免密 | `tencent01-root → good@100.108.29.119` 已配好（`ssh -o BatchMode=yes` 实测 `auth-ok-good`；`hello@` 不通，未使用） |

### 1.3 关于「本机 3081 日常实例的启动日志」（简报要求确认的一项）

**确认结果：不存在可 grep 的落盘日志。** 3081 实例（`node <dsh全局>/lib/bin.js --profile web --port 3081`）的 stdout 被拉起它的终端/桌面接管；`~/.dsh/web.log` 里只有旧 3080 实例的 `dsh web:` 行；`~/.dsh-threadharbor-stable/threadharbor-runtime/web.log`（release-channel 稳定通道日志）与 `~/.dsh/logs/`（启动审计报告）里都没有 3081 的启动行（grep `127.0.0.1:3081` 零命中）。

**由此得出的部署要求（对设计 §11 准备清单的补充）：** 要接入中转的机器，其 DSH 必须以「输出落盘」的方式启动（部署脚本/守护进程重定向），否则「云主机经 SSH 读日志换凭据」的自愈链路无据可依。本验证因此用部署式临时实例代表本机对端——这恰好是生产形态。

---

## 2. 逐条结论（每条一行，标注「实测」或「源码钉死」）

| # | 结论 | 依据 |
|---|---|---|
| 1 | **实测** SSH 本地转发双向可行：本机→tencent01 走公网 22（`tencent01-root`），tencent01→本机走 tailnet（`good@100.108.29.119`）；`ssh -N -L 127.0.0.1:<L>:127.0.0.1:<远程端口>` 站住后，隧道口 HTTP 应答 401（可达且未认证即拒） | Run A/B `check.tunnel` |
| 2 | **实测** 云主机经 SSH 读对端启动日志取令牌可行：`grep -h '^LAUNCH_URL=' <日志> \| tail -1` 取最后一行标记，令牌取到（长度 43，原文不打印）；无 `LAUNCH_URL=` 行时兜底 `grep -h '^dsh web: '`（`launch_url_from_log` 同款） | Run A/B `check.launchUrl`；源码钉死 `packages/dsh-host-federation/src/ssh/manager.ts:539-542`、`access.ts:62-64`（本仓） |
| 3 | **实测** 经隧道 `GET /?token=<令牌>` → **303** `location: ./` + `Set-Cookie`；cookie 名为 `dsh-auth-<随机后缀>`（**每个实例不同**：三次实测三个名字），值长 173，属性 `Max-Age=2592000`（30 天）、`Path=/`、`HttpOnly`、`SameSite=Strict` | Run A/B `check.authExchange`；源码钉死 `browser-auth.ts:129`（属性模板）、`:52-59`（启动令牌每次进程激活 `randomBytes` 生成、不落盘）、`:300`（`isAuthenticated` 只读 cookie，绑定 authority） |
| 4 | **实测** 带 cookie `POST /api/session/list` 成功（HTTP 200，`result.ok=true`），但**生效信封是 `payload:{args:{_request:{}}}`，不是简报写的 `payload:{args:{}}`**：传输层要求「payload 恰有一个平面对象字段 args」（违反报 `gateway/internal: Remote payload must contain exactly one plain-object args field`），描述符层要求 args 内含 `_request`（违反报 `gateway/arguments-invalid: …missing "_request"`）。与 2026-10-15-mobile-wire 探针钉死的 `_request` 形态一致 | Run A/B `check.rpcSessionList`（含一次自适应重试的完整错误原文）；源码钉死 `rpc-host.ts:107-118`（fence→403、auth→401 语义，本次实测 401/303/200 逐层吻合） |
| 5 | **实测** `ws` 库带 `Cookie` 头升级 `ws://…/api/remote.mux` 成功：发 open 帧（`payload` 恰为 `{"args":{}}`）后收到 `ready` 帧（`type:"item"`），`value.clientId` 存在（36 字符 UUID）。ws 从各机 DSH 安装解析（本机 `~/.local/share/node-v24.18.1…/lib/node_modules/@deepseek-ai/dsh`，tencent01 `/usr/local/node-v24.18.1-linux-x64/lib/node_modules/@deepseek-ai/dsh`），无需改仓库依赖 | Run A/B `check.wsMuxReady`、`ws.module` |
| 6 | **实测** tailscale 对端发现可用：`tailscale status --json` 在云主机上返回 6 个对端（Self.Online=true）；本机同法 6 个 | Run A/B `check.tailscalePeers` |
| 7 | **实测** 回环 authority 免 `--trusted-host`：对端实例未带该参数，隧道后 authority `127.0.0.1:<L>` 全链路通（从未出现 403）——设计 §3「隧道后端无需 --trusted-host」成立 | Run A 全链路；源码钉死 `api-request-trust.ts:121-150`（`isTrustedApiRequest`：Host 栅栏对回环放行在 `:137`，Origin 缺失放行在 `:148-149`） |
| 8 | **实测（简报外补充）** 隧道口 hello 探测成立：经隧道 `GET /threadharbor/mobile/hello` → 200 `{"mobile":true}`（阶段 0 ④ 的探测面；tencent01 装的 threadharbor main 自带 dsh-mobile-entry） | 2026-10-16 本机→tencent01 临时隧道 curl |
| 9 | **源码钉死** 部署脚本把 `launch_url_from_log` 的结果以 `LAUNCH_URL=` 回写（`manager.ts:542`）；解析规则 `startsWith('LAUNCH_URL=')` 取最后出现（`access.ts:62-64`）——探针第 2 条的实现与生产解析器逐字一致 | 本仓 `packages/dsh-host-federation/src/ssh/` |

### ⚠️ 前提反转（单独记录，不改写链路结论）

| # | 发现 | 依据 |
|---|---|---|
| 10 | **实测（与设计 §15 预期相反）** Node **v24.18.1** 的内置 `WebSocket` 不但接受 `new WebSocket(url, { headers: { cookie } })`，cookie 也**真随升级头送达**——判定标准是：用内置实例带 cookie 升级后能以该连接拿到 `$events` 的 ready 帧（两台机器、两个方向均复现，`phase:"ready"`）。即「Node 内置 WebSocket 不能带自定义头 → 必须用 ws」这一前提在 Node 24.18.1 上**不成立**。处理建议：宿主实现**仍选 `ws`**（DSH 已依赖 ^8.21.0、行为跨版本一致、无 undici 版本耦合），但这是「选择」而非「必须」；若未来改用内置实现，须先验证目标 Node 的实际行为 | Run A/B `check.builtinWebSocketHeaders`（`premiseHeld:false`，探针 summary 的 `premiseInversions` 字段） |

---

## 3. 需要改设计的发现（按影响排序）

1. **信封形态（F4）→ 直接改 Task 2 `machine-client` 的实现输入**：`session/list` 的生效信封为 `{type:"client-request",rpcId,method,payload:{args:{_request:{}}}}`；「payload 内嵌 args」成立，但 args 内的描述符字段名**逐端点不同**（session/list 是 `_request`；对照 2026-10-15-mobile-wire：session/create、session/prompt 用 `request`，session/follow 用 `args.request` 嵌套）。Task 2 须按端点登记描述符字段，不要假设统一的 `args` 形态。计划文档 Task 3 及设计 §7 的调用面表述建议按此修订。
2. **启动日志必须落盘且追加写（§1.3 + 实测事故）**：验证过程中实测到非追加重定向（`>`）会让部署侧事后回写的 `LAUNCH_URL=` 行被服务进程的后续输出**覆写**（两边写偏移不共享）；改用 `>>`（两侧 O_APPEND）后标记稳定幸存。准备清单与部署文档必须写明：服务输出重定向用追加模式，部署侧回写标记才能存活。
3. **cookie 名带随机后缀（F3）→ 凭据存储不能写死 cookie 名**：`credentials.ts` 存取凭据要以「Set-Cookie 响应解析」为准（名字 + 值一起持久化），或只存 `name=value` 对原文。
4. **「必须用 ws」降级为「选择 ws」（F10）**：设计 §15 与开放问题的表述需修订（结论对实现有利：技术选型不变，理由更新）。

## 4. 未验证 / 缺项（如实列出，均不阻塞已验证的链路）

1. **阶段 0 ⑤（手机经公网域名访问云主机页面与配对）：未验证。** 公网域名用户尚未提供，本次以占位域名 `relay.example.invalid` 参与启动参数（无 DNS、无证书、无手机实测）。域名到位后需单独验证。
2. 本机 3081 日常实例**没有**可读启动日志（§1.3），其自身未被用作探测目标；「经 SSH 读各机启动日志」只在临时对端实例上验证了一台。其余机器接入时按同法验证。
3. cookie 的 30 天有效期只做了属性级验证（`Max-Age=2592000`），未等真实过期；「401 → SSH 重读换新」的自愈闭环属 Task 2 实现后的验证点。
4. 内置 WebSocket 的 `{headers}` 支持未绑定到 undici 具体版本的官方出处（以实测为准）；其他 Node 版本（22.x、25.x）未测。
5. `tailscale status --json` 只验证了 CLI 可用与对端可见；宿主侧复用 `queryTailscalePeers` 的 API 形态未在云主机上以宿主代码跑通（属 Task 3 范围）。
6. 生产部署脚本用 systemd 用户服务守护化；tencent01 本次按简报边界用 nohup 追加重定向，未创建 systemd 单元。守护化属后续任务/准备清单执行项。
7. `ws` 具体版本未在探针输出中打印（解析自 DSH 安装，满足其依赖约束 ^8.21.0）。

## 5. 探针脚本用法

```sh
# 离线自测（13 条夹具断言，不碰网络；TDD 先红后绿的「测试」部分）
node scripts/probe-relay-wire.mjs --self-test          # 退出码 0=全过

# 真机链路（在「云主机视角」所在机器上执行）
node scripts/probe-relay-wire.mjs \
  --machine <ssh目标>        # ~/.ssh/config 别名或 user@host
  --port <远端DSH端口>       # 对端机器上 DSH 监听的回环端口
  [--remote-log <路径>]      # 对端启动日志绝对路径；缺省尝试生产候选路径（候选里的 ~ 以远端 "$HOME" 展开后下发，不依赖远端 shell 的波浪号展开）
  [--ws-from <目录>]         # 额外的 ws 包解析目录（缺省从本机 DSH 安装解析）
  [--request-timeout <ms>]   # 单步超时，默认 20000

# 本次实测的两条命令（证据原文见 §6）
# Run B（本机→tencent01，公网 SSH）：
node scripts/probe-relay-wire.mjs --machine tencent01-root --port 3080 \
  --remote-log /root/.local/state/threadharbor/stable/dsh-web.log
# Run A（tencent01→本机，tailnet SSH；脚本先 scp 到云主机）：
node /root/probe-relay-wire.mjs --machine good@100.108.29.119 --port 3082 \
  --remote-log /Users/good/.local/state/threadharbor/relay-spike/dsh-web.log
```

输出：每条检查一行 JSON（`tag=check.<名>`，含 `ok` 与脱敏明细），末行 `summary`（`ok`/`passed`/`failed`/`premiseInversions`）。退出码：0=全部通过。脚本自证不泄密：启动即剥离全部代理环境变量（`NODE_USE_ENV_PROXY` 陷阱）；令牌/cookie 只输出「是否取到、长度、名字、属性」；内置 13 条自测含金丝雀泄密扫描。Mac 上跑须 `env -u https_proxy -u http_proxy -u NODE_USE_ENV_PROXY node …`（双保险，脚本内部亦剥离）。

## 6. 证据原文（探针完整输出，JSON 行，无凭据）

### Run B：本机 → tencent01（公网 SSH，2026-10-16 执行，机器时钟 2026-10-14）

```json
{"tag":"check.tunnel","ok":true,"machine":"tencent01-root","remotePort":3080,"localPort":50633,"httpStatus":401}
{"tag":"check.launchUrl","ok":true,"marker":"LAUNCH_URL","urlLength":72,"tokenGot":true,"tokenLength":43}
{"tag":"check.authExchange","ok":true,"status":303,"location":"./","cookies":[{"name":"dsh-auth-vEq2NloGx0VO3K1YJUG3Py20ZyCaokxDweB3K6Dx2pA","valueLength":173,"attributes":{"maxAge":2592000,"path":"/","expires":"Fri, 13 Nov 2026 07:17:44 GMT","httpOnly":true,"sameSite":"Strict"}}]}
{"tag":"check.rpcSessionList","ok":true,"status":200,"resultOk":true,"itemCount":0,"adaptation":{"briefEnvelope":"payload:{args:{}}","serverDescriptorWants":"payload.args._request","finalEnvelope":"payload:{args:{_request:{}}}","firstError":"gateway/arguments-invalid: typert gateway: session/list: args fields do not match the descriptor: missing \"_request\""}}
{"tag":"ws.module","resolvedFrom":"/Users/good/.local/share/node-v24.18.1-darwin-arm64/lib/node_modules/@deepseek-ai/dsh"}
{"tag":"check.wsMuxReady","ok":true,"upgraded":true,"readyFrameType":"item","hasClientId":true,"clientIdLength":36}
{"tag":"check.builtinWebSocketHeaders","ok":true,"available":true,"measured":true,"acceptsHeadersOption":true,"carriedCookie":true,"premiseHeld":false,"phase":"ready","verdict":"与设计预期相反：内置 WebSocket 不但接受 {headers}，cookie 也真随升级头送达（拿到 ready 帧）——「必须用 ws」的前提在本 Node 版本被推翻"}
{"tag":"check.tailscalePeers","ok":true,"available":true,"peerCount":6,"selfOnline":true}
{"tag":"summary","ok":true,"passed":7,"failed":0,"failures":[],"premiseInversions":["builtin-websocket-custom-headers"],"note":"全部条目均为实测；证据文档另有「源码钉死 + 出处」条目"}
```

说明：cookie 名出现在输出里属于「名字」而非值，符合纪律（值只给长度 173）；`expires` 为服务端属性原文。

### Run A：tencent01 → 本机（tailnet SSH，生产方向）

```json
{"tag":"check.tunnel","ok":true,"machine":"good@100.108.29.119","remotePort":3082,"localPort":36435,"httpStatus":401}
{"tag":"check.launchUrl","ok":true,"marker":"LAUNCH_URL","urlLength":72,"tokenGot":true,"tokenLength":43}
{"tag":"check.authExchange","ok":true,"status":303,"location":"./","cookies":[{"name":"dsh-auth-IA0HmU7uUvRGwbg2qowTnpMxjMv5tREaZ0ZfD1V4bqs","valueLength":173,"attributes":{"maxAge":2592000,"path":"/","expires":"Fri, 13 Nov 2026 07:19:44 GMT","httpOnly":true,"sameSite":"Strict"}}]}
{"tag":"check.rpcSessionList","ok":true,"status":200,"resultOk":true,"itemCount":0,"adaptation":{"briefEnvelope":"payload:{args:{}}","serverDescriptorWants":"payload.args._request","finalEnvelope":"payload:{args:{_request:{}}}","firstError":"gateway/arguments-invalid: typert gateway: session/list: args fields do not match the descriptor: missing \"_request\""}}
{"tag":"ws.module","resolvedFrom":"/usr/local/node-v24.18.1-linux-x64/lib/node_modules/@deepseek-ai/dsh"}
{"tag":"check.wsMuxReady","ok":true,"upgraded":true,"readyFrameType":"item","hasClientId":true,"clientIdLength":36}
{"tag":"check.builtinWebSocketHeaders","ok":true,"available":true,"measured":true,"acceptsHeadersOption":true,"carriedCookie":true,"premiseHeld":false,"phase":"ready","verdict":"与设计预期相反：内置 WebSocket 不但接受 {headers}，cookie 也真随升级头送达（拿到 ready 帧）——「必须用 ws」的前提在本 Node 版本被推翻"}
{"tag":"check.tailscalePeers","ok":true,"available":true,"peerCount":6,"selfOnline":true}
{"tag":"summary","ok":true,"passed":7,"failed":0,"failures":[],"premiseInversions":["builtin-websocket-custom-headers"],"note":"全部条目均为实测；证据文档另有「源码钉死 + 出处」条目"}
```

### 探针开发过程（TDD）

自测先红：`--self-test` 12/12 失败（全部因桩函数「尚未实现」，退出码 1）→ 实现后 12/12 通过（退出码 0）。实跑还抓出并修复了两个实现层问题：隧道检查输出引用错变量名（Run B 第一次实跑暴露）；非追加式日志重定向导致 `LAUNCH_URL=` 标记被服务日志覆写（运维要求，见 §3.2）。

评审修复轮 1（2026-10-16）：补第 13 条自测「缺省候选路径的 ~ 在远端命令里展开为 $HOME」先红后绿——单引号里的 ~ 不会被远端 shell 展开，缺省候选路径原先恒打不中；修法是候选里的 ~ 以远端 `"$HOME"` 形式下发（展开成的是远端用户家目录）。真机复跑不带 `--remote-log` 验证缺省候选命中（marker=LAUNCH_URL，7/7，exit 0）。

### 诊断过程的中间实测（tencent01 本机 curl，2026-10-16）

```text
payload={"_request":{}} → gateway/internal: Remote payload must contain exactly one plain-object args field
payload={"args":{}}     → gateway/arguments-invalid: …session/list: args fields do not match the descriptor: missing "_request"
payload={"args":{"_request":{}}} → result.ok=true（itemCount=0，新实例无会话）
```
