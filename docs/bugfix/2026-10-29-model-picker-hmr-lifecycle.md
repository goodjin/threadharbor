# 2026-10-29：插件更新后模型选择框消失，重启后恢复

## 原因与证据

模型目录过滤器 `acp-visibility-filter.ts` 把 Cordis 的调用方代理当成稳定的服务实例。
Cordis 在每次读取服务和方法时创建代理；方法调用时会把 `this.ctx` 绑定到调用方。

旧实现有三处相互叠加的问题：

1. 箭头函数捕获安装过滤器时的服务代理，再用 `original.apply(service, args)` 调用原方法。
   后续模型选择框的读取也因此绑定到安装过滤器的插件上下文。插件热更新卸载后，该上下文失效。
2. 卸载时比较 `holder.directoryFor === wrapper`。代理每次返回新的方法代理，这个比较不成立，
   旧包装留在共享服务上。下一代模块又有自己的 WeakMap，无法识别它，继续叠加包装。
3. 异常兜底的 `getSnapshot()` 返回 `undefined`。官方 ModelSelect 直接访问 `state.groups`
   等字段，兜底本身仍会导致渲染异常，选择框条目被移除。

历史桌面日志记录了 `cannot get required service "remote.session" in inactive context`
及 `slot entry crashed in 'conversation.input.model'`。本次使用实际安装的 Cordis 4.0.1，
以真实 Context/Service 和插件卸载重现了旧包装无法撤除；此前测试只用了普通对象，没覆盖代理语义。

## 修改

- 经 Cordis 的 `Symbol.for('cordis.original')` 取得底层实例，使用它做包装登记和卸载比较。
- 包装方法保留调用时的 `this`，不把后续调用绑在安装插件的上下文上。
- 旧代调用转交新代时直接使用新代过滤结果，避免旧屏蔽设置再次过滤。
- 卸载当前包装时清除其当前服务指针。
- 服务不可用时提供完整、引用稳定的错误快照；选择操作报错，不伪装成成功。

## 验证

- 新增真实 Cordis 生命周期测试：连续三代模块重新求值、插件安装与卸载，检查每代目录读取和原方法恢复。
- 原有跨模块换代测试补充“新代取消屏蔽后，旧包装不能继续隐藏模型”。
- 错误快照测试覆盖官方组件直接读取所需的字段、稳定引用、load 返回值和 select 失败。
- `npm run typecheck`、`npm run build` 通过。
- `NODE_OPTIONS=--no-experimental-webstorage npm run test`：167 个测试文件通过，2115 项通过，
  3 个文件 / 41 项按仓库原有配置跳过。本机 Node 24.18.1 的实验 Web Storage 会干扰 jsdom，
  因而测试时关闭该实验功能；网络测试需要允许监听本机临时端口。

修复提交 `c49e818` 已合并至 main，并已在主工作区重新执行 `npm run build`。

本次验证使用真实 Cordis 生命周期及全仓回归，尚未进行桌面 UI 连续热更新的人工验收。
已运行的旧窗口需要重启一次，清除旧代码残留的包装并加载新构建；后续更新不应再触发本次已复现的失效路径。
