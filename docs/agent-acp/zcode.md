# zcode：GLM 模型插件

zcode 在模型列表里是单独的一组，名字是 ZCode。选 GLM-5.3、GLM-5.3-Flash 或 GLM-5.2 就是选它。

它不拉起 ZCode 的进程，也不走 ACP。本机桌面版登录后，密钥在 `~/.zcode/v2/credentials.json`。插件解开这把密钥（只放内存，不写日志），按 Coding Plan 的地址把对话发给 GLM：

- 国内：`https://open.bigmodel.cn/api/anthropic/v1/messages`
- 国际站：把 `ZCODE_GLM_BASE_URL` 设成 `https://api.z.ai/api/anthropic`

请求带 `x-api-key` 和 `Authorization: Bearer`。思考块上的签名会存进回复，下一轮原样带回去，否则后面的回合会被拒。

流式文字和工具调用交回 DSH。读文件、跑命令、审批、取消、会话记录都是 DSH 现成的循环，不经过 ZCode 自己的工具。

默认思考档是 high。选 none 会关掉思考。

桌面版要先登录。没登录时，这一组模型发消息会直接失败，并说明找不到密钥。
