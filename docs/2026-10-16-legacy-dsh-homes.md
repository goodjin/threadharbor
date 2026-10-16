# 两个闲置 DSH home 的运行时归属

核对时间：2026-10-16

## 结论

`.dsh-threadharbor` 和 `.dsh-threadharbor-stable` 这两个 home **各自冻结在旧一代 DSH**，
且都只能用它自己那一代的运行时启动。用现在的 0.2.0-rc.2 去启动，DSH 的兼容性检查会判定
它们挂载的 `dsh-base` / `dsh-web-app` 不适配。两个 home 最后活动都在 2026-09-08，
目前没有实例在跑。

## 各自钉在哪一代

| home | home 层依赖树来源 | DSH | 挂载的 dsh-base / dsh-web-app | 最后活动 |
| --- | --- | --- | --- | --- |
| `~/.dsh-threadharbor` | npx 缓存里的一次性安装 | 0.1.5-rc.1 | 0.1.5-rc.2 | 2026-09-08 |
| `~/.dsh-threadharbor-stable` | 本地开发检出 `~/local-ai/apps/deepseek-harness` | 0.1.0-rc.7 | 0.1.0-rc.7 | 2026-09-08 |
| `~/.dsh-threadharbor-test`（在用，端口 3081） | 全局安装 | 0.2.0-rc.2 | 0.2.0-rc.2 | 活跃 |

判定依据是 2026-10-16 实测：home 层 `profiles/node_modules/@deepseek-ai/` 下各包的
版本号与 realpath，以及逐条 peer 比对（`@deepseek-ai/dsh*` 对 0.2.0-rc.2，
`includePrerelease`）。**"用 0.2.0-rc.2 启动会被判不兼容"是按 peer 规则推出来的，
没有真去启动这两个 home 验证。**

## 各自的启动方式

```sh
# .dsh-threadharbor
DSH_HOME=$HOME/.dsh-threadharbor \
  node /Users/good/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web

# .dsh-threadharbor-stable
DSH_HOME=$HOME/.dsh-threadharbor-stable \
  node /Users/good/local-ai/apps/deepseek-harness/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web
```

`-stable` 的 threadharbor 指向固定发布目录
`~/.local/share/threadharbor/releases/0.1.0-local.20260907.2`，不是工作区——
**当初就是刻意钉在旧一代的**，这不是装坏了。

## 为什么不能顺手升级

home 层那棵树会盖在宿主包上面。用 0.2.0-rc.2 的 CLI 启动一个 home，插件行解析到的是
home 层那份旧 `dsh-base`，peer 全部落在 `^0.1.x`——DSH 会打印不兼容诊断，
功能是否还能跑没有验证过。要让它们能用今天的 CLI 启动，得先决定整棵树升到 0.2.x，
那是一次单独的改动，不该和别的事情混在一起做。

## 处置

保持原样，靠这份记录说明归属。真要启用其中某一个时，再单独立项：要么继续用它自己
那一代的运行时，要么把树升到 0.2.x，二选一。
