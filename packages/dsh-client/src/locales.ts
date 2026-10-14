/**
 * 这份插件的用户可见文案，走 DSH 的 locale 字典。
 *
 * `verify-client-ui-i18n`（宿主仓库的检查，本插件以同一标准自检）只允许字典
 * 文件持有成品文案：界面代码一律通过 `t` 读这里的键。zh 与 en 都必须齐——
 * 注册时两个语言一起交给 `ctx.locale.register`，缺一边就注册不上。
 *
 * 占位符用 `{name}` 形式，调用侧以 `t(key, { name })` 传值；两种语言必须
 * 用同样一组占位符，否则切语言会渲染出残句。
 */

/** 这个插件在 locale 注册表里的命名空间。 */
export const NAMESPACE = 'threadharborClient'

/** 中文词典（源语言，键的出处）。 */
export const zh = {
  /** 侧栏行名：主机列表面板。 */
  'panel.label': '各主机',
  /** 切换进度条的三个阶段；`{target}` 是新会话的 agent 名。 */
  'progress.preparing': '正在准备打开新会话 · {target}',
  'progress.loading': '正在读新会话的历史 · {target}',
  'progress.ready': '新会话已就绪，正在切换 · {target}',
  /** 交接卡：被切走的回合显示的中性行。 */
  'handover.title': '已切换到 {target}，对话已移到新会话',
  'handover.open': '打开新会话',
  /** 手机配对 section：侧栏行名与面板三种状态。 */
  'pairing.label': '手机配对',
  'pairing.loading': '正在获取配对网址…',
  'pairing.ready.title': '用手机扫码打开',
  'pairing.qr.alt': '手机配对二维码',
  'pairing.url.hint': '扫码不便时，把这个网址发到手机上打开：',
  'pairing.guidance.originTitle': '还差一步配置：手机端访问地址',
  'pairing.guidance.origin': '这台 DSH 还没有配置 mobileOrigin。请按文档在 DSH 配置里给 threadharbor-mobile-entry 设置 mobileOrigin 字段（手机端根网址，如 https://mac1.example.ts.net），保存并重启 DSH 后刷新这个页面。',
  'pairing.guidance.unreachableTitle': '拿不到配对网址',
  'pairing.guidance.unreachable': '没能从这台主机取回配对网址。请确认这个页面是从 DSH 服务所在的机器打开的，然后刷新页面重试。',
  'pairing.guidance.detail': '原因：{detail}',
} satisfies Record<string, string>

/** 这份文案的全部键，也是命名空间声明进 `LocaleNamespaceMap` 的键域。 */
export type ClientLocaleKey = keyof typeof zh

/** 切换进度条的键。 */
export type ProgressKey = Extract<ClientLocaleKey, `progress.${string}`>

/** 交接卡的键。 */
export type HandoverKey = Extract<ClientLocaleKey, `handover.${string}`>

/** 英文词典，键域与 zh 完全一致。 */
export const en = {
  'panel.label': 'Hosts',
  'progress.preparing': 'Preparing to open the new session · {target}',
  'progress.loading': 'Reading the new session’s history · {target}',
  'progress.ready': 'New session ready, switching · {target}',
  'handover.title': 'Switched to {target}; the conversation moved to the new session',
  'handover.open': 'Open the new session',
  'pairing.label': 'Mobile pairing',
  'pairing.loading': 'Fetching the pairing URL…',
  'pairing.ready.title': 'Scan with your phone',
  'pairing.qr.alt': 'Mobile pairing QR code',
  'pairing.url.hint': 'If scanning is inconvenient, open this URL on the phone:',
  'pairing.guidance.originTitle': 'One step missing: the mobile origin',
  'pairing.guidance.origin': 'This DSH has no mobileOrigin configured yet. Following the docs, set the mobileOrigin field of the threadharbor-mobile-entry plugin in the DSH configuration (the mobile root URL, e.g. https://mac1.example.ts.net), restart DSH, and reload this page.',
  'pairing.guidance.unreachableTitle': 'Pairing URL unavailable',
  'pairing.guidance.unreachable': 'The pairing URL could not be fetched from this host. Make sure this page is opened from the machine serving DSH, then reload and try again.',
  'pairing.guidance.detail': 'Reason: {detail}',
} satisfies Record<ClientLocaleKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 这份插件自己的文案：侧栏行、切换进度条、交接卡。 */
    threadharborClient: ClientLocaleKey
  }
}
