# Bug Fix: dsh-client 浏览器产物再次外部化 @threadharbor/protocol

## 问题描述
- 日期: 2026-09-01
- 严重程度: Critical
- 影响范围: DSH Web 3080（stable）和 3081（test）启动后无法加载 ThreadHarbor client 插件

启动 DSH Web 后，Harness 报错：

```text
Failed to load plugins
failed to import loader entry ... (@threadharbor/dsh-client): client-modules: require("@threadharbor/protocol") missed the module table — not a platform seed word, not a materialized module, and no registered package factory (a build-time externals drift, or a dynamic dependency that did not arrive)
```

WebSocket 协议改造后重新打包即复现。同一错误曾在 `docs/bugfix/2026-08-29-dsh-client-protocol-external.md` 记录过，但当时的 tsdown 配置修复没有落到仓库里的 `packages/dsh-client/tsdown.config.ts`。

## 根因分析
- 问题位置: `packages/dsh-client/tsdown.config.ts`
- 原因: browser bundle 仍使用无效的 `deps.neverBundle` / `deps.alwaysBundle`。当前 `tsdown@0.15.12` 识别的是 `external` / `noExternal`。
- tsdown 默认把 `package.json` 的 production 依赖和 peer 依赖都标成 external。`@threadharbor/protocol` 是 production dependency，因此产物里留下 `require("@threadharbor/protocol")`（minify 后是 `e(\`@threadharbor/protocol\`)`）。
- DSH Web 的 client module table 只提供平台 seed（React、DSH UI primitives 等），不会 materialize ThreadHarbor 的 workspace 包，页面因此无法启动。
- WebSocket 改造新增 `ws-transport.ts` 对 protocol 的运行时导入，重新打包后把这个漂移重新打进 3080/3081 正在服务的 `client.js`。
- `scripts/verify-build.mjs` 此前只检查平台 external 是否还在，没有拒绝 protocol 泄漏。`npm run check` 先跑测试再构建，产物测试测的是旧 artifact，拦不住这次回归。

## 修复方案
- 修改 `packages/dsh-client/tsdown.config.ts`：
  - 删除无效的 `deps.neverBundle` / `deps.alwaysBundle`；
  - 用 `external` allowlist 保留 React 和 DSH 平台依赖；
  - 用 `noExternal` 把其余依赖（含 `@threadharbor/protocol`）强制内联进 browser bundle。
- 修改 `scripts/verify-build.mjs`：browser artifact 中不得出现 `@threadharbor/protocol`。
- 修改 `packages/dsh-client/tests/client-artifact.spec.ts`：
  - 运行时 factory 不得向 module table 请求 `@threadharbor/*`；
  - 源码级断言产物不含 `@threadharbor/protocol`；
  - 顺带核对当前 UI 文案和 `/remote-agent/ws` 已被打进产物。

## 验证步骤
1. ✅ `npm run build`（含 `scripts/verify-build.mjs`）
2. ✅ 本地 `packages/dsh-client/lib/client.js` 不含 `@threadharbor/protocol`，仍含 `/remote-agent/ws` 和 `/remote-agent/control`
3. ✅ `npx vitest run packages/dsh-client/tests/client-artifact.spec.ts`
4. ✅ 3080/3081 实际服务的 `/plugins/@threadharbor/dsh-client/client.js` 与本地产物 SHA256 一致，且不含 `@threadharbor/protocol`
5. ⚠️ 完整 `npx vitest run` 中 `packages/hostd/tests/hostd-integration.spec.ts` 仍因 unix socket `EINVAL` 失败，与本次 client 打包无关
6. ⚠️ Tabbit 在 `domcontentloaded` 时关闭 `http://127.0.0.1:3080/` 标签，未能在浏览器里点选页面；插件加载路径已用线上产物和 factory 测试替代验证

## 相关测试
- `packages/dsh-client/tests/client-artifact.spec.ts`
- `scripts/verify-build.mjs`

## 设计建议
- browser bundle 的外部依赖必须采用 allowlist：只允许 DSH 平台 seed。
- 构建门禁必须同时检查：应外部化的依赖确实外部化；workspace/runtime 依赖没有泄漏到 module table。
