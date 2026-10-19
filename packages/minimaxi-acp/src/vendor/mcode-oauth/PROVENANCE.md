# mcode-oauth（搬运自 MiniMax Code）

这里是 **MiniMax 官方 `minimax-code` 仓库的登录模块原样搬运**，一个字都没改。搬运它而不是重写一遍，是为了让本插件与桌面版 / 命令行版**共用同一套凭据路径、同一把锁、同一套刷新逻辑**——刷新只发生一次，写回同一个文件，另一边读到的就是新的，不会互相把对方踢掉。

## 上游

| 项 | 值 |
|---|---|
| 仓库 | <https://github.com/MiniMax-AI/minimax-code>（MIT，见同目录 `LICENSE`） |
| 路径 | `packages/oauth-core/src/` |
| 版本 | `@mavis/oauth-core` 0.2.1-beta.7 |
| 搬运日期 | 2026-10-20 |
| 上游提交 | 核对时 main 分支 tree SHA `c21e88ef88b1688546fdd579614a54c04626e67b` |

## 搬运的文件

`index.ts` `auth-core.ts` `contracts.ts` `cross-process-lock.ts` `endpoint-config.ts`
`factory.ts` `namespace.ts` `namespace-migration.ts` `oauth-client.ts` `state-store.ts`
`token-provider.ts` `credential-store/{factory,file-store,types}.ts` `fs/atomic-write.ts`

## 唯一的外部依赖

`proper-lockfile`（官方 oauth-core 自己的依赖，MIT）——跨进程文件锁由它实现，**两边互踢的问题就是靠它避免的**。本包在 `package.json` 里显式声明它。

## 怎么跟着官方更新

1. 对照上游 `packages/oauth-core/package.json` 的 `version` 与本目录文件；
2. 有更新就把上游 `src/` 覆盖回来，**不要顺手改**——本目录的价值就在于它和上游一样；
3. 若上游 `tsconfig` 有变化，同步本包 `tsconfig.vendor.json` 里为兼容上游而放宽的两项（见该文件注释）；
4. 改完跑本包测试，并更新本文件上表的版本、提交与日期。

## 注意

本目录只被本包的 `credential.ts` 使用。对外暴露的是本包自己的接口，不要从这里再往外导出一层。
