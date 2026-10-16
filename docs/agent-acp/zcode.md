# zcode：GLM 模型插件

zcode 在模型列表里是单独的一组，名字是 ZCode。选 GLM-5.3、GLM-5.3-Flash 或 GLM-5.2 就是选它。

它不拉起 ZCode 的进程，也不走 ACP。本机桌面版登录后，密钥在 `~/.zcode/v2/credentials.json`。插件解开这把密钥（只放内存，不写日志），按 Coding Plan 的地址把对话发给 GLM：

- 国内：`https://open.bigmodel.cn/api/anthropic/v1/messages`
- 国际站：把 `ZCODE_GLM_BASE_URL` 设成 `https://api.z.ai/api/anthropic`

请求带 `x-api-key` 和 `Authorization: Bearer`。思考块上的签名会存进回复，下一轮原样带回去，否则后面的回合会被拒。

流式文字和工具调用交回 DSH。读文件、跑命令、审批、取消、会话记录都是 DSH 现成的循环，不经过 ZCode 自己的工具。

默认思考档是 high。选 none 会关掉思考。

桌面版要先登录。没登录时，这一组模型发消息会直接失败，并说明找不到密钥。

## 套餐限额显示（核对时间 2026-10-16）

桌面版能看到的 5 小时/周限额，插件也能拿到：同一个 Coding Plan 账号在
`{origin}/api/monitor/usage/quota/limit` 上报两个窗口的已用、总量、百分比和重置时刻
（国内站 origin 是 `open.bigmodel.cn`，国际站跟随 `ZCODE_GLM_BASE_URL` 的源）。应答里
`unit=3, number=5` 是 5 小时滚动窗口，`unit=6, number=1` 是周窗口；另有 `level` 是套餐
档位（如 max）。

宿主侧多了一个顶层插件行（`threadharbor-zcode-quota`），把这份限额转发在同源接口
`GET /threadharbor/zcode/quota` 上：准入与官方 `/api` 同一面，密钥只在宿主进程内解密，
成功应答带 30 秒缓存（多标签页轮询不打爆上游），失败折成 `ok:false` 加原因。

浏览器侧在输入框下方的 dock（token 用量那一排）追加两枚胶囊——「5小时 n%」「周 n%」，
悬停显示已用/总量和重置时刻，过半变黄、过八成变红。只在当前会话选的模型是 GLM 时
出现；5 分钟一拍轮询加回到页面时补一拍；取不到配额整行隐藏，原因去重后写一条日志。

