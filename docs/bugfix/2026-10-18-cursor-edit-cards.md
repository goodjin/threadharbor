# Cursor 编辑卡片只有空参数且长时间显示运行中

核对时间：2026-10-18。

## 现象与证据

用户会话 session-b60d6fa4-c825-48b9-bf39-4f6470289641 的第 9 轮切换至 Cursor，过程中连续出现 name=edit、arguments={} 的调用记录，尚未结束的轮次没有对应工具结果。

在独立临时目录使用本机 Cursor 实测编辑 sample.txt，捕获顺序为：pending + rawInput={}；带 path 的 tool_call_update；in_progress；completed + content 中的 diff（path、oldText、newText）。读取文件的结果位于 rawOutput.content，搜索结果是 rawOutput 中的结构化对象。归一化后的真实帧保存在 captured-frames.cursor-edit.json。

## 根因

1. 首帧立即写入不可变卡片，随后参数到达时不再更新，造成空参数永久保留。
2. runner 只实时写工具调用，所有结果等 session/prompt 返回才落盘，已完成工具在整轮运行期间仍显示运行中。
3. Cursor 方言只读取 rawOutput.stdout，遗漏编辑差异、文件正文和结构化输出。
4. 投影存储按规范化编号建索引，却用带换行的原始编号查找，导致后续帧丢失已累积的名称与参数。

## 修复

Cursor 的空 pending 占位帧暂不创建卡片，等文件路径等输入到达后同步写入匹配的调用声明和卡片。按原始编号保存跨帧状态，对外仍使用原有规范化编号。工具终态结果到达即写入，回合结尾剔除已经成功写入的结果；实时写入失败仍保留结尾重试路径。读取正文、编辑差异和结构化工具结果均予以保存。

没有改写用户历史会话。之前已落成空参数、且原始差异未保存的记录不能凭此代码恢复；修改针对加载修复后的新回合。

## 验证

新增真实帧回归在修改前失败，修改后通过；覆盖延迟参数、带换行编号、实时成功/失败结果、重复完成通知与回合结尾去重。ACP 与派发模块共 587 个测试通过，29 个实机用例默认跳过；派发模块类型检查通过。

通过真实配置、启动工厂、runner 与内容写入器驱动本机 Cursor 修改临时文件，验证路径及 before/after 差异均写入，结果在最终投影开始前提交且只提交一次。待 Web 当前无运行任务后，使用 ~/bin/dsh-web-3081 加载修复。

Web 实机验收通过：隔离诊断会话 session-dba3d57f-179a-4fbb-a220-eed299879bf6 中，编辑调用 seq 22 带 sample.txt 路径，seq 23 的配对结果带 before/after 差异；结果在 turn/end（seq 26）之前已可从 Web 历史接口读到。回合 completed，结果仅一份。
