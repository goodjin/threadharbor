# threadharbor 仓库守则（对所有在此工作的 agent 会话与人生效）

## 铁律：3081 只能经 `~/bin/dsh-web-3081` 重启

本机的 DSH Web 测试实例（端口 3081）**只能**用这个脚本启停或重启：

```sh
~/bin/dsh-web-3081            # 重启（自动停旧起新，带正确的数据目录）
~/bin/dsh-web-3081 --status   # 只看状态与访问地址
```

**禁止**手敲裸命令启动 3081，包括但不限于：

- `dsh --profile web --port 3081 …`
- `node …/bin.js --profile web --port 3081 …`（任何不带 `DSH_HOME` 的形式）

原因（2026-10-16/18 真实事故，勿再重演）：3081 的正确数据目录是
`~/.dsh-web`（隔离于桌面 App 的 `~/.dsh`）。裸命令会静默落到默认
`~/.dsh` 上——测试目录的会话整体「消失」，且两个实例共用一个数据目录会互相覆写
工作区登记簿（`storages/workspace.json` 整文件改写，后写者抹掉先写者的登记，会话
列表忽多忽少）。脚本内已固化正确的 `DSH_HOME`、端口清理与日志路径，不要绕过它。

任何 agent 会话在需要重启 3081、或诊断「会话不见了 / 列表异常」时，先想到这一条。
在别的端口起临时实例不受本条约束，但也应显式指定独立的 `DSH_HOME`。

## 规则：改代码一律走工作树，主干只收验证过的合并

一切要动代码的任务（功能开发、修 bug、重构），先在 `.worktrees/` 下开一个
工作树，在它的分支上改；不要直接在主工作区改代码。纯文档改动（本文件、
`docs/`）不经工作树，直接在主工作区改。

- **合并回主线前过全部门禁**：`npm run typecheck`、`npm run test`；动过被
  界面或宿主加载的包（如 `dsh-client`）还要 `npm run build` 重建产物——界面
  加载的是 `lib/` 里的构建结果，只并源码不重建，表现与「功能消失」一模一样，
  且无任何报错。
- **合并后要重启才可见**：桌面版重启应用；web 测试实例按上面的 3081 铁律重启。
- 原因（2026-10-20 真实事故，勿再重演）：各 profile 与界面加载的插件代码，经
  仓库 `node_modules/@threadharbor/` 这组软链**唯一来自主工作区**。当天软链曾
  指向一条没包含屏蔽栏功能的开发分支，桌面重启后设置里那一栏「消失」，用户的
  屏蔽选择其实一直好好存着——全程无报错。自那以后软链固定指向主工作区：
  开发在工作树里做，部署只认主干，两边各司其职。

## 规则：zcode / minimaxi 出异常时的排查顺序

zcode（GLM）与 minimaxi（MiniMax）这两组模型插件**贴着 ZCode 与 MiniMax Code 两个上游走**
（凭据、接口地址、模型清单、额度口径）。它们出异常时——发消息 401/404、模型不见了、思考关不掉、
多轮工具调用断掉、配额胶囊不出现——**不要凭猜测改代码**，按下面四步走。

### 1. 先读文档定位到「哪一条依赖点」

| 读什么 | 在哪 |
| --- | --- |
| 用法与已踩过的坑 | [docs/agent-acp/zcode.md](docs/agent-acp/zcode.md)、[docs/agent-acp/minimaxi.md](docs/agent-acp/minimaxi.md) |
| 依赖点清单、现象对照表、已知偏差、同步手册、验收清单 | [docs/upstream-sync.zh.md](docs/upstream-sync.zh.md) |

先在文档的「依赖点清单」和「现象对照表」里定位到具体哪一条，再动代码。

### 2. 拉上游最新代码做对比（这一步不能省）

```sh
git clone --depth 1 --filter=blob:none --no-checkout https://github.com/MiniMax-AI/minimax-code /tmp/minimax-code
git clone --depth 1 --filter=blob:none --no-checkout https://github.com/zai-org/ZCode /tmp/zcode
```

- **MiniMax**：看 `packages/oauth-core/src`（我们整段搬了）与 `packages/config/src`（模型目录、网关地址）。
- **ZCode**：按 `docs/upstream-sync.zh.md` 第二节的路径表逐个核对。
- 搬运目录 `packages/minimaxi-acp/src/vendor/mcode-oauth/` 与上游的差异**只允许两类机械改写**
  （导入后缀、构造函数参数属性）；`git diff` 出现第三类改动，就说明上游变了，该重搬。

### 3. 先分清是上游的锅还是我们的锅

同一个模型在 **ZCode 桌面版 / MiniMax Code** 里也失败 → 上游的问题：记录现象、不改我们的代码。
官方那边正常、只有我们失败 → 是我们这边脱节了，按第 1 步定位到的依赖点修。

### 4. 改完必须验证并回写文档

跑 `npm run typecheck` 与 `npm run test`，再按 `docs/upstream-sync.zh.md` 第八节做真机活测。
然后回写：更新该文档的核对时间、偏差表与验收记录；动过搬运目录的还要更新两个 `PROVENANCE.md`
的版本、上游提交与日期。

> 约定：**上游现在长什么样**是事实，写在 `docs/upstream-sync.zh.md` 里并带核对时间；
> **遇到这类情况怎么动手**是规则，写在本文件。两边不要混。
