# Cursor 配置校验清空 ACP 默认参数，导致握手反复超时

核对时间：2026-10-18。

## 根因与现场证据

真实桌面环境的 Cursor 已登录；沙箱内的 Not logged in 是不同执行环境下的结果，不能用于判断桌面登录失效。正常主机环境运行现有 Cursor 工具调用实机测试，约 21 秒通过。

3081 中创建独立诊断会话 `session-ffbbd170-c997-4d3e-adef-c23f29306c6e`，经模型选择和发送接口进入实际调用链，修改前复现整整 60 秒握手超时。该回合的 Cursor 子进程命令行没有 acp 参数。

入口的 `Schema.array(Schema.string())` 会把省略的 args 变成空数组。入口将它传给启动工厂；工厂的 `preset.args ?? defaults` 把空数组视为显式配置，因而不再添加 acp 与 --trust。此前直接传手写配置的工厂测试绕过了这一步，所以默认参数修复在测试中有效、在真实配置装载时失效。旧记录把持续失败归因于旧构建，未排除这条实际配置链路，结论不完整。

## 修复

args 外包一个没有默认值的可选 union，保留“省略”和“显式空数组”的区别；显式配置仍完全覆盖默认参数。新增用例先经过真实入口 Config 校验，再启动记录参数的子进程。省略参数的用例在修改前收到空数组而失败，修改后收到 acp 与 --trust。

同时保留握手总时限，在超时信息中指出当前等待 initialize、authenticate、session/new 或 session/set_mode；认证超时提示检查登录。连接失败后的销毁与重连逻辑不变。

## 验证

- factory、runner、gateway 共 88 个测试通过；扩大到派发模块共 416 个测试通过、6 个跳过；派发模块类型检查通过。
- 正常主机环境 Cursor 实机工具调用测试通过。
- 全仓类型检查仍被客户端缺失导入、词条及主机和手机模块的既有错误阻挡，本次未修改这些模块。
- 3081 使用指定的 ~/bin/dsh-web-3081 重载，重载前查询的会话均未运行。诊断期间尝试的临时 launchd 作业已全部移除，最终仅经指定脚本启动。
- 修复后同一诊断会话第 6 轮实际返回 CURSOR_CONNECTION_OK，turn/end 为 completed（seq 70）；其 Cursor 子进程命令行包含 acp --trust。该验证经过 3081 的 session/selectModel、session/prompt 与 session/page 接口，不是直接绕过宿主调用 Cursor。
- 未重启桌面 App；桌面实例需要重新加载插件才能使用此修改。
