# 真机验收记录：手机通道（阶段 0 清单 + 第一版全流程）

- 日期：2026-10-15（机器侧实测发生于 2026-10-14 05:20–05:45 CST）　分支：mobile-entry
- 承接：spec §8 验证清单（V1–V7）+ 第一版功能全流程；机器侧（Mac）项本次实测，
  手机侧与整机重启项为用户配合项，清单见 §4/§5。
- 实例：专用探针 home `~/.dsh-threadharbor-probe`，端口 **3091**（Task 6 建立，
  源码 link 指向本 worktree；共享 test home 的 3081 常驻实例指向主 checkout、
  无 mobile-entry 行，**本任务全程未触碰**——见 §2 环境事实）。

## 1. 结论速览（spec §8 V 表）

| # | 验证项 | 结论 | 成色 |
|---|---|---|---|
| V1 | serve 转发保留 Host，准入按名单放行/拒绝 | ✅ 机器侧通过（正负两支都实测） | 线上实测 |
| V2 | serve 对 WebSocket 升级的转发 | ✅ 机器侧通过 | 线上实测 |
| V3 | 电脑重启后 serve 配置自动恢复 | ⏳ 待用户补验（命令见 §5） | — |
| V4 | DSH 重启后 cookie 仍有效 | ✅ 机器侧通过（手机侧刷新确认待用户） | 线上实测 |
| V5 | 安卓 Chrome 信任 ts.net 证书 | ⏳ 待用户执行（机器侧已证证书链为 Let's Encrypt 且本机校验通过） | 机器半实测 |
| V6 | 审批与停止端点形状（代码核对） | ✅ Task 6 已闭（四端点全部存在且实测） | 线上实测 + 源码钉死 |
| V7 | 扫码 → 303 落回手机页 → cookie 生效 | ✅ 机器侧半程通过；扫码本身待用户执行 | 机器半实测 |
| R9 | 真实审批回路（答→了结→另一端收 cancel） | ⏳ 待用户执行（既有证据见 §6） | 源码钉死 + 单测覆盖 |

退路判定：**全部未触发**（V1/V2 过→不需本机轻量转发；V7 机器半程过→QR 不改指官方根路径）。
无 BLOCKED 项。

## 2. 环境事实（复跑必读）

1. **实例与 home**：手机通道验收必须打探针实例——
   `THREADHARBOR_DSH_HOME=~/.dsh-threadharbor-probe THREADHARBOR_WEB_PORT=3091`。
   共享 test home（3081）的 profile 指向主 checkout，组合里没有 mobile-entry 行，
   打它会测错实例。3081 常驻实例本任务全程未触碰（收尾时 pid 29553 与开工时一致）。
2. **本机 ts.net 域名**：`gooddemacbook-pro.tailb6790d.ts.net`（读自
   `tailscale status --json` 的 `Self.DNSName`，去结尾点）。
3. **本机 shell 代理会劫持回环外请求（首次排障绕了远路，复跑者先看这条）**：
   本 shell 导出 `https_proxy=http://127.0.0.1:7897`、`all_proxy=socks5h://…`、
   `NODE_USE_ENV_PROXY=1`。curl 与 Node 24（fetch/WebSocket 都算）会把
   `*.ts.net` 的请求交给这个本地代理，而代理出不了 tailnet，表现为 TLS 握手阶段
   `SSL_ERROR_SYSCALL` / `ECONNRESET`——不是 serve 或证书的问题。复跑命令一律：
   - curl：加 `--noproxy '*'`；
   - node：`env -u https_proxy -u HTTPS_PROXY -u http_proxy -u HTTP_PROXY -u all_proxy -u ALL_PROXY -u NODE_USE_ENV_PROXY node …`；
   - 手机浏览器无此环境，不受影响。用 `openssl s_client` 或清代理后的 curl 验证均正常。
4. **hello 是无准入标记，不承载 V1 的准入半边**：`hello` 按设计「不做任何准入」
   （`static-serve.ts` 头注与 hello 路由实现），它 200 只证明手机入口已挂上。
   准入的正负两支要打**带 `admit` 的端点**：`/threadharbor/mobile/pair-url` 与
   `/threadharbor/mobile/peers`（401 `unauthorized` / 403 `forbidden` 短体，源码
   `pair-url.ts:70-73`、`peers.ts:75-78`）。计划文本「hello 通即准入未拒」按
   as-built 口径修正为上面这条。
5. **cookie 与 authority 绑定**：令牌换出的 cookie 里带签发的 authority
   （127.0.0.1:3091 或 ts.net 名）。拿 A 源签的 cookie 打 B 源是 401——这是官方
   语义，不是失效。机器侧复现 V4 时注意「在哪签就在哪打」。
6. **留下的配置**：探针 home 的 `cordis.patch.yml` 新增 mobileOrigin 覆盖行
   （按 docs/install.zh.md 教的 id 定向写法，`--dump-config` 已核对生效），保留
   不撤——用户手机侧验收直接复用。worktree 的 `scripts/dsh-wrapper.sh`
   （gitignore，机器本地的全局 dsh 启动器，与主 checkout 同文）是本次为让
   dev.sh 走默认启动器而补的，不入库。

## 3. 机器侧验证实录（2026-10-14 05:20–05:45 CST）

### 3.0 前置：构建与装载

- `npm run build` 全绿（tsc -b + freshness 检查 + tsdown 各包 + verify-build）。
  手机静态产物（`packages/dsh-mobile-entry/mobile/`，Task 9 的 app/views/wire）
  均新于其 src，无陈旧装载。
- 探针实例带信任启动：
  `THREADHARBOR_DSH_HOME=~/.dsh-threadharbor-probe THREADHARBOR_WEB_PORT=3091 THREADHARBOR_TRUSTED_HOST=gooddemacbook-pro.tailb6790d.ts.net scripts/dev.sh restart web`。
- `GET http://127.0.0.1:3091/threadharbor/mobile/hello` → `200 {"mobile":true}`。
  **这也是 Task 1–9 全分支在真实宿主上的装载检查**（插件组合、路由登记、静态产物）。

### 3.1 mobileOrigin 配置与 pair-url（V7 依赖的一次性配置）

- 探针 home patch 加行（文档同款）：
  `- id: threadharbor-mobile-entry` / `config: mobileOrigin: https://gooddemacbook-pro.tailb6790d.ts.net`。
- `dsh --profile web --dump-config`（DSH_HOME 指探针）输出该行带 mobileOrigin——装载生效。
- 令牌换 cookie（浏览器引导同路）：`GET /?token=<web.log 启动令牌>` →
  `303 See Other`、`location: ./`、`Set-Cookie: dsh-auth-…; Max-Age=2592000; HttpOnly; SameSite=Strict`
  （**30 天凭据的实数**，与文档口径一致）。
- `GET /threadharbor/mobile/pair-url`（带 cookie）→ `200 {"url":"https://gooddemacbook-pro.tailb6790d.ts.net/threadharbor/mobile/?token=…"}`；
  无 cookie → `401`。

### 3.2 serve 发布（真实脚本、真实外部状态）

- 发布前 `tailscale serve status` → `No serve config`（Task 10 收尾后的状态，无丢失）。
- 运行 `scripts/mobile-setup.sh 3091` → 真实发布成功：
  `https://gooddemacbook-pro.tailb6790d.ts.net/ → proxy http://127.0.0.1:3091`（tailnet only）。
  首次发布触发了本机 ts.net 名的 Let's Encrypt 证书签发（约 1–2 分钟内完成，
  期间连接被断开——复跑者若立刻 curl 失败，等一会儿再试，见 §3.3 证书链）。

### 3.3 V1：发布域名上的准入正负两支

- **证书（V5 机器半）**：`openssl s_client` 实测链
  `ISRG Root X2 → ISRG Root YE → Let's Encrypt YE1 → CN=gooddemacbook-pro.tailb6790d.ts.net`；
  curl `ssl_verify_result=0`。证书由 tailscaled 自动签发与续期。
- **正支（Host 保留 → 名单放行）**：
  - `curl --noproxy '*' https://gooddemacbook-pro.tailb6790d.ts.net/threadharbor/mobile/hello` → `200 {"mobile":true}`；
  - 带 cookie 打 `pair-url` → `200`（tokenized URL，host 为发布域名）；
  - 带 cookie 打 `peers` → `200`，返回实时 tailnet 清单（7 peers，含 xiaomi-15 离线条目）。
- **负支（不在名单 → 403 引导分支）**：同一实例去掉 `THREADHARBOR_TRUSTED_HOST`
  重启（进程参数核实只有 `--profile web --port 3091`），发布域名上：
  - `pair-url`（带 cookie）→ `403 'forbidden'`；
  - `peers`（带 cookie）→ `403 'forbidden'`——即手机页「这台机器没配好信任主机」
    引导的来源分支。随即带 `THREADHARBOR_TRUSTED_HOST` 重启，两端点恢复 `200`。
- （说明：hello 在无信任重启时仍 200，原因见 §2 第 4 条，不构成矛盾。）

### 3.4 V2：发布域名上的 mux 升级

node 脚本（Node 24 全局 WebSocket + headers 选项，清代理环境；帧形与 Task 6
探针一致）打 `wss://gooddemacbook-pro.tailb6790d.ts.net/api/remote.mux`：

```
uplink   {"type":"open","streamId":"ee43ca32-…","endpoint":"$events","payload":{"args":{}}}
downlink {"type":"item","streamId":"ee43ca32-…","value":{"type":"ready","clientId":"c80ad77a-896f-40b4-aafa-cee90c5515ad","host":{"home":"/Users/good"}}}
```

升级、`$events` 订阅、ready 首帧全部成功——**serve 转发 WebSocket 升级成立**。
对照基线：同脚本打 `ws://127.0.0.1:3091`（loopback cookie）同样通过
（clientId `1faaf874-…`），排除脚本本身因素。

### 3.5 V4：DSH 重启后 cookie 仍有效（机器侧半程）

两个方向都实测（重启均为 `scripts/dev.sh restart web`，同 home 同端口）：

- **loopback 源**：`/?token=…` 换 cookie → 重启 → `peers` 带 cookie 重放 → `200`。
- **发布域名源（手机同形）**：ts.net 源签发的 cookie，跨**两次**重启后在发布域名上
  `peers` → `200`，且用同一 cookie 在发布域名上再开 mux → 新 ready 帧
  （clientId `9ce07631-…`）。签名密钥随 home 持久化，在本 home 上成立。
- 附带证据：Set-Cookie 的 `Max-Age=2592000`（30 天）与 `Expires` 实测在响应头里（§3.1）。

### 3.6 V7：授权封装的机器侧半程

按手机扫码后的真实交换路径在发布域名上实测：

1. 带 cookie `GET /threadharbor/mobile/pair-url` → `200` + tokenized URL（mobileOrigin 拼接）；
2. `GET <tokenized url>` → `303 See Other`、`location: ./`、`Set-Cookie: dsh-auth-…`（新的 30 天 cookie）；
3. `GET /threadharbor/mobile/`（带新 cookie）→ `200 text/html`，手机页应用壳
   （index.html，916 字节，正常出壳）。

即「带令牌手机根网址 → 303 换 cookie → 落回手机页 → cookie 生效」的每一拍都在
真实发布域名上走通。剩「用手机扫桌面二维码」这一拍见 §4。

## 4. 用户手机侧清单（全部 待用户执行）

前提：手机已装 Tailscale 并登录同一 tailnet（清单里那台 xiaomi-15 就是预留位）。
以下命令都在 worktree 目录 `/Users/good/github/threadharbor/.worktrees/mobile-entry` 下执行；
域名按 `tailscale status --json` 的 Self.DNSName 现读（当前为
`gooddemacbook-pro.tailb6790d.ts.net`）。

1. 【待用户执行】把探针实例和发布带起来（两条命令）：

   ```
   THREADHARBOR_DSH_HOME=~/.dsh-threadharbor-probe THREADHARBOR_WEB_PORT=3091 THREADHARBOR_TRUSTED_HOST=gooddemacbook-pro.tailb6790d.ts.net scripts/dev.sh start web
   scripts/mobile-setup.sh 3091
   ```

   （任务收尾时 serve 已关、探针已停，见 §7；这两条就是「重新带起来」的全部。）

2. 【待用户执行】V5：手机浏览器开
   `https://gooddemacbook-pro.tailb6790d.ts.net/threadharbor/mobile/`。
   预期：安卓 Chrome 直接信任（Let's Encrypt，机器侧已验证书链，§3.3）；不应出现证书告警。

3. 【待用户执行】未配对引导文案：手机**先不扫码**直接开手机页时，页内调 admitted
   端点得 401 后应出现配对引导屏——「还没配对 / 这台页面没有本机 DSH 的访问凭据，
   或者凭据已经失效（HTTP 401）」，指向桌面端「手机配对」面板（views.js 两支引导之一）。
   看到即通过。

4. 【待用户执行】V7 真机半程（扫码）：
   桌面浏览器开 `http://127.0.0.1:3091/?token=<web.log 里 dsh web: 行的 token>`
   进桌面端，侧栏打开「手机配对」面板，手机扫二维码。预期：手机 303 落回手机页
   （机器侧已验交换本身，§3.6），此后手机页不再出引导屏。

5. 【待用户执行】主机清单：手机页顶部应列出 tailnet peers（含本机在线、xiaomi-15 等，
   与 §3.3 的 200 应答同源数据）；对端离线项置灰。

6. 【待用户执行】会话浏览 + 「加载更早」：选一个会话进入，翻历史；超出首批时页内出
   「加载更早」按钮，点按应补亮更早记录（app.js 客户端分页）。

7. 【待用户执行】发消息：输入框发送一条文本；预期入队成功（`session/prompt`，
   queue 模式），会话流里出现 user/message。

8. 【待用户执行】批权限横幅（两种情形，对照 Task 6 双连接派发结论）：
   - 桌面同时在线：发起一个会触发工具审批的回合，预期**桌面与手机同时**弹出审批
     横幅（「待批准：工具 …」+ 批准/拒绝）；任意一端先答即生效，另一端横幅自动
     收起（`cancel{eventId}`）。这是 Task 6 钉死的「广播 + 首答生效」派发
     （ref `packages/api/gateway/src/index.ts:602、608-612` 广播与补收、
     `:614-633` 首答生效、`:646-668` 迟到应答幂等）。
   - 桌面离线（桌面标签页关掉）：手机单端应答，回合应继续。
   - 注意：若该会话的后端在自身侧做工具闸（不产生宿主审批 waterfall），横幅不会
     出现——这是 preset/后端层的事，不是手机端缺陷（Task 6 concern 3 已记录），
     换 DSH 原生会话再试并记录现象即可。

9. 【待用户执行】停止按钮：会话进行中点停止，预期回合中止（`session/cancel`）。

10. 【待用户执行】V4 手机侧确认：手机正常使用中，在 Mac 上执行
    `THREADHARBOR_DSH_HOME=~/.dsh-threadharbor-probe THREADHARBOR_WEB_PORT=3091 THREADHARBOR_TRUSTED_HOST=gooddemacbook-pro.tailb6790d.ts.net scripts/dev.sh restart web`，
    完成后手机**直接刷新**——预期仍可用、不再出引导屏（机器侧已证 cookie 跨重启有效，§3.5）。

11. 【待用户执行】30 天凭据说明核对：配对后 cookie 有效期 30 天（机器侧实测
    `Max-Age=2592000`），跨 DSH 重启有效；换手机、过期、清 cookie 后重新扫码即可。

12. 【待用户执行·收尾可选项】若不留常驻手机通道：
    `tailscale serve --https=443 off`，再 `THREADHARBOR_DSH_HOME=… THREADHARBOR_WEB_PORT=3091 scripts/dev.sh stop web`。

## 5. V3（整机重启）——待用户补验

约定时间重启 Mac 后，按序执行（都在 worktree 目录）：

```
tailscale serve status        # 预期仍列出 443 → proxy http://127.0.0.1:3091（tailscaled 持久化）
tailscale status --json | jq -r .Self.DNSName   # 域名应仍是 gooddemacbook-pro.tailb6790d.ts.net
```

若 serve 已空（预期不会）：`scripts/mobile-setup.sh 3091` 重发一次即可（文档既有口径）。
然后带起实例（§4 第 1 步两条命令），手机刷新验证。任何一步不过，按 spec §8 把
「重跑一条命令」写进文档即为退路定案，不推翻方案 A。

## 6. R9：真实审批回路——待用户执行（既有证据先立此存照）

探针 home 无模型凭据，无法在本任务开真实审批轮；回路折入用户清单（用户的会话、
用户的 key，§4 第 8 步）。既有证据链：

- **源码钉死（Task 6）**：waterfall 事件广播送达 + 首答生效 + 其余收
  `cancel{eventId}` + 挂起期新连接先补收 + 迟到应答幂等——
  ref `packages/api/gateway/src/index.ts:602、608-612、614-633、646-668、:513`；
  应答走 HTTP `POST /api/$events/result`（`{args:{clientId,eventId,outcome}}`）。
- **单测覆盖（Task 7/8）**：`tests/app.spec.ts` 覆盖手机端批准/拒绝→`$events/result`
  应答路径与横幅禁用态；`tests/wire.spec.ts` 钉死帧形与端点常量。
- **已知边界（Task 6 concern 3）**：acp 后端在自身侧做工具闸时不产生宿主
  waterfall——用户清单第 8 步如遇横幅不出，先换 DSH 原生会话，并把现象记录回来。

## 7. tailscale serve 副作用说明（机器已还原）

- 本任务运行 `scripts/mobile-setup.sh 3091` 发布过 443→3091（发布前状态
  `No serve config`，未覆盖任何既有映射），验证完成后已执行
  `tailscale serve --https=443 off`，`tailscale serve status` 复核为
  `No serve config`——**机器侧不残留发布**。用户做手机侧验收时按 §4 第 1 步重新发布。
- 副作用两笔，均为正常且保留：其一，本机 ts.net 名的 Let's Encrypt 证书已在
  tailscaled 侧签发并缓存（首次发布触发，之后复用续期）；其二，探针 home 的
  mobileOrigin 配置行保留（§2 第 6 条），下次发布即配齐。
- 探针实例已停（`scripts/dev.sh stop web`），3091 已释放；3081 常驻实例全程未动。
