# 各主机入设置 + 树的三处打磨（2026-10-15 午后）

## 背景
用户验收阶段 L 后提出：①「各主机」从侧栏移入设置界面新栏目；②树中当前
打开的会话要有选中效果；③会话区顶部展示会话编号与复制按钮。另携一条
边角：旧格式（v3 未迁移）的空白会话不被 blank 过滤（运行时行缺标记）。

## 口子勘察结论（全部读过源码）
- 设置界面分区 = `settings.section` 槽位（list/root）上的登记项，描述符
  {id, order, label, inject}；无命名空间绑定需求，不需要 configForms。
- 设置壳的 openSection(id) 只在壳内部可达（onboarding/快捷键路径），
  无跨插件服务或快捷键触发口 → 树到设置分区无法直达，改文字指引。
- 会话作用域槽位的 inject 回调首参即 sessionId（会话头注册的先例）。
  复制按钮挂 `conversation.session.header.utilities`（list/session）。
- 当前会话判定：原生规则 = 无面板激活时，retainedBy.mainView > 0 的行；
  行构造器确认 retainedBy 在客户端行上。面板激活与否读 layout.panelInfo。

## 任务
1. 兜底过滤：session-source 里「无原始标题且展示名 === 项目标题或路径
   基名」的行视为空白假会话丢弃（覆盖旧格式）。先红后绿。
2. 各主机入设置：settings.section 注册（id threadharbor-hosts）复用
   AgentPanel；撤 sidebar.panellist 与 main 注册；树的未部署提示改为
   指向 设置 → 各主机；删除 focus-host 桥（selectPanelThrough/pending
   Focus/面板监听）与对应测试；杀开关保留。
3. 选中效果：收窄层透传 retainedBy；树容器算 currentId（面板激活时不亮），
   订阅 panelInfo 变更重读；sessionRow data-active + 样式。
4. 会话编号条：utilities 组件显示短编号 + 复制（剪贴板 + 已复制反馈），
   中英文案。
5. check 全绿 + 构建 + 3081 真机验证（设置新栏目可见可用、树选中态、
   会话头复制、假会话绝迹）+ 设计文档补记 + 提交。

## Review Focus
- 设置分区在移动端/窄窗不破版；AgentPanel 在设置面板里可滚动操作完整
  （连接/部署状态机不受槽位变化影响）。
- 树的选中态跟随会话切换即时变化（订阅 panelInfo），面板激活时不高亮。
- 复制按钮在无剪贴板权限时如实报错不静默。
- 兜底过滤不得误伤真实会话：用户改过名（title 有值）或 LLM 起过名的
  会话即使标题恰好等于目录名也保留。
