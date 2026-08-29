# DeepSeek Harness Web 插件调研

结论：第三方插件能够通过 DeepSeek Harness 的公开 browser plugin graph 修改主题、设置区和完整 Web 外观，不需要修改 Harness 安装包。ThreadHarbor 应当沿用这条机制，而不是在 Harness client runtime 中增加产品专用开关。

## 已核对项目

### Catppuccin for DeepSeek Harness

[`NoNameLeGo/dsh-catppuccin-theme`](https://github.com/NoNameLeGo/dsh-catppuccin-theme) 同时声明 `dsh.bundle` 与 `dsh.client`。Host 侧通过 WebServer API 保存设置，browser 侧调用 theme runtime、settings slot 和 locale API，并由 profile patch 插入一个普通 Cordis row。它不修改 Harness 源码。

### dsh-dream-skin

[`RevolutionLA/dsh-dream-skin`](https://github.com/RevolutionLA/dsh-dream-skin) 也是标准双面插件。它通过 `ctx.theme`、`ctx.theme.overrideTokens` 和 `ctx.slots` 改变整个 Web GUI，并使用 host route 持久化状态。项目文档明确说明安装命令是 `dsh plugin --profile web add dsh-dream-skin`，实现不注入、不改二进制。

### dsh-deepskin

[`raidenshogun666/dsh-deepskin`](https://github.com/raidenshogun666/dsh-deepskin) 的 browser bundle 注入 `slots`、`locale`、`connection`、`settingsScope` 与 `theme`，注册 settings section，并通过 theme token 与受控 style layer 改变界面。它同样只追加 profile plugin row。

### 其他 UI 插件目录

[`ZeroPointRepo/awesome-dsh-plugins`](https://github.com/ZeroPointRepo/awesome-dsh-plugins) 还收录了 Endfield UI、透明 UI、桌面宠物和更多 skin。这说明 Web UI 扩展并非某一个主题项目的偶然做法，而是一个已有生态在使用的公开能力。

## 对 ThreadHarbor 的影响

ThreadHarbor browser 包已经具备正确的 slot 所有权模型：向 `sidebar` 与 `conversation` 注册自己的 occupant。根 bundle 只需停用官方同名 occupant，保留 layout 与 runtime，然后插入 ThreadHarbor client。原实现中的 `__DSH_REMOTE_AGENT_WEB__` 全局和 Harness runtime 分支已经从独立项目删除。

这种实现与主题插件的共同点是：

- manifest 使用 `dsh.bundle` 与/或 `dsh.client`；
- browser artifact 由 Harness `window.__ModuleLoader__` 加载；
- UI 注册与清理由 Cordis effect/slot 生命周期负责；
- profile patch 组合或替换具体插件 row，而不是改 Harness 源文件。

ThreadHarbor 与主题插件的区别只在占用范围：主题通常注册 token 或 settings item；ThreadHarbor 有意替换两个顶层产品 slot，并另加一个 Host gateway。这个范围更大，但仍处在同一公开扩展机制内。
