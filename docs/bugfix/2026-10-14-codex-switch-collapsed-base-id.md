# Bug Fix: 切 Codex 时“接管没发生”——切换链不认折叠后的基础模型名

## 问题描述
- 日期: 2026-10-14（深夜第二轮）
- 严重程度: Critical（选 Codex 后必失败）
- 影响范围: 发布档位模型的 agent（codex；zcode 若发布档位同样受影响）。上一轮修好
  `prepareCall` 后请求真正进入切换链，转而报
  `reached a native model request … even though the takeover should own its step — the takeover did not happen`。

## 现场证据
- 会话 7f0a4de9 第 2 回合日志：原生步骤正常组包（系统提示词含 gpt-6-astra），
  `request/header` 的 config 为 `provider acp:acp-codex / model gpt-6-astra`（基础名，无档位），
  `assistant/attempt` 以切换链的 noop 诊断结束。
- 该诊断只在一个分支抛出：`planSwitch` 判 `noop`，即“会话已在此路由，或模型不归本行”。
- cordis.patch.yml 里 codex 预设声明的模型全是 `gpt-6-astra[low|medium|high|xhigh]`；
  `presetForModel` 拿声明名单与请求里的 `gpt-6-astra` **逐字比对**，必然落空 → noop。

## 根因分析
目录把 `base[effort]` 折叠成基础名展示与选择（`collapseEffortModels`），
`resolveModel` 也已按基础名回退解析；但**反方向**的三条路径没跟上折叠：
1. `catalog.ts presetForModel`——模型→预设反查（本 bug 的直接原因）；
2. `follow.ts decidePresetFollow` 的 keep 判断——用户自选的基础名会被误覆写为第一个档位名；
3. `switch-mount.ts declaredContextWindow`——基础名找不到声明窗口，
   超长对话的拒绝检查被静默跳过。
另外排查中发现一处连坐隐患：**会话起标题**（`session-title-first-prompt-llm`）借用会话路由
发起模型请求（带 `purpose: 'session-title'` 与 sessionId，参考实现 session-title-llm:262-281），
与对话回合并发；不拦会把“起标题”送进切换链——轻则报错，重则分叉出的新会话首条消息是标题问题。

## 修复方案
- `selection.ts` 的 `baseIdOf`（剥 `[effort]` 后缀）导出为唯一基准，上述三处统一
  “基础名对基础名”比较，杜绝再次漂移。
- `catalog.stream` 对带 `purpose` 的后台请求（标题/压缩，参考实现仅此两种，
  对话回合从不携带）就地拒绝且不触碰切换钩子；标题照旧回退为首条消息文本——
  与被驱动会话的现状一致。

## 验证步骤
1. ✅ 三条红测试先行（反查/跟随/窗口各一），修复后转绿；后台请求守卫测试断言钩子零调用。
2. ✅ 真机探针：codex-acp 直连，`session/prompt` 携 `modelId: gpt-6-astra`（基础名）
   一轮真实对话成功完成并流式返回——分叉后的新会话可直接用基础名提示。
3. ✅ 全仓 806 测试、类型检查、构建校验全绿。
4. ✅ 3081 重启：五行挂载、ssh-deploy 路由注册、启动零失败。

## 相关测试
- `tests/catalog.spec.ts`（presetForModel 折叠三例 + 后台请求守卫）
- `tests/follow.spec.ts`（keep 判断折叠例）
- `tests/switch-mount.spec.ts`（declaredContextWindow 折叠例）
