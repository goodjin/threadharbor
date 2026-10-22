/**
 * 输入框上的模型名：给外部 agent 的模型加一个 agent 前缀。
 *
 * 2026-10-20 的来历与改法：
 *
 * 原来这块是把整个「模型座位」换成我们按 DSH 0.2.0-rc.2 抄的一份组件
 * （composer-model-select.tsx）。harness 升到 0.2.1-rc.2 之后座位的契约变了：
 * 官方注册多声明了一个子座位 `conversation.input.model.label`，可见的模型名
 * 改由这个子座位渲染（没有占用者时回退成裸模型名），而占用者是另一个插件
 * （dsh-client-ui-deepseek-model-label-1017）。我们那份 0.2.0 的拷贝整个替换
 * 掉座位、自己内联画标签，把新机制整个绕开了。
 *
 * 更要命的是它靠「一次性读 `ctx.get('modelDirectories')`」决定要不要注册：
 * 读不到就静默不注册、也不重试。桌面版上模型目录服务恰好在那一次读的时候
 * 还没就位，于是官方座位顶上，界面上只剩裸模型名（2026-10-20 桌面版现场；
 * web 上恰好读到了，所以看得到前缀——同一个构建，两种表现）。
 *
 * 现在改成只占那个标签子座位：
 * - 子座位由官方声明，`slots.inject` 等它出现，**顺序无关**；
 * - 标签的 props 里就带着 provider（{id,name}）与 model，agent 名字直接从
 *   provider 拿，不再需要模型目录服务——那一处「读不到就静默」的风险随之消失；
 * - 座位本身仍是官方那份渲染（两段式菜单、搜索、强度选择、提示都还是官方的），
 *   我们不再替换它，也就不用再跟着 harness 升级重抄一整份组件。
 *
 * 代价与取舍：
 * - 官方那个 1017 角标（只对官方 Flash 的某一个固定版本）由本组件复刻——我们
 *   接管了这个座位，就不把它弄丢；复刻的那三行条件写在下面，官方改了这里
 *   会漂，但只影响一个模型的一个角标。
 * - 我们那份 0.2.0 拷贝里的「账号/官方 provider 排前面」的排序没有了：菜单用
 *   官方的顺序。
 */

import { Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactElement } from 'react'
import { NAMESPACE } from './locales.ts'

/**
 * 官方在 0.2.1-rc.2 声明的模型标签子座位。
 *
 * 座位名没有类型可钉：本仓的 devDependency 把 DSH 客户端包钉在 0.2.0-rc.2
 * （跑的是 0.2.1-rc.2），0.2.0 的 SlotMap 里还没有这个子座位。护栏是运行时的
 * 那一道：注册进没人声明的座位会当场炸出来（挂载用例里的假座位核就是这么
 * 立的），拼错名字会当场失败，而不是安静地不注册。
 */
export const MODEL_LABEL_SLOT = 'conversation.input.model.label'

/** 官方那个标签占用者的优先级（0）；我们用更低的盖住它。 */
const UPSTREAM_PRIORITY = 0

/** 座位按优先级从小到大渲染，所以 -10 才是「我们赢」。 */
const SHADOW_PRIORITY = -10

/** 外部 agent 的路由前缀：我们的模型都注册在这种路由下。 */
const EXTERNAL_ROUTE_PREFIX = 'acp:'

/**
 * 官方 1017 角标的三个条件（复刻自 dsh-client-ui-deepseek-model-label-1017）。
 *
 * 只有「官方 provider + 那个固定版本的 Flash」才挂角标；其余一律是裸模型名。
 */
const BADGE_PROVIDERS = ['deepseek-account', 'deepseek-official']
const BADGE_MODEL_ID = 'deepseek-flash'
const BADGE_MODEL_NAME = 'DeepSeek-V4.1-Flash'

/** The provider group one model belongs to, as the label slot hands it over. */
export type LabelProvider = {
  readonly id: string
  readonly name: string
}

/** The model the label slot hands over. */
export type LabelModel = {
  readonly id: string
  readonly name: string
}

/** The label's placement, as the slot tells the occupant. */
export type LabelPlacement = 'trigger' | 'menu' | 'option'

/** The props the label slot passes to its occupant (上游 ModelLabelOwner 的形状）。 */
export type ModelLabelProps = {
  readonly provider: LabelProvider
  readonly model: LabelModel
  readonly placement: LabelPlacement
  readonly selected: boolean
  readonly t: (key: string) => string
}

/**
 * 给外部 agent 的模型名加的前缀，或空串。
 *
 * 只给 `acp:` 开头的路由加：原生 provider（zai-coding-cn、minimax-cn 这些）
 * 保持裸模型名——这个歧义是「把会话交给第三方 agent」带来的，给所有 provider
 * 都加前缀等于给每个人凭空加噪音。
 *
 * 外部 agent 的前缀**一律加**，不看模型名里是否已经出现过 agent 名字。模型名
 * 是配置来的纯模型标识（Grok 4.7、M3.1 Flash 这种），它跟 agent 名恰好相同只是
 * 巧合，不是「已经带了前缀」的信号。去重会让前缀规则随命名漂移——Grok 4.7
 * 因为以 Grok 开头就掉了前缀，别的模型却带着，规范不统一。宁可显示成
 * `Grok · Grok 4.7`，也不让规则看字符串脸色。
 *
 * @param provider - 标签座位给的那个 provider 组。
 * @param model - 标签座位给的那个模型。
 * @returns 带分隔符的前缀，或空串。
 */
export function agentPrefix(provider: LabelProvider, _model: LabelModel): string {
  if (!provider.id.startsWith(EXTERNAL_ROUTE_PREFIX)) return ''
  return `${provider.name} · `
}

/**
 * 我们占用的模型标签：agent 前缀 + 模型名，官方那个 1017 角标一并复刻。
 *
 * @param props - 标签座位的 props（provider、model、字典读法）。
 * @returns 标签节点。
 */
export function ModelLabelWithAgent(props: ModelLabelProps): ReactElement {
  const { provider, model, t } = props
  const prefix = agentPrefix(provider, model)
  if (provider.id.startsWith('deepseek-') === false && provider.id !== 'deepseek-account' && provider.id !== 'deepseek-official') {
    // 非官方 provider：只有前缀。
    return <>{`${prefix}${model.name}`}</>
  }
  if (model.id !== BADGE_MODEL_ID || model.name !== BADGE_MODEL_NAME) {
    return <>{`${prefix}${model.name}`}</>
  }
  return (
    <span className={labelClassName}>
      <span>{`${prefix}${model.name}`}</span>
      {' '}
      <Tag tone="info">{t('model-label.badge.1017')}</Tag>
    </span>
  )
}

/** 我们自己的类名（官方那份的 CSS 模块不归我们管）。 */
const labelClassName = 'threadharbor-model-label'

/** The slot host this module registers into. */
export type ModelLabelSlotHost = {
  inject(slot: string, callback: () => () => void): () => void
  // The real register takes the full options table; this module only ever
  // passes name+priority+locale, and the return is a disposer.
  register(options: { name: string; priority?: number; locale?: string }, component: unknown): () => void
}

/** The kill switch: `off` leaves the official label in place. */
export const MODEL_LABEL_STORAGE_KEY = 'threadharbor.modelSeat'

/**
 * Whether the kill switch is set to `off`.
 *
 * Absent localStorage (a server render, a locked-down browser) counts as on:
 * only an explicit `off` retreats.
 *
 * @returns true when this browser asked for the official label.
 */
export function modelLabelShadowedOff(): boolean {
  try {
    return globalThis.localStorage?.getItem(MODEL_LABEL_STORAGE_KEY) === 'off'
  } catch {
    return false
  }
}

/**
 * Register our label over the official one.
 *
 * @param slots - the slot host, to register into once the official seat
 * declares the label slot.
 * @returns the disposer that hands the label back to the official occupant; a
 * no-op when the kill switch asked for the official label.
 */
export function registerModelLabel(slots: ModelLabelSlotHost): () => void {
  if (modelLabelShadowedOff()) return () => {}
  return slots.inject(MODEL_LABEL_SLOT, () => slots.register(
    {
      name: MODEL_LABEL_SLOT,
      priority: SHADOW_PRIORITY,
      // 座位按这个命名空间把字典读法交给占用者（官方那个占用者就是这么拿
      // 角标文案的）；我们的命名空间是插件自己的，键在 locales.ts 里。
      locale: NAMESPACE,
    },
    ModelLabelWithAgent,
  ))
}

/** The priority the official occupant registers at, for tests and docs. */
export const OFFICIAL_LABEL_PRIORITY = UPSTREAM_PRIORITY
