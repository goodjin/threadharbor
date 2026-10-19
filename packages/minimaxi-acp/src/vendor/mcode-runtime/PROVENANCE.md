# mcode-runtime（搬运自 MiniMax Code 的运行时事实）

模型目录与托管网关地址是从 MiniMax 官方 `minimax-code` 仓库搬来的**事实**，不是我们自己维护的清单——官方加模型、加区域，我们跟进一次即可。

## 上游

| 项 | 值 |
|---|---|
| 仓库 | <https://github.com/MiniMax-AI/minimax-code> |
| 路径 | `packages/config/src/model-catalog.ts`、`packages/config/src/config.ts` |
| 搬运日期 | 2026-10-20 |
| 上游提交 | 核对时 main 分支 tree SHA `c21e88ef88b1688546fdd579614a54c04626e67b` |

## 相对上游改了什么

| 文件 | 改动 |
|---|---|
| `endpoints.ts` | 只抄 `PRESET_BASE_URLS` 与 `LEGACY_MANAGED_PRESET_BASE_URLS`。其余环境在上游开源树里是 `.example.invalid` 占位，没有真值可抄。 |
| `model-catalog.ts` | 数值一字未改。唯一改动是把上游从 93 KB 的 `config.ts` 引来的 `ModelConfig` / `ModelCapabilitiesConfig` 两个类型就地声明，并删掉本插件用不到的文件上传能力字段的引用。文件内的 models.dev 出处说明见 `NOTICE.md`。 |

## 稳定性

托管网关地址（`agent.minimax.cn` / `agent.minimax.io` 的 `/mavis/api/v1/llm/v1`）是产品内部路由，**官方文档没有承诺过稳定性**。抄过来是为了跟官方保持一致，不是为了它稳定。真出问题时先看这里是否已被官方改动。

## 怎么跟着官方更新

覆盖上游两个文件 → 保留上表的类型改动 → 更新本文件的日期与提交 → 跑本包测试。
