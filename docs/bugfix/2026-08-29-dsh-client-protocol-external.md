# Bug Fix: dsh-client 浏览器产物错误外部化 @threadharbor/protocol

## 问题描述

- 日期: 2026-08-29
- 严重程度: Critical
- 影响范围: DSH Web 启动后加载 ThreadHarbor client 插件失败

启动 DSH Web 后，Harness 报错：

```text
failed to import loader entry ... (@threadharbor/dsh-client): client-modules: require("@threadharbor/protocol") missed the module table
```

## 根因分析

- 问题位置: `packages/dsh-client/tsdown.config.ts`
- 原因: browser bundle 使用了无效的 `deps.neverBundle` / `deps.alwaysBundle` 配置，当前 `tsdown@0.15.12` 实际识别的是 `external` / `noExternal`。
- 结果: `@threadharbor/protocol` 作为 production dependency 被默认外部化，生成的 `packages/dsh-client/lib/client.js` 内保留了 runtime `require("@threadharbor/protocol")`。
- DSH Web 的 client module table 只提供平台 seed 和声明的 client module factory，不会自动 materialize ThreadHarbor 的 workspace runtime dependency，因此页面加载失败。

## 修复方案

- 修改 `packages/dsh-client/tsdown.config.ts`：
  - 使用 `external` 显式保留 React 和 DSH Web 平台依赖；
  - 使用 `noExternal: ['@threadharbor/protocol']` 强制把协议包内联进 browser bundle。
- 修改 `scripts/verify-build.mjs`：
  - 新增门禁：browser artifact 中不得出现 `@threadharbor/protocol` runtime require。
- 新增 `packages/dsh-client/tests/client-artifact.spec.ts`：
  - 直接执行构建后的 `lib/client.js`；
  - 使用最小 fake DSH module table；
  - 若 browser bundle 仍请求 `@threadharbor/*` workspace 包，测试立即失败。
- 修改 `packages/dsh-client/tests/store.client.spec.ts`：
  - 移除缺失的 jsdom 环境依赖；
  - 用最小 fake `window` 覆盖 store 测试需要的 timer/sessionStorage。

## 验证步骤

1. ✅ `npm run build`
2. ✅ `rg -n "@threadharbor/protocol|require\\(" packages/dsh-client/lib/client.js`
3. ✅ `npm test -- packages/dsh-client/tests/client-artifact.spec.ts`
4. ✅ `npm run typecheck`
5. ✅ `npm test`
6. ✅ 启动 DSH Web：`dsh --profile web --patch /private/tmp/threadharbor-web-local.patch.yml --no-open --port 0`
7. ✅ 请求实际服务出的插件产物：`/plugins/@threadharbor/dsh-client/client.js`，确认不包含 `@threadharbor/protocol`

## 设计建议

- browser bundle 的外部依赖必须采用 allowlist：只允许 DSH 平台 seed 和明确由 DSH client module graph 提供的包。
- build verifier 必须同时检查：
  - 应外部化的依赖确实外部化；
  - 不应外部化的 workspace/runtime 依赖没有泄漏到 module table。
