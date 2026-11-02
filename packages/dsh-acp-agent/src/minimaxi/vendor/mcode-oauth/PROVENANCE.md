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

## 两处必要的机械改写（不是修改，是翻译）

上游用的是编译后的 JS 约定（相对导入写 `.js`、构造函数参数属性），本仓库跑的是
TypeScript 源码，且宿主（DSH）用 Node 的**原生类型剥离**加载插件。原生剥离只做擦除、
不做转换，而且不允许 `node_modules` 里的类型剥离。上游的写法在这里会直接加载失败：

| 上游写法 | 本目录改写为 | 不改的后果 |
|---|---|---|
| `from './namespace.js'` | `from './namespace.ts'` | `ERR_MODULE_NOT_FOUND` |
| `constructor(private readonly x: T)` | 显式字段声明 + 构造函数体内赋值 | `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` |

这两类改写只动语法形式，**逻辑一行未改**。因此本目录与上游的差异应当只有上表两类：
下次同步时按这两条机械施加即可，`git diff` 里出现第三类改动就是错的。

改写无法用脚本可靠地自动施加——构造函数参数属性的位置改写会连带影响后续下标，
试过两种写法都会改坏。因此这里不提供脚本，改为按上表人工施加并逐文件比对。

这也是本包不能被打成普通 npm 包安装的原因之一，见
[docs/install-plugins.zh.md](../../../../../docs/install-plugins.zh.md)。

## 注意

本目录只被本包的 `credential.ts` 使用。对外暴露的是本包自己的接口，不要从这里再往外导出一层。
