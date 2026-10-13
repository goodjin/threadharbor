# Bug Fix: 重打后 Web 起不来 —— 浏览器包被拆成两个分块 + 混入 node 内置模块 + 宿主插件语法不兼容

## 问题描述
- 日期: 2026-10-14
- 严重程度: Critical（页面完全起不来）
- 影响范围: 3081 test 通道。重跑 `pnpm run build` 并重启后，浏览器整页报
  `Failed to load plugins / @threadharbor / web boot: 1 entry did not activate`，
  具体错误 `client-modules: require("./ssh-deploy-DIC3ullr.cjs") missed the module table`。
  同一晚还暴露出宿主侧 `threadharbor-ssh-deploy` 插件从未成功导入过的旧账。

## 现场证据
- `packages/dsh-client/lib/` 出现两个 `ssh-deploy-*.cjs` 分块；`client.js` 头部
  以反引号字符串调用工厂参数（压缩器已把 `require` 改名单字母）请求相对分块。
- 浏览器模块装载器（参考源 `packages/client/modules/src/client/system.ts` 的 require）
  只解析：平台种子词 / 已物化模块 / 注册的包工厂——文件与 `node:*` 一律抛
  “missed the module table”。
- 平台种子表（`client/web/src/seed.ts`）只有 react 系与 client UI 包，没有任何 node 内置。
- 宿主侧：`node -e "import('…/ssh-deploy.ts')"` 在原生 TS 剥离模式下报
  `TypeScript parameter property is not supported in strip-only mode`
  （`ssh/manager.ts:43` 的 `constructor(private readonly options…)`），tsx 下则无恙——
  所以单测/源码启动一直绿，Web 宿主（原生剥离）却每次 "failed to import"。

## 根因分析
1. **分块**：`client/index.ts` 里为远端会话拉取写的动态 `import('../ssh-deploy.ts')`
   （9c40f48 引入）让 tsdown 拆出兄弟分块；单文件工厂包没有配 `inlineDynamicImports`。
   此前没炸是因为上次成功构建早于该提交，旧产物里根本没有这段。
2. **node 内置混入**：包根入口 re-export 了 `SSH_DEPLOY_ENTRY_ID from './ssh-deploy.ts'`
   （75d1486 引入），把拖着 `node:os`/`node:path` 的行为模块拽进浏览器图——
   恰是同文件里 tailscale 注释警告过的同类陷阱（先例是拆出 `tailscale-keys.ts`）。
3. **宿主插件**：`ssh/manager.ts` 的构造器参数属性是原生剥离模式不支持的语法；
   该插件自引入起在 Web 宿主上就从未挂载成功（日志里 ssh-deploy 首次出现即是失败）。

## 修复方案
- 客户端构建配 `inlineDynamicImports: true`（与 DSH 自家单文件客户端插件一致）。
- 仿 `tailscale-keys.ts` 先例拆出纯字符串模块 `ssh-deploy-id.ts`，根入口改从它导出。
- `ssh/manager.ts` 参数属性改为显式字段声明 + 普通赋值。
- `scripts/verify-build.mjs` 加四道门：产物单文件（无 `*.cjs` 分块、无相对 `.cjs` 引用）、
  无 `node:*` 引用、补丁里点名的宿主插件入口必须能被**纯 Node** 导入、
  产物在装载器真实契约（种子词 require）下完整物化并导出。

## 验证步骤
1. ✅ verify-build 修复前红（点名两个分块），修复后绿。
2. ✅ 物化烟测：工厂只请求 `react`/`react/jsx-runtime` 两个种子词，完整导出面板组件。
3. ✅ 全仓 `pnpm typecheck` + `pnpm test`（800 通过）+ `pnpm run build`。
4. ✅ 3081 重启后 boot 日志 0 条 "did not activate"，五家 agent 行挂载，
   `[threadharbor] ssh-deploy routes registered` 首次出现。
5. ✅ 从运行中的服务器取回实际下发的 `@threadharbor/dsh-client` 产物：单文件、
   无分块引用、无 node 内置，与本地构建逐字节一致（仅服务器剥掉的 sourcemap 行）。

## 相关测试
- `scripts/verify-build.mjs`（构建门，随 `pnpm run build` 执行）
