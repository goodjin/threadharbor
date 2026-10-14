/**
 * 手机配对 section：桌面侧栏上取「手机配对网址」的那块面板。
 *
 * 数据面只有一条同源 GET（ssh-deploy.ts 是同一个路数：路径字面量 + 裸
 * fetch，同源默认带上的会话 cookie 就是准入凭证）：宿主的 pair-url 接口
 * 应答 200 `{url}`，`url` 里铸着进程配对令牌——它只进这条面板的状态、
 * 只画给这个已准入的桌面会话看，从不进日志。宿主没配 mobileOrigin 时
 * 应答 500 `mobile-origin-unset`，网络断了也一样：面板把这些落成配置
 * 指引文案，说明原因，而不是空着或者炸掉。
 *
 * 注册面就是主机面板在用的那一套（client/index.ts 的 registerPanelSlots）：
 * `sidebar.panellist` 出行、`main` 出面板体，一个 id 配一个 key。组件从
 * 注入的 store 读状态（照 switch-progress 的路子），测试里 renderToString
 * 就能断言画面，不需要浏览器。
 */

// qrcode 的包主入口按 Node 解析：它会带上写 PNG 文件的渲染器（require('fs')），
// 混进浏览器包就把整页带崩。打包侧在 tsdown 配置里把 qrcode 定点映射到包自带的
// 浏览器入口（canvas 渲染，无 fs），源码与 Node 测试继续走正常入口。
import { toDataURL } from 'qrcode'
import { createElement, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
// Type-only: ui-layout declares `main`，ui-sidebar 声明 `sidebar.panellist`，
// 槽位名拼错了在这里就是编译错误，而不是静默的白页。
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PropsLocale, PropsRuntime, SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { NAMESPACE } from './locales.ts'

/**
 * pair-url 的路径，与 dsh-mobile-entry/src/pair-url.ts 的 `PAIR_URL_PATH`
 * 互为孪生常量——宿主注册用那边这份，这边按字面量取同源接口；改名时两处
 * 一起 grep（tests/pairing-panel.spec.ts 把字面量钉在测试里）。
 */
export const PAIR_URL_PATH = '/threadharbor/mobile/pair-url'

/** 侧栏行与主面板共用的 id；主机面板是 threadharbor-rollup，这是第二条。 */
export const PAIRING_PANEL_ID = 'threadharbor-pairing'
/** 行序：100 是「各主机」，手机配对跟在它下面。 */
export const PAIRING_PANEL_ORDER = 101

/** 面板的四个状态：取回中、就绪（二维码 + 网址）、两种指引。 */
export type PairingState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly url: string; readonly qrDataUrl: string }
  | { readonly kind: 'origin-unset'; readonly detail: string }
  | { readonly kind: 'unavailable'; readonly detail: string }

/** 面板读的那条状态：快照被缓存，渲染可以放心当外部源读。 */
export type PairingStore = {
  getSnapshot(): PairingState
  subscribe(listener: () => void): () => void
}

/** 写侧只归取回流程：装配时拿到的是带 publish 的那条。 */
export type PairingStoreWriter = PairingStore & { publish(next: PairingState): void }

/** 一条配对状态：读者见 PairingStore，写者见 publish。 */
export function createPairingStore(): PairingStoreWriter {
  let snapshot: PairingState = { kind: 'loading' }
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    publish: next => {
      // 快照整体替换：读者拿到的引用变了，useSyncExternalStore 才会重画。
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
  }
}

/** 同源取回的最小面：真 fetch 满足它，测试塞假件。 */
export type SameOriginFetch = (path: string) => Promise<{ status: number; json(): Promise<unknown> }>

/** pair-url 一次取回的结论：网址，或两种失败之一（都不含网址本身）。 */
export type PairUrlOutcome =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly kind: 'origin-unset' | 'unavailable'; readonly detail: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** 同源 fetch 的默认实现：裸路径，GET，凭据按浏览器同源默认带上。 */
const sameOriginFetch: SameOriginFetch = path => fetch(path)

/**
 * 取一次 pair-url 并把应答铸成结论。
 *
 * 任何一步不合约定（打不通、非 JSON、形状不对）都归入 `unavailable`，
 * 不向页面抛异常——面板要的是「说明原因」，不是崩溃。
 */
export async function requestPairUrl(fetchLike: SameOriginFetch = sameOriginFetch): Promise<PairUrlOutcome> {
  let response: { status: number; json(): Promise<unknown> }
  try {
    response = await fetchLike(PAIR_URL_PATH)
  } catch (error: unknown) {
    return { ok: false, kind: 'unavailable', detail: messageOf(error) }
  }
  let body: unknown
  try {
    body = await response.json()
  } catch (error: unknown) {
    return { ok: false, kind: 'unavailable', detail: `HTTP ${response.status}：应答不是 JSON（${messageOf(error)}）` }
  }
  if (isRecord(body) && body['error'] === 'mobile-origin-unset') {
    return { ok: false, kind: 'origin-unset', detail: `HTTP ${response.status}` }
  }
  const url = isRecord(body) ? body['url'] : undefined
  if (response.status === 200 && typeof url === 'string' && url !== '') {
    return { ok: true, url }
  }
  return { ok: false, kind: 'unavailable', detail: `HTTP ${response.status}：应答不是约定的形状` }
}

/** 网址 → 二维码图片（PNG data URL）；真件是 qrcode，测试可注入假件。 */
export type PairQrRenderer = (text: string) => Promise<string>

const defaultRenderQr: PairQrRenderer = text => toDataURL(text, { margin: 2, width: 240 })

/** 槽位宿主的窄面：`inject` 等声明，`register` 落座，与主机面板同一张脸。 */
export type PairingSlotHost = {
  inject(key: string, callback: () => (() => void) | Iterable<() => void, void, void>): () => void
  register: SlotCore['register']
}

/** 起好之后交还的东西：状态给组件读，dispose 撤注册、晾着迟到的取回。 */
export type PairingSurface = {
  readonly store: PairingStore
  dispose(): void
}

/** startPairingSurface 的参数：注册面必给，其余都有真件默认。 */
export type PairingSurfaceParams = {
  slots: PairingSlotHost
  /** 侧栏行的标签，随活动语言走（entry 里传 `() => t('pairing.label')`）。 */
  label: () => string
  /** pair-url 取回；缺省用同源 fetch 打 {@link PAIR_URL_PATH}。 */
  requestPairUrl?: () => Promise<PairUrlOutcome>
  /** 二维码渲染；缺省用 qrcode 画 PNG data URL。 */
  renderQr?: PairQrRenderer
  /** 失败原因的去处；缺省吞掉（面板上会说）。绝不收带令牌的网址。 */
  log?: (message: string) => void
}

/**
 * 注册「手机配对」并取回一次网址。
 *
 * 取回在装配时开始：手机配对是低频设置动作，但一次取回的成本就是一条
 * 已准入的 GET，失败也只是面板上的指引。dispose 之后才落地的应答不改
 * 状态——面板都没了，改给谁看。
 */
export function startPairingSurface(params: PairingSurfaceParams): PairingSurface {
  const store = createPairingStore()
  const requester = params.requestPairUrl ?? (() => requestPairUrl())
  const renderQr = params.renderQr ?? defaultRenderQr
  const log = params.log ?? (() => {})
  let disposed = false

  // dispose 之后落地的状态不再上屏：面板都没了，改给谁看。
  const publish = (next: PairingState): void => {
    if (disposed) return
    store.publish(next)
  }

  const disposeMain = params.slots.inject('main', () => params.slots.register(
    // locale 声明让框架给组件合成 t 座位；store 从 inject 面递进去。
    { name: 'main', key: PAIRING_PANEL_ID, locale: NAMESPACE, inject: () => ({ pairing: store }) },
    PairingPanel,
  ))
  const disposeRow = params.slots.inject('sidebar.panellist', () => params.slots.register(
    { name: 'sidebar.panellist', id: PAIRING_PANEL_ID, order: PAIRING_PANEL_ORDER, label: params.label },
    PairingIcon,
  ))

  const load = async (): Promise<void> => {
    let outcome: PairUrlOutcome
    try {
      outcome = await requester()
    } catch (error: unknown) {
      // 取回函数自己不该抛，但抛了也不能炸掉装配：按不可达说原因。
      outcome = { ok: false, kind: 'unavailable', detail: messageOf(error) }
    }
    if (outcome.ok) {
      let qrDataUrl: string
      try {
        qrDataUrl = await renderQr(outcome.url)
      } catch (error: unknown) {
        log(`手机配对：二维码画不出来：${messageOf(error)}`)
        publish({ kind: 'unavailable', detail: messageOf(error) })
        return
      }
      publish({ kind: 'ready', url: outcome.url, qrDataUrl })
      return
    }
    // 日志只说原因（HTTP 状态、错误消息），网址与令牌一个字都不出现。
    log(`手机配对：pair-url 取不到（${outcome.kind}）：${outcome.detail}`)
    publish({ kind: outcome.kind, detail: outcome.detail })
  }
  void load()

  return {
    store,
    dispose: () => {
      disposed = true
      disposeMain()
      disposeRow()
    },
  }
}

/** 组件的 props：注册注入的 store，加框架合成的 t 座位。 */
export type PairingPanelProps = {
  readonly pairing: PairingStore
} & PropsLocale<typeof NAMESPACE>

const urlStyle: CSSProperties = { wordBreak: 'break-all', userSelect: 'all', margin: '8px 0' }
const detailStyle: CSSProperties = { opacity: 0.75, fontSize: '0.9em' }

/**
 * 面板体：取回中一句话；就绪画二维码 + 网址；两种失败各自说清原因和
 * 下一步。所有文案走词典（locales.ts），这里只有结构。
 */
export function PairingPanel(props: PairingPanelProps): ReturnType<typeof createElement> {
  const state = useSyncExternalStore(props.pairing.subscribe, props.pairing.getSnapshot, props.pairing.getSnapshot)
  const t = props.t
  if (state.kind === 'loading') {
    return createElement(
      'div',
      { 'data-pairing-state': 'loading' },
      createElement('p', { role: 'status' }, t('pairing.loading')),
    )
  }
  if (state.kind === 'ready') {
    return createElement(
      'div',
      { 'data-pairing-state': 'ready' },
      createElement('h2', null, t('pairing.ready.title')),
      createElement(
        'div',
        { 'data-pairing-qr': '' },
        createElement('img', { src: state.qrDataUrl, alt: t('pairing.qr.alt'), width: 240, height: 240 }),
      ),
      createElement('p', null, t('pairing.url.hint')),
      createElement('p', { 'data-pair-url': '', style: urlStyle }, state.url),
    )
  }
  return createElement(
    'div',
    { 'data-pairing-state': state.kind, 'data-pairing-guidance': '' },
    createElement('h2', null, state.kind === 'origin-unset' ? t('pairing.guidance.originTitle') : t('pairing.guidance.unreachableTitle')),
    createElement('p', null, state.kind === 'origin-unset' ? t('pairing.guidance.origin') : t('pairing.guidance.unreachable')),
    createElement('p', { 'data-pairing-detail': '', style: detailStyle }, t('pairing.guidance.detail', { detail: state.detail })),
  )
}

/** 侧栏行的图形：一台手机，自绘不依赖图标集。 */
export function PairingIcon(props: PropsRuntime<'sidebar.panellist'>): ReturnType<typeof createElement> {
  return createElement(
    'svg',
    {
      width: props.size,
      height: props.size,
      viewBox: '0 0 16 16',
      fill: 'none',
      'aria-hidden': 'true',
      style: { opacity: props.active ? 1 : 0.75 },
    },
    createElement('rect', { x: 4.5, y: 1.5, width: 7, height: 13, rx: 1.5, stroke: 'currentColor' }),
    createElement('line', { x1: 7, y1: 12.5, x2: 9, y2: 12.5, stroke: 'currentColor', strokeLinecap: 'round' }),
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
