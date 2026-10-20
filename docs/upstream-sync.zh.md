# 上游同步说明：zcode（GLM）与 minimaxi（MiniMax）

> 核对时间：2026-10-20。本文里的事实都带核对时间；核对之后上游变了，以本文为准去排查，再回来更新本文。
>
> 配套的**做法**写在仓库守则 [AGENTS.md](../AGENTS.md)（「zcode / minimaxi 出异常时的排查顺序」）：先读本文定位依赖点，再拉上游最新代码对比，然后才动手改。

## 这份文档解决什么问题

zcode 与 minimaxi 这两组模型不是我们自己的实现，它们贴着两个外部产品走：

- **zcode** 贴着 **ZCode / GLM Coding Plan** 走——凭据格式、接口地址、套餐额度口径都来自 ZCode 那边。
- **minimaxi** 贴着 **MiniMax Code** 走——登录模块是官方源码**搬运**进来的，模型目录和网关地址也是从官方搬的事实。

上游一更新（换了凭据格式、换了模型 id、改了网关地址、加了新模型、下线了旧模型），我们这边就会出问题：发消息 401、模型不见了、思考关不掉、配额胶囊不出现。

**本文的作用**：把「我们依赖上游的哪些点、每个点上游变了会怎样、上游更新了怎么判断要不要跟、跟了怎么验」写清楚，让下次有人遇到上游更新时不用从零逆向。

配套阅读：单看功能用法看 [agent-acp/zcode.md](agent-acp/zcode.md) 与 [agent-acp/minimaxi.md](agent-acp/minimaxi.md)；搬运来源与同步办法看 [packages/minimaxi-acp/src/vendor/mcode-oauth/PROVENANCE.md](../packages/minimaxi-acp/src/vendor/mcode-oauth/PROVENANCE.md) 与 [packages/minimaxi-acp/src/vendor/mcode-runtime/PROVENANCE.md](../packages/minimaxi-acp/src/vendor/mcode-runtime/PROVENANCE.md)。

---

## 一、我们改造后的样子

两组都是**模型插件**：它们不拉起任何外部进程，也不走 ACP。DSH 自己的循环负责读文件、跑命令、审批、取消、写会话记录；插件只负责一件事——**把这一轮问答发给模型，把文字和工具调用交回循环**。

| | zcode（GLM） | minimaxi（MiniMax） |
| --- | --- | --- |
| 用户要先装什么 | ZCode 桌面版，登录过 | MiniMax Code（或命令行版 `mcode`），登录过 |
| 身份从哪来 | 解密本机 ZCode 登录凭据 | 读本机 MiniMax Code 登录（官方那套实现，含刷新） |
| 请求发到哪 | GLM Coding Plan 的 anthropic 兼容接口 | MiniMax 托管网关（`agent.minimax.cn` / `.io`） |
| 模型清单哪来 | 写在 preset 配置里（GLM-5.3 / 5.3-Flash / 5.2） | 从官方搬来的目录，默认挂 M3.1 Flash 与 MiniMax M3 |
| 额外界面 | 输入框下方两枚 5 小时/周配额胶囊 | 无 |
| 我们和上游的关系 | **按公开实现对齐事实**，没有搬代码 | **搬运源码**（登录模块）+ 搬事实（模型目录、网关地址） |

### 为什么是这条路（历史沿革）

| 时间 | 做法 | 为什么改 |
| --- | --- | --- |
| 2026-10-13 | zcode 做成 ACP 适配器，对接 ZCode 桌面版的 app-server 私有协议 | 能跑通，但依赖的是桌面版内部协议，桌面版一改就断 |
| 2026-10-14 | zcode 改成直连 GLM 的模型插件 | 官方有 anthropic 兼容的公开接口，认桌面版登录密钥就能用；不再依赖私有协议 |
| 2026-10-20 | minimaxi 落地，同一套模型插件的路子 | 与 zcode 同构；凭据直接复用官方实现，避免两边互相踢掉登录 |

结论：**这两组模型现在对上游的依赖面很窄**——只剩「凭据怎么读」「请求怎么发」「模型有哪些」「额度怎么问」这四类事实。分析上游更新时，先确认更新的是不是这四类之一。

---

## 二、上游是谁，我们拿了什么

| 上游 | 仓库 | 许可 | 我们拿法 | 本次核对的上游版本 |
| --- | --- | --- | --- | --- |
| ZCode / GLM | <https://github.com/zai-org/ZCode> | Apache-2.0 | 不搬代码，按其公开实现对齐事实 | main HEAD `0a1fc56`（2026-10-19） |
| MiniMax Code | <https://github.com/MiniMax-AI/minimax-code> | MIT | 搬 `packages/oauth-core/src`（登录模块）＋ `packages/config/src`（模型目录、网关地址） | main HEAD `5821f7c`（2026-10-20） |

> **一个已经出现的变化**：`mcode-oauth/PROVENANCE.md` 里记的 2026-10-20 核对值是 `c21e88ef…`（当时记的是 tree SHA），现在 main 的提交是 `5821f7c…`。两者对不上，说明**上游在我们搬过去之后又有提交**。本文的「依赖点清单」就是拿来判断那次改动要不要跟的。
>
> 2026-10-20 逐行比对的结果：搬运过来的登录模块与上游当前版本**只有两类机械改写**（导入后缀、构造函数参数属性），**没有逻辑差异**；上游 `oauth-core` 的文件清单与我们搬的 14 个文件一致（上游另有 README、package.json 和一个测试辅助文件，我们没搬）。所以那次提交动的是别处——真正要盯的仍是下面第三节那几行。

上游涉及我们关注的部分，位置如下（文件路径相对仓库根）：

| 上游 | 路径 | 管什么 |
| --- | --- | --- |
| ZCode | `apps/zcode-cli/packages/adapters/src/auth/credential-cipher.ts` | 凭据加密格式 `enc:v1`、密钥怎么推 |
| ZCode | `apps/zcode-cli/packages/adapters/src/auth/shared-credentials.ts` | 凭据文件放哪、里面有哪些键 |
| ZCode | `apps/zcode-cli/packages/adapters/src/auth/coding-plan-api-key.ts` | 官方自己的换证流程（OAuth → 项目令牌） |
| ZCode | `apps/zcode-cli/packages/adapters/src/model/official-coding-plan-gateway.ts` | 官方打网关时的路径改写 |
| ZCode | `packages/shared/src/provider-provisioning.ts` | `account-provider:…:api-key` 这类历史凭据键的校验 |
| ZCode | `packages/shared/src/usage-quota.ts` | 套餐额度的字段口径 |
| MiniMax | `packages/oauth-core/src/**` | 登录、刷新、跨进程锁（**我们整段搬了**） |
| MiniMax | `packages/config/src/config.ts` | 托管网关地址表 |
| MiniMax | `packages/config/src/minimax-model-catalog.ts` | 模型目录（**我们搬了**） |

---

## 三、依赖点清单（判断影响面的主表）

每一行是「我们依赖上游的一件事」。**上游更新时，先在这张表上逐行过一遍**：哪一行变了，才需要动对应代码。

### A. minimaxi（搬运型）

| # | 依赖点 | 上游出处 | 我们这边落在哪 | 上游变了会怎样 | 怎么发现 |
| --- | --- | --- | --- | --- | --- |
| A1 | 凭据落盘位置：`<数据目录>/auth/<buildEnv>/<region>/mcode-public/auth.json`（同目录另有 `auth-state.json`、`auth.lock`） | `oauth-core/src/credential-store/file-store.ts`、`namespace.ts` | `packages/minimaxi-acp/src/credential.ts` 的目录定位与命名空间探测 | 找不到登录 → 直接报「没登录，去 MiniMax Code 登录」 | 插件报 `no MiniMax Code login under …` |
| A2 | 数据目录顺序：`MINIMAX_DATA_DIR` → `MAVIS_DATA_DIR` → `~/.minimax` → `~/.mavis` | `oauth-core/src/namespace.ts` | 同上（`resolveDataDir`） | 读错目录 → 以为没登录 | 同上 |
| A3 | 刷新逻辑与跨进程锁：谁先刷新谁写文件，两边共用同一把锁 | `oauth-core/src/cross-process-lock.ts`、`oauth-client.ts`、`state-store.ts` | 整段搬进 `packages/minimaxi-acp/src/vendor/mcode-oauth/` | 搬来的代码与上游脱节 → 刷新失败或互相踢掉登录 | 真机测试「过期后经官方端点刷新成功」 |
| A4 | 刷新端点配置（按区域/环境取刷新地址） | `oauth-core/src/endpoint-config.ts` | 同上（`vendor/mcode-oauth`） | 刷新 404/401 | 刷新时报错 |
| A5 | 托管网关地址表（`agent.minimax.cn` / `.io` 的 `/mavis/api/v1/llm/v1`） | `packages/config/src/config.ts` | `vendor/mcode-runtime/endpoints.ts` | 请求 404 或连错区 | 404 / 稳定 401 |
| A6 | 区域判定：凭据目录里的 `cn` / `en` 决定网关 | `oauth-core/src/namespace.ts` | `packages/minimaxi-acp/src/credential.ts`（`detectNamespace`） | 国内号配国际网关 → 稳定 401 | 401 且换网关就好 |
| A7 | 模型目录：模型 id、上下文/输出上限、思考能力（能否关思考）、档位表 | `packages/config/src/minimax-model-catalog.ts` | `vendor/mcode-runtime/model-catalog.ts` | 模型 id 变了 → 模型发不出去；`thinking_config.mode` 变了 → 关思考行为变了 | 模型 id 报无效；关思考报 2013 |
| A8 | anthropic 消息协议本身（`thinking`/`output_config.effort`、思考签名、工具块） | anthropic 兼容接口 | `packages/minimaxi-acp/src/anthropic.ts`、`sse.ts`；重放时的工具配对在 `packages/dsh-preset-dispatch/src/tool-pairing.ts` | 协议字段改名 → 请求被拒 | 网关返回参数错误 |

### B. zcode（对齐型）

| # | 依赖点 | 上游出处 | 我们这边落在哪 | 上游变了会怎样 | 怎么发现 |
| --- | --- | --- | --- | --- | --- |
| B1 | 凭据文件位置：`~/.zcode/v2/credentials.json` | `apps/zcode-cli/packages/adapters/src/auth/shared-credentials.ts`（官方为 `${ZCODE_DATA_BASE_DIR ?? homedir()}/.zcode/v2/credentials.json`） | `packages/zcode-acp/src/credential.ts`（可用 `ZCODE_ACP_CREDENTIALS_FILE` 覆盖） | 读不到 → 报「找不到密钥」 | `cannot read ZCode credentials at …` |
| B2 | 加密格式 `enc:v1:<iv>.<tag>.<ct>`，AES-256-GCM，密钥 = sha256(`zcode-credential-fallback:<platform>:<homedir>:<username>`) | `apps/zcode-cli/packages/adapters/src/auth/credential-cipher.ts` | 同上（`deriveKey` / `decryptCredential`） | 解不开 → GCM 校验失败 | `credential is not enc:v1:…` 或 GCM 报错 |
| B3 | 凭据键名：`account-provider:coding-plan:…:api-key` | `packages/shared/src/provider-provisioning.ts` | 同上（`loadApiKey`） | 键名变了 → 找不到 coding-plan 密钥 | `no coding-plan api key in ZCode credentials` |
| B4 | 用户名取法：必须来自 passwd 条目（`os.userInfo()`），macOS 上环境变量可能对不上 | 同 B2 | 同上 | 用户名取错 → GCM 标签校验失败 | 解密报 key mismatch |
| B5 | 请求地址：`<base>/v1/messages`，国内 `https://open.bigmodel.cn/api/anthropic`，国际 `https://api.z.ai/api/anthropic` | 官方模板 + `official-coding-plan-gateway.ts` | `packages/zcode-acp/src/anthropic.ts`、`glm.ts` | 地址或路径变了 → 404 / 401 | 404；官方若把路径改写成 `/api/v1/ultra/…`（见第六节 D3）则 404 |
| B6 | 鉴权头：`x-api-key` 与 `Authorization: Bearer` 同时带 | 官方适配器 | `packages/zcode-acp/src/glm.ts` | 缺一个头 → 401 | 401 |
| B7 | 思考字段：`thinking` 为 `disabled` 或 `adaptive`；档位走 `output_config.effort`（low / high / max） | 官方 anthropic 适配与推理档映射 | `packages/zcode-acp/src/anthropic.ts`（`reasoningFields`） | 字段改名 → 请求被拒 | 400 类参数错误 |
| B8 | 思考签名必须原样回传（缺了下一轮被拒） | 官方 anthropic 推理元数据处理 | `anthropic.ts`（读 `replayState.blocks`）+ `sse.ts`（收集 `signature_delta`） | 签名规则变了 → 第二轮被拒 | 第一轮好、第二轮报错 |
| B9 | 套餐额度接口 `<origin>/api/monitor/usage/quota/limit` 与字段口径（`type`/`unit`/`number`/`usage`/`currentValue`/`percentage`/`nextResetTime`/`level`） | `packages/shared/src/usage-quota.ts`（口径一致；接口路径来自桌面版实测） | `packages/zcode-acp/src/quota.ts` | 形状变了 → 胶囊不出现或显示错 | 胶囊整行隐藏 |
| B10 | 模型 id：GLM-5.3 / GLM-5.3-Flash / GLM-5.2 | 官方在售模型 | `cordis.patch.yml` 的 `acp-zcode` 行 | id 变了 → 模型发不出去 | 模型报无效 |
| B11 | 工具调用 id 严格校验（结果必须用真实 id 回填） | 网关行为 | DSH 循环回填 | id 对不上 → 2013 类参数错误 | `tool result's tool id not found` |

---

## 四、运行时流程

### 1. 一轮问答怎么走

1. 用户在 DSH Web 里选了「ZCode」或「MiniMax」组里的某个模型，发出消息。
2. DSH 原生循环准备好这一轮：系统提示、历史消息、工具清单、推理档、取消信号。
3. 循环向 dispatch 要「这一轮的模型回答」。dispatch 手里有一组**模型插件**（zcode、minimaxi）；插件按 preset 行的 `agent` 字段认领——认领不上就说明这一行没人管（会落到网关路径，表现为「模型不生效」）。
4. 认领上的插件去取凭据：
   - zcode：读 `~/.zcode/v2/credentials.json`，挑出 coding-plan 的 api-key，在内存里解密（AES-256-GCM）；**不落盘、不进日志**。
   - minimaxi：按官方那套定位数据目录与命名空间，拿到一个可用访问令牌；过期就由官方那段代码在同一把跨进程锁内刷新，并写回同一个 `auth.json`。
5. 插件把请求体组装成 anthropic 消息格式（`messages` / `tools` / `thinking` / `output_config.effort`），POST 到对应网关。
6. 流式回来是 SSE 事件；插件把它翻译成 DSH 循环认识的块：文字、思考、工具调用、用量。
7. 循环执行工具（读文件、跑命令），要审批就弹审批；工具结果按**真实的工具 id** 回填。
8. 下一轮请求把上一轮 assistant 的内容整块带回——**思考签名一个字符都不能改**，否则网关拒。多轮工具调用能不能成立，全看这一条。

### 2. 凭据读取与刷新（两条路不一样）

| | zcode | minimaxi |
| --- | --- | --- |
| 凭据来源 | 桌面版登录后落在本机的加密文件 | MiniMax Code 登录后落在数据目录的 `auth.json`（明文，目录 0700 / 文件 0600） |
| 过期了怎么办 | 桌面版自己管；我们只读不刷新 | 官方代码在同一把跨进程锁内刷新并写回同一个文件 |
| 为什么这样 | 不去改用户的 ZCode 目录 | 共用同一套凭据，才不会「一边刷新把另一边作废」 |

### 3. GLM 配额胶囊怎么走

1. 浏览器侧只在**当前会话选的模型是 GLM** 时才显示两枚胶囊（5 小时、周），5 分钟一拍轮询，回到页面补一拍。
2. 胶囊数据来自同源接口 `GET /threadharbor/zcode/quota`——宿主侧插件 `threadharbor-zcode-quota` 用**本机解出来的密钥**问一次 Coding Plan 的额度接口，成功应答缓存 30 秒。
3. 密钥不出宿主进程；取不到就把整行藏掉，原因去重后记一条日志。

---

## 五、我们与上游的已知偏差

分两类：**有意为之**（不改）和**待评估**（上游变了可能要跟）。

### 有意为之

| 项 | 上游 | 我们 | 原因 |
| --- | --- | --- | --- |
| MiniMax 目录改名迁移 | 新旧目录名互相迁移 | 只读不搬，老目录在哪儿就读哪儿 | 聊天宿主不该在用户没要求时移动他的目录 |
| zcode 换证流程 | OAuth 令牌换项目令牌（`/api/biz/…`） | 不做换证，直接用存下来的 coding-plan api-key | 简单路径已实测可用；换证是上游的内部编排（若上游宣布停用这类长期 key，见 D4） |
| MiniMax 工具执行 | 官方跑自己的工具 | 工具全部交给 DSH 原生循环 | 这是模型插件路线的定义 |

### 待评估（我们与上游不一致、还没跟的地方）

| # | 项 | 上游现状 | 我们现状 | 风险 | 建议 |
| --- | --- | --- | --- | --- | --- |
| D1 | `ZCODE_CREDENTIAL_SECRET` | 上游优先用这个环境变量当加密密钥，没有才回退到 `zcode-credential-fallback:…` | 只实现了回退串 | 用户若设了这个变量，我们的解密必然失败 | 加一个支持：读得到就用（低成本，兼容性更好） |
| D2 | `ZCODE_DATA_BASE_DIR` | 上游据此决定凭据根目录 | 写死 `~/.zcode/v2/credentials.json` | 用自定义目录的用户会读错文件 | 支持该变量，或至少在读不到时提示 |
| D3 | 网关路径改写 | 官方把 `/api/anthropic/v1/messages` 改写成 `/api/v1/ultra/anthropic/v1/messages`（国内）、`/api/v1/ultra-zai/anthropic/v1/messages`（国际） | 直接打原地址（2026-10-20 实测可用） | 上游哪天收紧只放行改写后的路径，我们会 404 | 观察上游是否把原路径也收掉；真收掉再跟 |
| D4 | 上游换证链 | CLI 已改成 OAuth → 项目令牌，两段 | 用桌面版写下的 api-key | 若服务端废弃这类长期 api-key，我们会 401 | 关注上游是否宣布停用 |
| D5 | MiniMax 上游有新提交 | main HEAD 与我们搬运时记录的提交不同 | 搬运进来的 14 个文件逐行比对**无差异**，所以动的是别处 | 低——但下次上游动到 `oauth-core` 就会有影响 | 按第七节的搬运流程跑一次 diff 即可 |
| D6 | GLM 模型 id | 官方在售模型会变 | 我们在 preset 配置里写死三个 | 新模型要手工加；旧模型下线会报错 | 下线消息出现时改 preset 行 |

> D1–D4 是**核对当日（2026-10-20）就已确认的差异**，不是假设。判断要不要跟之前，先看线上是否真的受影响。

---

## 六、上游有更新时，怎么判断要不要改

### 步骤

1. **先确认是上游的问题还是我们的问题**：拿同一个模型在 ZCode 桌面版 / MiniMax Code 里试。官方那边也不对 → 等上游修；官方那边正常 → 是我们这边脱节了。
2. **拿着现象到第三节的表里定位依赖点**（下面有对照表）。
3. **看这条依赖点属于哪一类**：
   - 搬运型（minimaxi 的 A3、A4、A7）→ 走「覆盖上游 + 施加两类机械改写」，不要手改逻辑。
   - 对齐型（zcode 的 B 类）→ 逐条核对事实，事实变了才改代码。
4. **改完做验证**（第八节），并**更新本文的核对时间与第三节里对应行的版本**。
5. **动过的搬运目录，要同步更新两个 PROVENANCE.md 的版本、提交与日期**。

### 现象对照表（先查什么）

| 现象 | 最可能的依赖点 | 先查这里 |
| --- | --- | --- |
| GLM 发消息 401 / 403 | B1–B6 | 凭据文件还在不在、键名变没变、解密报什么错、请求头齐不齐 |
| GLM 一发就 404 | B5 | 地址对不对；官方是不是把路径改写了（D3） |
| MiniMax 稳定 401 | A6 / A5 | 区域与网关是否配对；凭据是否过期、刷新是否失败 |
| MiniMax 报「没登录」 | A1 / A2 | 数据目录顺序变了没；登录是不是在老目录 |
| 模型列表里 GLM 或 MiniMax 不见了 | B10 / A7 | preset 行还在不在（`cordis.patch.yml`）；模型 id 是不是改了 |
| 选 none 档关不掉思考 | A7 | 目录里的 `thinking_config.mode` 是不是变了 |
| 第二轮被拒（多轮工具调用断） | B8 / A8 | 思考签名有没有原样回传 |
| 工具结果报 2013 / tool id not found | B11 | 工具 id 是否用真实 id 回填 |
| 报 2013「tool call result does not follow tool call」 | 我们自己的重放层（`packages/dsh-preset-dispatch/src/tool-pairing.ts`） | 历史里的工具调用与结果是否配对：补救写在日志末尾的结果有没有搬回调用旁 |
| 配额胶囊不出现 | B9 | 额度接口形状、host 插件路由 |
| 挂上模型但不注册（模型行在、列表空） | A7 / B10 | 模型 id 与目录、preset 行是否匹配 |

---

## 七、同步操作手册

### 7.1 minimaxi（搬运型）

搬运目录：`packages/minimaxi-acp/src/vendor/mcode-oauth/`（登录模块）与 `vendor/mcode-runtime/`（模型目录、网关地址）。

```sh
# 取上游（只拉一次，够比对即可）
git clone --depth 1 --filter=blob:none --no-checkout https://github.com/MiniMax-AI/minimax-code /tmp/minimax-code
cd /tmp/minimax-code && git sparse-checkout set packages/oauth-core/src packages/config/src && git checkout main
```

1. 对照上游 `packages/oauth-core/package.json` 的 `version`，与 `vendor/mcode-oauth/PROVENANCE.md` 里记的比。
2. 有更新就把上游 `packages/oauth-core/src/` **覆盖回来**——不要顺手改，本目录的价值就在于和上游一样。
3. 施加两类机械改写（只动语法形式，逻辑一行不改）：

   | 上游写法 | 本目录改写为 | 不改的后果 |
   | --- | --- | --- |
   | `from './namespace.js'` | `from './namespace.ts'` | `ERR_MODULE_NOT_FOUND` |
   | `constructor(private readonly x: T)` | 显式字段声明 + 构造函数体内赋值 | `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` |

   原因是本仓库跑 TypeScript 源码，宿主用 Node 原生类型剥离加载插件，既不转换也不允许在 `node_modules` 里剥离。这两类改写无法可靠地自动施加（参数属性改写会连带影响后续下标），按上表人工施加并逐文件比对。**diff 里出现第三类改动就是错的。**
4. `vendor/mcode-runtime/`：覆盖上游 `packages/config/src/config.ts` 与 `minimax-model-catalog.ts`，保留已有的类型就地声明改动。
5. 跑本包测试；再按第八节做一次真机活测。
6. 更新两个 `PROVENANCE.md` 的版本、上游提交与日期。

### 7.2 zcode（对齐型）

zcode 没有搬运源码，所以「同步」是核对清单，不是覆盖：

```sh
git clone --depth 1 --filter=blob:none --no-checkout https://github.com/zai-org/ZCode /tmp/zcode
cd /tmp/zcode && git sparse-checkout set apps/zcode-cli/packages/adapters packages/shared && git checkout main
```

1. 拉上游 ZCode 仓库，按第二节的路径表逐个看有没有变化。
2. 重点核对四类事实：**凭据位置与加密**（B1–B4）、**请求地址与路径**（B5）、**请求体字段**（B6–B8）、**额度口径**（B9）。
3. 模型 id 变了 → 改 `cordis.patch.yml` 里 `acp-zcode` 行的 `models`。
4. 事实没变但官方新增了能力（如新的推理档、新的模型）→ 评估是否值得跟，跟的话在本仓库对应包里改，并在这份文档的偏差表里记一笔。
5. 改完跑第八节的验证。

---

## 八、验证与验收

```sh
# 类型与单测（含 wiring 检查：从宿主加载入口走不到的模块会直接失败）
npm run typecheck
npm run test
```

单测覆盖的重点（改动后先看这些过没过）：

| 包 | 覆盖什么 |
| --- | --- |
| `packages/zcode-acp/tests/` | 请求体构造与推理档映射、思考签名回放、地址拼接、额度解析 |
| `packages/minimaxi-acp/tests/` | 凭据定位与区域判定、过期后经官方端点刷新、刷新结果留在同一个文件、请求地址与鉴权头、思考开关与档位、签名回放、失败信息里令牌被抹掉 |

真机活测（会驱动真实模型，一轮几十秒；需要本机已登录 ZCode 桌面版与 MiniMax Code）：

1. **GLM**：建会话 → 提问 → 收到回答 → 工具调用被正确投影 → 批准权限后回合继续 → 输入框下方出现两枚配额胶囊。
2. **MiniMax**：先确认登录过期能被刷新成功 → 第一轮发思考并调用工具 → **第二轮把思考签名原样回传、工具结果按真实 id 喂回，网关接受并给出正确答案**（这条最险，是签名回放是否成立的判据）→ 选 `MiniMax-M3` 关掉思考能直连回答。

已验收记录：

| 时间 | 结论 |
| --- | --- |
| 2026-10-16 | GLM 套餐限额显示上线（胶囊、悬停、配色、只在 GLM 模型下出现） |
| 2026-10-20 | MiniMax 国内站真机跑通：过期 154 小时的登录刷新成功；两轮含工具调用的多轮成立（签名原样回传被接受）；M3 关思考直连正常 |
| 2026-10-20 | 工具配对的重放修复真机通过：同一段漂移的历史，修复前被 MiniMax 拒（2013），修复后 200 并正常作答 |

---

## 九、维护规则

- **事实写进本文，规则写进 AGENTS.md。** 本文记录的是「上游现在长什么样」，会过期，所以每条事实都要带核对时间；判断该不该跟的做法属于规则，写在本文第七节即可，不要搬进全局守则。
- 每次同步上游后：**更新本文的核对时间**、**更新第三节里受影响行的版本标注**、**更新搬运目录的 PROVENANCE.md**、**在第八节补一条验收记录**。
- 上游更新但我们决定不跟时：在第五节的偏差表里加一行，写清「上游是什么、我们是什么、为什么可以不跟」——下次有人问起来就有据可依，不用重新查一遍。
