/**
 * GLM 套餐配额胶囊：挂在输入框下方的 dock 里，与 token 用量同一排。
 *
 * 数据链路：宿主侧的 `threadharbor-zcode-quota` 插件（preset-dispatch 包）
 * 在 `/threadharbor/zcode/quota` 上用本机 ZCode 登录密钥转发 Coding Plan 的
 * monitor 应答；这里只做同源 GET，密钥永不出宿主进程。轮询器由 apply 创建
 * 一份、全浏览器共享——套餐是账号级数字，不是会话级。
 *
 * 出现条件（用户 2026-10-16 拍板）：只在当前会话选的模型是 GLM（zcode 那组）
 * 时渲染；拿不到配额就整行不渲染，原因经 report 留一条日志（同一原因不重复
 * 报）。子代理会话与模型座位同判：subagentAddress 存在即隐藏。
 *
 * 渲染走 session-id-bar 的既定样式：.ts + createElement + 内联样式 + 词典 t
 * （title 属于检查器盯的文案属性，必须来自 t）。颜色只用主题令牌：过八成
 * `--dsw-static-red-500`，过半 `--dsw-alias-state-warn-label`。
 */

import { createElement } from 'react'
import type { ReactNode } from 'react'
import { IconDatabaseOutlineRegular, IconGaugeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { fallbackT, NAMESPACE } from './locales.ts'
import type { RuntimeT } from './locales.ts'

/** 与宿主侧 zcode-quota 路由登记的同一路径。 */
export const QUOTA_ROUTE_PATH = '/threadharbor/zcode/quota'

/** MiniMax 那侧宿主路由的同一路径（见 dsh-preset-dispatch/minimaxi-quota）。 */
export const MINIMAX_QUOTA_ROUTE_PATH = '/threadharbor/minimax/quota'

/** Codex（ChatGPT 套餐）宿主路由（见 dsh-preset-dispatch/codex-quota）。 */
export const CODEX_QUOTA_ROUTE_PATH = '/threadharbor/codex/quota'

/** Claude（Anthropic 官方订阅）宿主路由（见 dsh-preset-dispatch/claude-quota）。 */
export const CLAUDE_QUOTA_ROUTE_PATH = '/threadharbor/claude/quota'

/** dock 里的条目 id 与顺序：排在官方 stats（order 0）之后。 */
export const QUOTA_DOCK_ID = 'threadharbor-zcode-quota'
export const QUOTA_DOCK_ORDER = 10

/** zcode 那组模型在目录里的 id 前缀；选了它才轮到配额胶囊出场。 */
const GLM_MODEL_PREFIX = 'GLM-'

/**
 * 一套胶囊的取值口径。各家同源同骨架，差别只有四处：选谁才出现（模型前缀或
 * 目录里的 provider id）、percent 是「已用」还是「剩余」（决定变色方向与文案）、
 * 有没有积分胶囊、以及宿主路由与文案命名空间。spec 把这些收成一个值，dock 按
 * 它各挂一条，GLM 那条是缺省值。
 */
export interface QuotaPillSpec {
  /** 取值口径来源：决定文案命名空间与变色方向。 */
  readonly provider: 'zcode' | 'minimaxi' | 'claude' | 'codex'
  /** 当前会话目录里的 provider id（如 `acp:acp-claude`）与此相等才渲染。 */
  readonly providerId?: string
  /** 模型 id 前缀匹配；providerId 已给时可以不填（Claude 的模型 id 是通用别名）。 */
  readonly prefix?: string
  /** 是否渲染积分胶囊（MiniMax/Codex/Claude 有，GLM 无）。 */
  readonly showCredit: boolean
  /** 宿主路由路径。 */
  readonly routePath: string
  /** dock 条目 id 与顺序。 */
  readonly dockId: string
  readonly dockOrder: number
}

/** GLM 那套：缺省口径，dock 注册不传 spec 时就是它。 */
export const GLM_QUOTA_PILL_SPEC: QuotaPillSpec = {
  provider: 'zcode',
  prefix: GLM_MODEL_PREFIX,
  showCredit: false,
  routePath: QUOTA_ROUTE_PATH,
  dockId: QUOTA_DOCK_ID,
  dockOrder: QUOTA_DOCK_ORDER,
}

/** MiniMax 那套：前缀 MiniMax-、多一枚积分胶囊、percent 是「剩余」。 */
export const MINIMAX_QUOTA_PILL_SPEC: QuotaPillSpec = {
  provider: 'minimaxi',
  prefix: 'MiniMax-',
  showCredit: true,
  routePath: MINIMAX_QUOTA_ROUTE_PATH,
  dockId: 'threadharbor-minimaxi-quota',
  dockOrder: 11,
}

/** Codex 那套：按目录里的 provider id 认（gpt-* 这类 id 太通用，不按前缀）。 */
export const CODEX_QUOTA_PILL_SPEC: QuotaPillSpec = {
  provider: 'codex',
  providerId: 'acp:acp-codex',
  showCredit: true,
  routePath: CODEX_QUOTA_ROUTE_PATH,
  dockId: 'threadharbor-codex-quota',
  dockOrder: 12,
}

/** Claude 那套：同按 provider id 认（模型 id 是 default/opus 这类通用别名）。 */
export const CLAUDE_QUOTA_PILL_SPEC: QuotaPillSpec = {
  provider: 'claude',
  providerId: 'acp:acp-claude',
  showCredit: true,
  routePath: CLAUDE_QUOTA_ROUTE_PATH,
  dockId: 'threadharbor-claude-quota',
  dockOrder: 13,
}

/** 全部口径：apply 按这张表各建一只轮询器、各挂一条 dock。 */
export const QUOTA_PILL_SPECS: readonly QuotaPillSpec[] = [
  GLM_QUOTA_PILL_SPEC,
  MINIMAX_QUOTA_PILL_SPEC,
  CODEX_QUOTA_PILL_SPEC,
  CLAUDE_QUOTA_PILL_SPEC,
]

/**
 * One consumed window as the host route forwards it. GLM carries used/total;
 * MiniMax a remaining percent + unlimited; Codex a used percent + window
 * length（决定标签叫「5小时」还是「周」）——optional fields so one shape serves all.
 */
export interface QuotaWindow {
  readonly kind: 'five-hour' | 'weekly'
  readonly used?: number
  readonly total?: number
  /** zcode/claude/codex: percent used; minimaxi: percent remaining. */
  readonly percent?: number
  /** minimaxi only: the window is unlimited (`status === 3`). */
  readonly unlimited?: boolean
  /** codex only: the window's length in seconds（≥3 天按「周」标）。 */
  readonly windowSeconds?: number
  readonly resetAt?: number
}

/** The quota one coding plan reports, mirroring the route's `quota` member. */
export interface QuotaWindows {
  readonly level?: string
  readonly fiveHour?: QuotaWindow
  readonly weekly?: QuotaWindow
  /** 有积分套餐才带：MiniMax/Codex 是余额，Claude 是按量已用与上限。 */
  readonly credit?: { readonly remaining?: number; readonly used?: number; readonly limit?: number }
}

/** The route's whole answer body. */
export type QuotaAnswer = { readonly ok: true; readonly quota: QuotaWindows } | { readonly ok: false; readonly error: string }

/** The model-directory snapshot shape the pill reads (upstream's directory store). */
interface QuotaDirectorySnapshot {
  readonly current: { readonly provider: string; readonly model: string } | null
}

/** 轮询周期：5 分钟一拍；宿主侧还有 30 秒应答缓存兜着。 */
const POLL_INTERVAL_MS = 300_000

/** 重置时刻的显示格式：月/日 + 时:分（周窗口重置在几天外，只写时刻会误导）。 */
let resetFormatter: Intl.DateTimeFormat | undefined

function formatReset(unixMs: number): string {
  resetFormatter ??= new Intl.DateTimeFormat(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  return resetFormatter.format(new Date(unixMs))
}

/**
 * 配额轮询器：一份共享快照 + 订阅面，供给 dock 注册的 hooks 仓。
 *
 * 快照引用稳定：内容没变的取数不换对象、不通知（无谓重渲染一票否决）。
 * 失败清空快照；原因去重——同一个原因只 report 一次，变了才再报。
 */
export interface QuotaPoller {
  subscribe(listener: () => void): () => void
  getSnapshot(): QuotaWindows | undefined
  refresh(): Promise<void>
  start(): void
  dispose(): void
}

/**
 * 建一个轮询器（不启动；apply 调 start）。
 * @param deps - 取数器、定时器与报错通道，全部可注入，测试不碰真网络真计时。
 * @returns 轮询器。
 */
export function createQuotaPoller(deps: {
  fetchQuota(): Promise<QuotaAnswer>
  setInterval?: (handler: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
  intervalMs?: number
  report?: (message: string) => void
}): QuotaPoller {
  const intervalMs = deps.intervalMs ?? POLL_INTERVAL_MS
  const setTimer = deps.setInterval ?? ((handler: () => void, ms: number) => globalThis.setInterval(handler, ms))
  const clearTimer = deps.clearInterval ?? ((handle: unknown) => { globalThis.clearInterval(handle as number) })
  const listeners = new Set<() => void>()
  let quota: QuotaWindows | undefined
  let handle: unknown
  let lastReason: string | undefined

  const notify = (): void => { for (const listener of listeners) listener() }

  const fail = (reason: string): void => {
    if (quota !== undefined) {
      quota = undefined
      notify()
    }
    if (reason !== lastReason) {
      lastReason = reason
      deps.report?.(reason)
    }
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: () => quota,
    async refresh() {
      try {
        const answer = await deps.fetchQuota()
        if (!answer.ok) {
          fail(answer.error)
          return
        }
        lastReason = undefined
        if (quota !== undefined && JSON.stringify(quota) === JSON.stringify(answer.quota)) return
        quota = answer.quota
        notify()
      } catch (error) {
        fail(`GLM quota poll failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
    start() {
      handle = setTimer(() => { void this.refresh() }, intervalMs)
      void this.refresh()
    },
    dispose() {
      if (handle !== undefined) clearTimer(handle)
      handle = undefined
    },
  }
}

/**
 * 同源取一次宿主路由，折成 QuotaAnswer；任何故障（非 JSON、坏状态码、网络
 * 拒绝）都折成 ok:false 的原因，绝不抛出——轮询器的 catch 只是最后一道网。
 * @param fetchImpl - 取数实现；缺省全局 fetch，测试注入假件。
 * @param routePath - 宿主路由路径；缺省 GLM 那条，MiniMax 传 MINIMAX_QUOTA_ROUTE_PATH。
 * @returns 取数函数。
 */
export function routeQuotaFetcher(fetchImpl: typeof fetch = fetch, routePath: string = QUOTA_ROUTE_PATH): () => Promise<QuotaAnswer> {
  return async () => {
    try {
      const response = await fetchImpl(routePath, { headers: { accept: 'application/json' } })
      let body: unknown
      try {
        body = await response.json()
      } catch (error) {
        return { ok: false, error: `HTTP ${String(response.status)}: the quota route answered no JSON (${error instanceof Error ? error.message : String(error)})` }
      }
      if (isRecord(body) && body['ok'] === true && isRecord(body['quota'])) {
        return { ok: true, quota: body['quota'] as QuotaWindows }
      }
      if (isRecord(body) && body['ok'] === false && typeof body['error'] === 'string') {
        return { ok: false, error: body['error'] }
      }
      return { ok: false, error: `HTTP ${String(response.status)}: the quota route answered an unrecognised body` }
    } catch (error) {
      return { ok: false, error: `quota route request failed: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
}

/**
 * 渲染器绑定的快照钩子。真机上 ui-renderer 用 useSyncExternalStoreWithSelector
 * 把注入的 hooks 源包成 (selector, isEqual) => S：**每次调用都必须带选择器**，
 * 空参调用会抛 "selector is not a function"，条目被槽位错误边界收成空块。
 * 这里只需要恒等选择器，所以按「选择器必填」声明，形状与真机一致。
 */
type SnapshotHook<T> = <S>(selector: (value: T | undefined) => S) => S

/**
 * Render the quota pills for the composer dock.
 * @param props - the two reactive seats (framework-bound selector hooks in
 * production, plain functions in tests), the subagent visibility flag, the
 * locale seat, and the provider spec (defaults to GLM).
 * @returns the pills, or null whenever the row should not appear.
 */
export function QuotaPillRow({ useQuota, useModelDirectory, visible = true, t = fallbackT, spec = GLM_QUOTA_PILL_SPEC }: {
  useQuota?: SnapshotHook<QuotaWindows>
  useModelDirectory?: SnapshotHook<QuotaDirectorySnapshot>
  visible?: boolean
  t?: RuntimeT
  spec?: QuotaPillSpec
}): ReactNode {
  // 钩子必须每次渲染都按同一顺序调用：同一挂载实例会经历模型从非本组切到本组，
  // 条件调用让 hook 数 1→2，React #310 会把整个 dock 条目收成空块。
  // （2026-10-30 真机：会话里切 ZCode 后胶囊消失。）
  const directory = useModelDirectory?.((value) => value)
  const model = directory?.current?.model
  const providerId = directory?.current?.provider
  const quota = useQuota?.((value) => value)
  if (visible === false) return null
  // 认谁：优先按目录里的 provider id（preset id，如 acp:acp-claude——Claude 的
  // 模型 id 是 default/opus 这类通用别名，按前缀认会误伤别家）；没给 providerId
  // 的口径（GLM/MiniMax）按模型 id 前缀认。
  const mine = spec.providerId !== undefined
    ? providerId === spec.providerId
    : model !== undefined && model.startsWith(spec.prefix ?? '')
  if (!mine) return null
  if (quota === undefined) return null
  const windows = [quota.fiveHour, quota.weekly].filter((window): window is QuotaWindow => window !== undefined)
  const credit = spec.showCredit ? quota.credit : undefined
  if (windows.length === 0 && credit === undefined) return null
  return createElement('div', {
    'data-quota-pills': true,
    [`data-${spec.provider}-quota`]: true,
    style: {
      display: 'flex',
      justifyContent: 'center',
      gap: '12px',
      fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
      color: 'var(--dsw-alias-label-tertiary)',
    },
  },
    formatResetLine(quota.fiveHour?.resetAt, t) !== null && createElement('div', {
      key: 'reset',
      style: { textAlign: 'center', opacity: 0.8, marginBottom: '2px' },
    }, formatResetLine(quota.fiveHour?.resetAt, t)),
    ...windows.map(window => pillOf(window, t, spec)),
    ...(credit === undefined ? [] : [creditPillOf(credit, t, spec)]),
  )
}

/** 重置时刻那行：只在 5 小时窗口带 resetAt 时出现（周窗口重置在几天外，写时刻会误导）。 */
function formatResetLine(resetAt: number | undefined, t: RuntimeT): string | null {
  return resetAt === undefined ? null : t('quota.resetAt', { reset: formatReset(resetAt) })
}

/** 文案命名空间：各家窗口标题各有一套（percent 口径在标题里写明）。 */
function titleKey(provider: QuotaPillSpec['provider'], fiveHour: boolean):
  | 'quota.fiveHour.title'
  | 'quota.weekly.title'
  | 'quota.minimaxi.fiveHour.title'
  | 'quota.minimaxi.weekly.title'
  | 'quota.claude.fiveHour.title'
  | 'quota.claude.weekly.title'
  | 'quota.codex.window.title' {
  if (provider === 'minimaxi') return fiveHour ? 'quota.minimaxi.fiveHour.title' : 'quota.minimaxi.weekly.title'
  if (provider === 'claude') return fiveHour ? 'quota.claude.fiveHour.title' : 'quota.claude.weekly.title'
  if (provider === 'codex') return 'quota.codex.window.title'
  return fiveHour ? 'quota.fiveHour.title' : 'quota.weekly.title'
}

/** One pill: icon + 「5小时 1%」，悬停给详情与重置时刻，按用量变色。 */
function pillOf(window: QuotaWindow, t: RuntimeT, spec: QuotaPillSpec): ReactNode {
  const fiveHour = window.kind === 'five-hour'
  const unlimited = window.unlimited === true
  const percent = window.percent ?? 0
  // zcode/claude/codex 的 percent 是「已用」：越高越红。minimaxi 的是「剩余」：越低越红。
  const tone = unlimited
    ? undefined
    : spec.provider === 'minimaxi'
      ? (percent <= 20 ? 'danger' : percent <= 50 ? 'warn' : undefined)
      : (percent >= 80 ? 'danger' : percent >= 50 ? 'warn' : undefined)
  const color = tone === 'danger'
    ? 'var(--dsw-static-red-500)'
    : tone === 'warn'
      ? 'var(--dsw-alias-state-warn-label)'
      : undefined
  const reset = window.resetAt === undefined ? '' : t('quota.resetAt', { reset: formatReset(window.resetAt) })
  const title = unlimited
    ? t('quota.minimaxi.unlimitedTitle') + reset
    : spec.provider === 'zcode'
      // GLM 的标题带已用/总量；其余家只有百分比口径。
      ? t(titleKey(spec.provider, fiveHour), {
        used: String(window.used ?? 0),
        total: String(window.total ?? 0),
      }) + reset
      : t(titleKey(spec.provider, fiveHour), { percent: String(Math.round(percent)) }) + reset
  const label = unlimited
    ? t('quota.minimaxi.unlimited')
    : t(fiveHour ? 'quota.fiveHour.label' : 'quota.weekly.label', { percent: String(Math.round(percent)) })
  return createElement('span', {
    key: window.kind,
    title,
    ...(tone === undefined ? {} : { 'data-tone': tone }),
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      padding: '1px 8px',
      borderRadius: '999px',
      fontVariantNumeric: 'tabular-nums',
      whiteSpace: 'nowrap',
      ...(color === undefined ? {} : { color }),
    },
  },
    createElement(fiveHour ? IconGaugeOutlineRegular : IconDatabaseOutlineRegular),
    createElement('span', null, label))
}

/**
 * 积分胶囊：MiniMax/Codex 是余额（「积分 0」），Claude 是按量已用
 * （「按量 4.5 / 100」）。文案命名空间跟 provider 走。
 */
function creditKeys(provider: QuotaPillSpec['provider']): {
  credit: 'quota.minimaxi.credit' | 'quota.codex.credit' | 'quota.claude.credit'
  title: 'quota.minimaxi.creditTitle' | 'quota.codex.creditTitle' | 'quota.claude.creditTitle'
} {
  if (provider === 'claude') return { credit: 'quota.claude.credit', title: 'quota.claude.creditTitle' }
  if (provider === 'codex') return { credit: 'quota.codex.credit', title: 'quota.codex.creditTitle' }
  return { credit: 'quota.minimaxi.credit', title: 'quota.minimaxi.creditTitle' }
}

function creditPillOf(credit: { readonly remaining?: number; readonly used?: number; readonly limit?: number }, t: RuntimeT, spec: QuotaPillSpec): ReactNode {
  const keys = creditKeys(spec.provider)
  const detail = credit.remaining !== undefined
    ? String(credit.remaining)
    : `${credit.used ?? 0}${credit.limit === undefined ? '' : ` / ${credit.limit}`}`
  const title = spec.provider === 'claude'
    ? t('quota.claude.creditTitle', { used: String(credit.used ?? 0), limit: String(credit.limit ?? '') })
    : t(keys.title, { remaining: String(credit.remaining ?? '') })
  return createElement('span', {
    key: 'credit',
    title,
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      padding: '1px 8px',
      borderRadius: '999px',
      fontVariantNumeric: 'tabular-nums',
      whiteSpace: 'nowrap',
    },
  },
    createElement(IconGaugeOutlineRegular),
    createElement('span', null, t(keys.credit), ' ', createElement('span', null, detail)))
}

/** The dock slot face this registration needs; structural, like every slot host here. */
type DockSlotHost = {
  inject(key: string, callback: () => unknown): unknown
  register(options: {
    name: string
    id?: string
    order?: number
    locale?: string
    inject?: (sessionId: string) => unknown
  }, component: unknown): () => void
}

/** The two services the visibility and model checks read; both optional host services. */
export interface QuotaPillServices {
  readonly modelDirectories?: { directoryFor(sessionId: string): { readonly store: unknown } }
  readonly sessions?: { subagentAddress(sessionId: string): unknown }
}

/**
 * 一次会话的目录 store；服务已经没了就当没有目录。
 *
 * @param service - the model directory service, if the host still has one.
 * @param sessionId - the session whose directory is wanted.
 * @returns the directory's store, or undefined when there is none to read.
 */
function directoryStoreOf(
  service: QuotaPillServices['modelDirectories'],
  sessionId: string,
): unknown {
  if (service === undefined) return undefined
  try {
    return service.directoryFor(sessionId)?.store
  } catch (error) {
    // 宿主日志在浏览器里看不见；这一档的线索只能留在这里（模型列表同时空着，
    // 胶囊是唯一会说「连接已经断了」的地方）。
    console.warn(`[threadharbor] zcode quota: the model directory service is gone (${error instanceof Error ? error.message : String(error)}) — the pills are hidden`)
    return undefined
  }
}

/**
 * Register the quota pills into the composer dock (a list slot, session scope),
 * next to the official stats pills. The inject face hands the renderer two bare
 * observables (quota poller, model directory) plus the subagent visibility
 * flag — the renderer binds `useZcodeQuota` / `useZcodeDirectory` from them.
 *
 * @param slots - the slot host (`ctx.slots`).
 * @param poller - the shared quota poller (created once in apply).
 * @param services - the host services, when present.
 * @param spec - 取值口径；缺省 GLM。MiniMax 传 MINIMAX_QUOTA_PILL_SPEC。
 * @returns the disposer of the registration.
 */
export function registerQuotaDockPills(
  slots: DockSlotHost,
  poller: QuotaPoller,
  services: Partial<QuotaPillServices>,
  spec: QuotaPillSpec = GLM_QUOTA_PILL_SPEC,
): () => void {
  return slots.inject('conversation.composer.dock', () => slots.register(
    {
      name: 'conversation.composer.dock',
      id: spec.dockId,
      order: spec.dockOrder,
      locale: NAMESPACE,
      inject: (sessionId: string) => {
        // 服务可能已经没了（连接重建后旧实例被处置）：一调就抛「inactive
        // context」，而这里抛出去，崩的是**座位条目**——2026-10-20 桌面版：
        // 输入框下面的 dock 崩了，连带座位一起带走。取不到就当没有目录：
        // 胶囊不画，其它照常。
        const directory = directoryStoreOf(services.modelDirectories, sessionId)
        const visible = services.sessions?.subagentAddress(sessionId) === undefined
        return {
          visible,
          hooks: {
            zcodeQuota: poller,
            ...(directory === undefined ? {} : { zcodeDirectory: directory }),
          },
        }
      },
    },
    (props: {
      readonly useZcodeQuota?: SnapshotHook<QuotaWindows>
      readonly useZcodeDirectory?: SnapshotHook<QuotaDirectorySnapshot>
      readonly visible?: boolean
      readonly t?: RuntimeT
    }) => createElement(QuotaPillRow, {
      ...(props.useZcodeQuota === undefined ? {} : { useQuota: props.useZcodeQuota }),
      ...(props.useZcodeDirectory === undefined ? {} : { useModelDirectory: props.useZcodeDirectory }),
      ...(props.visible === undefined ? {} : { visible: props.visible }),
      ...(props.t === undefined ? {} : { t: props.t }),
      spec,
    }),
  )) as () => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
