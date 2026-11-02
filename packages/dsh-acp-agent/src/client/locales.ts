/**
 * Agent-related locale keys extracted from dsh-client for the ACP agent plugin.
 * Only keys used by the browser-side agent UI (quota pills, visibility panel,
 * model label, handover, switch progress, recovery, markdown turn, mermaid).
 */

export type ProgressKey = Extract<ClientLocaleKey, `progress.${string}`>

export const NAMESPACE = 'threadharborClient'

export type ClientLocaleKey =
  | 'handover.title' | 'handover.open'
  | 'answerCard.copy' | 'answerCard.copied' | 'answerCard.edit'
  | 'lostInput.title' | 'lostInput.hint' | 'lostInput.copy' | 'lostInput.copied'
  | 'lostInput.resend' | 'lostInput.sending' | 'lostInput.sent' | 'lostInput.failed'
  | 'lostInput.attachments' | 'lostInput.emptyText'
  | 'quota.fiveHour.label' | 'quota.weekly.label'
  | 'quota.fiveHour.title' | 'quota.weekly.title' | 'quota.resetAt'
  | 'quota.minimaxi.fiveHour.title' | 'quota.minimaxi.weekly.title'
  | 'quota.minimaxi.unlimited' | 'quota.minimaxi.unlimitedTitle'
  | 'quota.minimaxi.credit' | 'quota.minimaxi.creditTitle'
  | 'quota.codex.window.title' | 'quota.codex.credit' | 'quota.codex.creditTitle'
  | 'quota.claude.fiveHour.title' | 'quota.claude.weekly.title'
  | 'quota.claude.credit' | 'quota.claude.creditTitle'
  | 'recovery.interrupted.note' | 'recovery.interrupted.expand'
  | 'markdownTurn.loading' | 'markdownTurn.error' | 'markdownTurn.retry'
  | 'markdownTurn.truncated' | 'markdownTurn.collapse' | 'markdownTurn.expand'
  | 'markdownTurn.collapseAria' | 'markdownTurn.expandAria'
  | 'markdownTurn.openTitle' | 'markdownTurn.openDefault' | 'markdownTurn.openAppsError'
  | 'markdownTurn.openMore' | 'markdownTurn.defaultOpenLink' | 'markdownTurn.linkOpenRight'
  | 'markdownTurn.linkOpenBrowser' | 'markdownTurn.openFolder' | 'markdownTurn.openError'
  | 'markdownTurn.revealError' | 'markdownTurn.copy' | 'markdownTurn.copied'
  | 'markdownTurn.code' | 'markdownTurn.wrap' | 'markdownTurn.unwrap'
  | 'markdownTurn.footnotes' | 'markdownTurn.send' | 'markdownTurn.sendToSession'
  | 'markdownTurn.edit' | 'markdownTurn.cancel' | 'markdownTurn.comment'
  | 'markdownTurn.commentPlaceholder' | 'markdownTurn.commentSend' | 'markdownTurn.commentedAs'
  | 'markdownTurn.commentRemove' | 'markdownTurn.composePlaceholder' | 'markdownTurn.sendFailed'
  | 'markdownTurn.newSession' | 'markdownTurn.newSessionPromptHeader' | 'markdownTurn.newSessionFailed'
  | 'markdownTurn.copyFailed' | 'markdownTurn.filesAll' | 'markdownTurn.filesAllAria'
  | 'markdownTurn.filesCollapseAria'
  | 'mermaid.label' | 'mermaid.diagram' | 'mermaid.source' | 'mermaid.toggleNamed'
  | 'acpVisibility.label' | 'acpVisibility.title' | 'acpVisibility.intro'
  | 'acpVisibility.summary' | 'acpVisibility.summaryNone' | 'acpVisibility.reset'
  | 'acpVisibility.reload' | 'acpVisibility.retry' | 'acpVisibility.loading'
  | 'acpVisibility.empty' | 'acpVisibility.noModels' | 'acpVisibility.agentHiddenHint'
  | 'acpVisibility.agentToggleNamed' | 'acpVisibility.modelToggleNamed'
  | 'acpVisibility.agentFailure'
  | 'acpVisibility.error.missing' | 'acpVisibility.error.shape' | 'acpVisibility.error.failed'
  | 'progress.preparing' | 'progress.loading' | 'progress.ready'
  | 'storagePosture.local'

export const zh: Record<ClientLocaleKey, string> = {
  'handover.title': '已切换到 {target}，对话已移到新会话',
  'handover.open': '打开新会话',
  'answerCard.copy': '复制结果',
  'answerCard.copied': '已复制',
  'answerCard.edit': '编辑',
  'lostInput.title': '本轮请求未送达',
  'lostInput.hint': '这条请求在进入对话记录之前失败了，原文还在这里。',
  'lostInput.copy': '复制原文',
  'lostInput.copied': '已复制',
  'lostInput.resend': '重新发送',
  'lostInput.sending': '正在重发…',
  'lostInput.sent': '已重发',
  'lostInput.failed': '重发失败：{reason}',
  'lostInput.attachments': '原请求带附件或没有文本，只能复制原文。',
  'lostInput.emptyText': '（原请求没有文本）',
  'quota.fiveHour.label': '5小时 {percent}%',
  'quota.weekly.label': '周 {percent}%',
  'quota.fiveHour.title': 'GLM 套餐 5 小时窗口：已用 {used} / {total}',
  'quota.weekly.title': 'GLM 套餐周窗口：已用 {used} / {total}',
  'quota.resetAt': '，{reset} 重置',
  'quota.minimaxi.fiveHour.title': 'MiniMax 套餐 5 小时窗口：剩余 {percent}%',
  'quota.minimaxi.weekly.title': 'MiniMax 套餐周窗口：剩余 {percent}%',
  'quota.minimaxi.unlimited': '不限',
  'quota.minimaxi.unlimitedTitle': 'MiniMax 套餐窗口：不限',
  'quota.minimaxi.credit': '积分',
  'quota.minimaxi.creditTitle': 'MiniMax 套餐剩余积分：{remaining}',
  'quota.codex.window.title': 'Codex 套餐窗口：已用 {percent}%',
  'quota.codex.credit': '积分',
  'quota.codex.creditTitle': 'Codex 按量积分余额：{remaining}',
  'quota.claude.fiveHour.title': 'Claude 套餐 5 小时窗口：已用 {percent}%',
  'quota.claude.weekly.title': 'Claude 套餐 7 天窗口：已用 {percent}%',
  'quota.claude.credit': '按量',
  'quota.claude.creditTitle': 'Claude 按量已用：{used} / {limit}',
  'recovery.interrupted.note': '本轮被中断，{steps} 项过程内容已折叠',
  'recovery.interrupted.expand': '展开本轮过程',
  'markdownTurn.loading': '正在读取文档…',
  'markdownTurn.error': '文档没有读出来',
  'markdownTurn.retry': '重试',
  'markdownTurn.truncated': '文档较长，这里只显示前面一部分',
  'markdownTurn.collapse': '收起',
  'markdownTurn.expand': '展开',
  'markdownTurn.collapseAria': '收起 {name}',
  'markdownTurn.expandAria': '展开 {name}',
  'markdownTurn.openTitle': '用 {app} 打开',
  'markdownTurn.openDefault': '{app}（默认）',
  'markdownTurn.openAppsError': '无法获取应用列表',
  'markdownTurn.openMore': '更多打开方式',
  'markdownTurn.defaultOpenLink': '默认打开方式',
  'markdownTurn.linkOpenRight': '右侧打开',
  'markdownTurn.linkOpenBrowser': '浏览器打开',
  'markdownTurn.openFolder': '打开文件夹',
  'markdownTurn.openError': '打开失败，请重试',
  'markdownTurn.revealError': '文件夹没有打开',
  'markdownTurn.copy': '复制',
  'markdownTurn.copied': '已复制',
  'markdownTurn.code': '代码',
  'markdownTurn.wrap': '换行',
  'markdownTurn.unwrap': '取消换行',
  'markdownTurn.footnotes': '脚注',
  'markdownTurn.send': '发送',
  'markdownTurn.sendToSession': '发送到会话',
  'markdownTurn.edit': '编辑',
  'markdownTurn.cancel': '取消',
  'markdownTurn.comment': '评论',
  'markdownTurn.commentPlaceholder': '写下你的评论…',
  'markdownTurn.commentSend': '发送评论',
  'markdownTurn.commentedAs': '这是用户对此段话的评论',
  'markdownTurn.commentRemove': '删除评论',
  'markdownTurn.composePlaceholder': '输入要加入会话的内容…',
  'markdownTurn.sendFailed': '发送失败，请重试',
  'markdownTurn.newSession': '新建会话',
  'markdownTurn.newSessionPromptHeader': '文件路径：{path}',
  'markdownTurn.newSessionFailed': '新建会话失败，请重试',
  'markdownTurn.copyFailed': '复制失败，请重试',
  'markdownTurn.filesAll': '全部 {count} 个文件',
  'markdownTurn.filesAllAria': '展开全部 {count} 个文件',
  'markdownTurn.filesCollapseAria': '收起文件列表',
  'mermaid.label': 'Mermaid',
  'mermaid.diagram': '图表',
  'mermaid.source': '源码',
  'mermaid.toggleNamed': '切换 Mermaid 图与源码',
  'acpVisibility.label': '提供方与模型',
  'acpVisibility.title': '屏蔽提供方与模型',
  'acpVisibility.intro': '被屏蔽的提供方不会出现在模型选择里（输入框的模型入口与 /model 弹窗）；提供方未被屏蔽时，也可以只屏蔽它下面的个别模型。屏蔽只作用于选择列表：官方设置里的「模型」照旧列出全部、密钥不受影响，随时可以恢复。选择保存在这台机器上，换浏览器不会丢。',
  'acpVisibility.summary': '已屏蔽 {agents} 个提供方、{models} 个模型。',
  'acpVisibility.summaryNone': '当前没有屏蔽任何提供方或模型。',
  'acpVisibility.reset': '全部恢复',
  'acpVisibility.reload': '重新读取',
  'acpVisibility.retry': '重试',
  'acpVisibility.loading': '正在读取提供方与模型清单……',
  'acpVisibility.empty': '这台主机没有列出任何模型提供方。',
  'acpVisibility.noModels': '这个提供方没有可列出的模型。',
  'acpVisibility.agentHiddenHint': '整个提供方已屏蔽；取消勾选后才能单独调整它下面的模型。',
  'acpVisibility.agentToggleNamed': '屏蔽提供方：{name}',
  'acpVisibility.modelToggleNamed': '屏蔽模型：{name}',
  'acpVisibility.agentFailure': '模型目录读取失败：{message}',
  'acpVisibility.error.missing': '这台主机没有提供模型目录（remote.session.modelCatalog）。',
  'acpVisibility.error.shape': '模型目录的返回形状不符合预期。',
  'acpVisibility.error.failed': '读取模型目录失败：{detail}',
  'progress.preparing': '正在准备打开新会话 · {target}',
  'progress.loading': '正在读新会话的历史 · {target}',
  'progress.ready': '新会话已就绪，正在切换 · {target}',
  'storagePosture.local': '设置保存在本机',
}

export const en: Record<ClientLocaleKey, string> = {
  'handover.title': 'Switched to {target}; the conversation moved to the new session',
  'handover.open': 'Open the new session',
  'answerCard.copy': 'Copy result',
  'answerCard.copied': 'Copied',
  'answerCard.edit': 'Edit',
  'lostInput.title': 'This request was not delivered',
  'lostInput.hint': 'It failed before it entered the transcript. The text is still here.',
  'lostInput.copy': 'Copy text',
  'lostInput.copied': 'Copied',
  'lostInput.resend': 'Send again',
  'lostInput.sending': 'Sending again…',
  'lostInput.sent': 'Sent again',
  'lostInput.failed': 'Sending again failed: {reason}',
  'lostInput.attachments': 'The original request had attachments or no text, so only the text can be copied.',
  'lostInput.emptyText': '(the original request had no text)',
  'quota.fiveHour.label': '5h {percent}%',
  'quota.weekly.label': 'wk {percent}%',
  'quota.fiveHour.title': 'GLM plan five-hour window: {used} / {total} used',
  'quota.weekly.title': 'GLM plan weekly window: {used} / {total} used',
  'quota.resetAt': ', resets {reset}',
  'quota.minimaxi.fiveHour.title': 'MiniMax plan five-hour window: {percent}% left',
  'quota.minimaxi.weekly.title': 'MiniMax plan weekly window: {percent}% left',
  'quota.minimaxi.unlimited': 'unlimited',
  'quota.minimaxi.unlimitedTitle': 'MiniMax plan window: unlimited',
  'quota.minimaxi.credit': 'credits',
  'quota.minimaxi.creditTitle': 'MiniMax plan credits remaining: {remaining}',
  'quota.codex.window.title': 'Codex plan window: {percent}% used',
  'quota.codex.credit': 'credits',
  'quota.codex.creditTitle': 'Codex credit balance: {remaining}',
  'quota.claude.fiveHour.title': 'Claude plan five-hour window: {percent}% used',
  'quota.claude.weekly.title': 'Claude plan 7-day window: {percent}% used',
  'quota.claude.credit': 'extra',
  'quota.claude.creditTitle': 'Claude extra usage: {used} / {limit}',
  'recovery.interrupted.note': 'This turn was interrupted; {steps} process items are folded',
  'recovery.interrupted.expand': 'Show this turn’s process',
  'markdownTurn.loading': 'Reading the document…',
  'markdownTurn.error': 'The document did not load',
  'markdownTurn.retry': 'Retry',
  'markdownTurn.truncated': 'This document is long; only the first part is shown',
  'markdownTurn.collapse': 'Collapse',
  'markdownTurn.expand': 'Expand',
  'markdownTurn.collapseAria': 'Collapse {name}',
  'markdownTurn.expandAria': 'Expand {name}',
  'markdownTurn.openTitle': 'Open in {app}',
  'markdownTurn.openDefault': '{app} (default)',
  'markdownTurn.openAppsError': 'Could not load applications',
  'markdownTurn.openMore': 'More ways to open',
  'markdownTurn.defaultOpenLink': 'Default open mode',
  'markdownTurn.linkOpenRight': 'Open on the right',
  'markdownTurn.linkOpenBrowser': 'Open in browser',
  'markdownTurn.openFolder': 'Open folder',
  'markdownTurn.openError': 'Could not open. Try again.',
  'markdownTurn.revealError': 'The folder did not open',
  'markdownTurn.copy': 'Copy',
  'markdownTurn.copied': 'Copied',
  'markdownTurn.code': 'Code',
  'markdownTurn.wrap': 'Wrap',
  'markdownTurn.unwrap': 'Unwrap',
  'markdownTurn.footnotes': 'Footnotes',
  'markdownTurn.send': 'Send',
  'markdownTurn.sendToSession': 'Send to conversation',
  'markdownTurn.edit': 'Edit',
  'markdownTurn.cancel': 'Cancel',
  'markdownTurn.comment': 'Comment',
  'markdownTurn.commentPlaceholder': 'Write a comment…',
  'markdownTurn.commentSend': 'Send comment',
  'markdownTurn.commentedAs': 'The user’s comment on this passage',
  'markdownTurn.commentRemove': 'Delete comment',
  'markdownTurn.composePlaceholder': 'Type content to add to the conversation…',
  'markdownTurn.sendFailed': 'Could not send. Try again.',
  'markdownTurn.newSession': 'New session',
  'markdownTurn.newSessionPromptHeader': 'File path: {path}',
  'markdownTurn.newSessionFailed': 'Could not start a new session. Try again.',
  'markdownTurn.copyFailed': 'Could not copy. Try again.',
  'markdownTurn.filesAll': 'All {count} files',
  'markdownTurn.filesAllAria': 'Show all {count} files',
  'markdownTurn.filesCollapseAria': 'Collapse the file list',
  'mermaid.label': 'Mermaid',
  'mermaid.diagram': 'Diagram',
  'mermaid.source': 'Source',
  'mermaid.toggleNamed': 'Switch between the Mermaid diagram and its source',
  'acpVisibility.label': 'Providers & models',
  'acpVisibility.title': 'Hide providers and models',
  'acpVisibility.intro': 'A hidden provider disappears from the model pickers (the composer model menu and the /model popup); while a provider stays listed, individual models can be hidden too. Hiding only affects the pickers: the official Models settings keep listing everything and no key is touched, so restoring never asks for a key again. This choice is stored on this machine and survives a browser switch.',
  'acpVisibility.summary': 'Hidden providers: {agents}; hidden models: {models}.',
  'acpVisibility.summaryNone': 'No providers or models are hidden.',
  'acpVisibility.reset': 'Restore all',
  'acpVisibility.reload': 'Reload',
  'acpVisibility.retry': 'Retry',
  'acpVisibility.loading': 'Reading providers and models…',
  'acpVisibility.empty': 'This host lists no model providers.',
  'acpVisibility.noModels': 'This provider lists no models.',
  'acpVisibility.agentHiddenHint': 'The whole provider is hidden; clear its checkbox to adjust individual models.',
  'acpVisibility.agentToggleNamed': 'Hide provider: {name}',
  'acpVisibility.modelToggleNamed': 'Hide model: {name}',
  'acpVisibility.agentFailure': 'Model catalog failed: {message}',
  'acpVisibility.error.missing': 'This host offers no model catalog (remote.session.modelCatalog).',
  'acpVisibility.error.shape': 'The model catalog answered in an unexpected shape.',
  'acpVisibility.error.failed': 'Reading the model catalog failed: {detail}',
  'progress.preparing': 'Preparing to open the new session · {target}',
  'progress.loading': 'Reading the new session’s history · {target}',
  'progress.ready': 'New session ready, switching · {target}',
  'storagePosture.local': 'Settings are stored on this machine',
}

type Params = Readonly<Record<string, string | number>>

function interpolate(template: string, params?: Params): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? `{${key}}`))
}

export type RuntimeT = (key: string, params?: Params) => string

export const fallbackT: RuntimeT = (key, params) => {
  const k = key as ClientLocaleKey
  return interpolate(zh[k] ?? key, params)
}

function makeT(locale: Record<ClientLocaleKey, string>): RuntimeT {
  return (key, params) => {
    const k = key as ClientLocaleKey
    return interpolate(locale[k] ?? key, params)
  }
}

export function registerClientLocales(register: (dictionaries: { zh: Record<string, string>; en: Record<string, string> }) => void): void {
  register({ zh: { ...zh }, en: { ...en } })
}
