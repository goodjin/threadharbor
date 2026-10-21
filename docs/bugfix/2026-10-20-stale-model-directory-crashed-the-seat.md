# 2026-10-20 · 旧的服务实例被处置后崩掉座位条目：输入框的模型入口整个消失

## 问题描述

桌面版重启后，输入框上的模型入口**整个不见了**（连模型都看不到），控制台里一片红：

```
Error: cannot get required service "remote.session" in inactive context
    at Proxy.directoryFor (client.js:1034)
    at Proxy.l (acp-visibility-filter.js:193)
    ...
client.js:638 slot entry crashed in 'conversation.input.model': …
client.js:638 slot entry crashed in 'conversation.composer.dock': …
```

## 现场证据

- 崩的是**我们插件的两个组件**：`acp-visibility-filter`（它包了一层 `directoryFor`）
  和 `zcode-quota`（输入框下面的配额胶囊）。
- 触发时机是客户端插件的 **reconcile**（连接重建后的重新挂载）：那一刻旧的服务
  实例已经被处置，它所属的上下文已失效，原方法一调就抛「inactive context」。
- 异常顺着调用方冒上去，崩的是**座位条目**：
  - 官方那个模型座位（`conversation.input.model`）的 inject 调 `directoryFor`，
    崩 → **输入框的模型入口整个消失**；
  - 我们的 dock（`conversation.composer.dock`）同样崩。
- 页面是「客户端插件重挂载」后才出的问题：全新加载时没有上一代服务可打，
  探针实测全新加载控制台干净、模型入口在。

## 根因分析

两处都是**一次性抓服务**：

- 配额胶囊在入口挂载时 `ctx.get('modelDirectories')` 抓一次就一直用。服务随连接
  重建被替换后，这个引用是死的。
- 可见性过滤器的包装直接 `original.apply(service, args)`，**不设防**：原方法一抛，
  异常就顺着官方座位的 inject 上去，座位条目跟着崩。

两处的共同点：把「服务是活的」当成了永久前提。

## 修复方案

- 配额胶囊改为**经 `ctx.inject(['modelDirectories','sessions'], …)` 绑**：服务被替换
  时 inject 重跑回调，胶囊始终绑着当下那一个（没有 inject 的宿主退回一次性绑定）。
- 可见性过滤器的包装**兜住原方法的失败**：捕获后给一个「什么都不答」的目录
  （store/load/select 形状齐全、快照为空），座位照常渲染（目录空 → 触发按钮退回
  占位文案、选择器列出全部 provider），并说清原因一次。
- 配额胶囊取目录那一步也加了同样的兜底：取不到就当没有目录，胶囊不画。

## 验证步骤

- 新增两条用例：过滤器遇到「服务已没了」不抛异常、给出可用的目录并报一次原因；
  胶囊遇到同样的服务不抛异常、dock 条目照常（不带目录钩子）。
- 全仓 `npm run typecheck` + `npm run test`（1885 个用例）通过；`npm run build` 通过。

## 相关测试

- `packages/dsh-client/tests/acp-visibility-filter.spec.ts`：「服务已经没了时不把异常
  抛给调用方」。
- `packages/dsh-client/tests/quota-pill.spec.ts`：「目录服务已经没了时不把异常抛给座位」。
