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

/** dock 里的条目 id 与顺序：排在官方 stats（order 0）之后。 */
export const QUOTA_DOCK_ID = 'threadharbor-zcode-quota'
export const QUOTA_DOCK_ORDER = 10

/** zcode 那组模型在目录里的 id 前缀；选了它才轮到配额胶囊出场。 */
const GLM_MODEL_PREFIX = 'GLM-'

/** One consumed window as the host route forwards it. */
export interface QuotaWindow {
  readonly kind: 'five-hour' | 'weekly'
  readonly used: number
  readonly total: number
  readonly percent: number
  readonly resetAt?: number
}

/** The quota one coding plan reports, mirroring the route's `quota` member. */
export interface QuotaWindows {
  readonly level?: string
  readonly fiveHour?: QuotaWindow
  readonly weekly?: QuotaWindow
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
 * @returns 取数函数。
 */
export function routeQuotaFetcher(fetchImpl: typeof fetch = fetch): () => Promise<QuotaAnswer> {
  return async () => {
    try {
      const response = await fetchImpl(QUOTA_ROUTE_PATH, { headers: { accept: 'application/json' } })
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
 * production, plain functions in tests), the subagent visibility flag, and the
 * locale seat.
 * @returns two pills, or null whenever the row should not appear.
 */
export function QuotaPillRow({ useQuota, useModelDirectory, visible = true, t = fallbackT }: {
  useQuota?: SnapshotHook<QuotaWindows>
  useModelDirectory?: SnapshotHook<QuotaDirectorySnapshot>
  visible?: boolean
  t?: RuntimeT
}): ReactNode {
  if (visible === false) return null
  const model = useModelDirectory?.((value) => value)?.current?.model
  if (model === undefined || !model.startsWith(GLM_MODEL_PREFIX)) return null
  const quota = useQuota?.((value) => value)
  if (quota === undefined) return null
  const windows = [quota.fiveHour, quota.weekly].filter((window): window is QuotaWindow => window !== undefined)
  if (windows.length === 0) return null
  return createElement('div', {
    'data-zcode-quota': true,
    style: {
      display: 'flex',
      justifyContent: 'center',
      gap: '12px',
      fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
      color: 'var(--dsw-alias-label-tertiary)',
    },
  }, ...windows.map(window => pillOf(window, t)))
}

/** One pill: icon + 「5小时 1%」，悬停给已用/总量与重置时刻，按用量变色。 */
function pillOf(window: QuotaWindow, t: RuntimeT): ReactNode {
  const fiveHour = window.kind === 'five-hour'
  const tone = window.percent >= 80 ? 'danger' : window.percent >= 50 ? 'warn' : undefined
  const color = tone === 'danger'
    ? 'var(--dsw-static-red-500)'
    : tone === 'warn'
      ? 'var(--dsw-alias-state-warn-label)'
      : undefined
  const reset = window.resetAt === undefined ? '' : t('quota.resetAt', { reset: formatReset(window.resetAt) })
  const title = t(fiveHour ? 'quota.fiveHour.title' : 'quota.weekly.title', {
    used: String(window.used),
    total: String(window.total),
  }) + reset
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
    createElement('span', null, t(fiveHour ? 'quota.fiveHour.label' : 'quota.weekly.label', {
      percent: String(Math.round(window.percent)),
    })))
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
 * Register the quota pills into the composer dock (a list slot, session scope),
 * next to the official stats pills. The inject face hands the renderer two bare
 * observables (quota poller, model directory) plus the subagent visibility
 * flag — the renderer binds `useZcodeQuota` / `useZcodeDirectory` from them.
 *
 * @param slots - the slot host (`ctx.slots`).
 * @param poller - the shared quota poller (created once in apply).
 * @param services - the host services, when present.
 * @returns the disposer of the registration.
 */
export function registerQuotaDockPills(
  slots: DockSlotHost,
  poller: QuotaPoller,
  services: Partial<QuotaPillServices>,
): () => void {
  return slots.inject('conversation.composer.dock', () => slots.register(
    {
      name: 'conversation.composer.dock',
      id: QUOTA_DOCK_ID,
      order: QUOTA_DOCK_ORDER,
      locale: NAMESPACE,
      inject: (sessionId: string) => {
        const directory = services.modelDirectories?.directoryFor(sessionId)?.store
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
    }),
  )) as () => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
