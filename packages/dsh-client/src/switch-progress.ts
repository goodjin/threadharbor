/**
 * 切换过程看得见的那一段。
 *
 * 切换 agent 换的是整个会话：旧会话的对话留在原地，新会话是另一条记录，
 * 界面把整块内容换掉。中间那段空白过去没有任何交代——用户看到的是"切了，
 * 然后就没了"。这个模块把那段空白补上，并且顺手把它填满：
 *
 * - 进度条挂在窗口浮层（`shell.overlay`）上，不在会话里。会话一换就跟着
 *   消失的进度条等于没有进度条。
 * - 进度条走的同时，先把新会话的首屏读出来（`ctx.sessions.retain` 会启动
 *   那次读取，`ready` 是它落定的那一刻），读完了再跳——跳过去的时候内容
 *   已经在屏幕上，不再是"跳过去再看着它空着转圈"。
 * - 首屏读失败或一直没读完都不许把跳转卡死：这是进度，不是闸门。读不出
 *   来就照跳，让新会话自己显示它那套加载提示。
 */

// Type-only: ui-layout declares `shell.overlay` (the frame's floating layer)
// and ui-renderer contributes `ctx.slots`; without these the seat name reads
// as a typo, which is the one thing a registration must never be.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsLocale, PropsRuntime, SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { createElement, useSyncExternalStore } from 'react'
import styles from './switch-progress.module.css'
import { NAMESPACE } from './locales.ts'
import type { ProgressKey } from './locales.ts'

/** Where the switch stands: the new session is being asked for, or is here. */
export type SwitchProgressPhase = 'preparing' | 'loading' | 'ready'

/** One switch in flight. */
export interface SwitchProgress {
  /** The session that now carries the conversation. */
  readonly sessionId: string
  /** The preset the conversation moved to. */
  readonly target: string
  readonly phase: SwitchProgressPhase
}

/** What the layer reads; a switch in flight, or none. */
export interface SwitchProgressState {
  readonly current: SwitchProgress | undefined
}

/** What the layer writes; each step is named so the screen can say where it is. */
export type SwitchProgressActions = {
  begin(target: { readonly sessionId: string; readonly target: string }): void
  phase(phase: SwitchProgressPhase): void
  /** Take the bar away. A `sessionId` scopes it to that switch and nothing else. */
  finish(sessionId?: string): void
}

/** The published surface: a readable snapshot plus its subscription. */
export type SwitchProgressStore = {
  getSnapshot(): SwitchProgressState
  subscribe(listener: () => void): () => void
  readonly actions: SwitchProgressActions
}

/** How long the new session's first page may be waited for before the jump goes anyway. */
export const PRELOAD_TIMEOUT_MS = 4_000
/** The beat between "loaded" and the jump, so the finished bar is perceivable. */
export const SETTLE_MS = 250
/** How long the preloaded reference is kept past the jump; the workspace takes over inside it. */
export const HOLD_MS = 4_000
/** How long the bar stays up after the jump, covering the swap itself. */
export const FINISH_DELAY_MS = 600

/** The id this surface occupies in the frame's floating layer. */
const LAYER_ID = 'threadharbor-switch-progress'

/** What one step says on screen; the target session's new agent names itself. */
const PHASE_KEY: Record<SwitchProgressPhase, ProgressKey> = {
  preparing: 'progress.preparing',
  loading: 'progress.loading',
  ready: 'progress.ready',
}

/**
 * The one published switch state.
 *
 * Plain observable state, no timers: what is showing is a fact, and the
 * preloading that moves it along is the surface's business, not the store's.
 */
export function createSwitchProgressStore(): SwitchProgressStore {
  let snapshot: SwitchProgressState = { current: undefined }
  const listeners = new Set<() => void>()
  const publish = (next: SwitchProgressState): void => {
    snapshot = next
    for (const listener of [...listeners]) listener()
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    actions: {
      begin: ({ sessionId, target }) => { publish({ current: { sessionId, target, phase: 'preparing' } }) },
      phase: (phase) => {
        const current = snapshot.current
        if (current === undefined || current.phase === phase) return
        publish({ current: { ...current, phase } })
      },
      finish: (sessionId) => {
        const current = snapshot.current
        if (current === undefined) return
        // A late timer from an abandoned switch must not take down the one
        // replacing it.
        if (sessionId !== undefined && current.sessionId !== sessionId) return
        publish({ current: undefined })
      },
    },
  }
}

/** Component props: the framework runtime share, the locale `t` seat, and the store the registration injects. */
export type SwitchProgressLayerProps = PropsRuntime<'shell.overlay'>
  & PropsLocale<typeof NAMESPACE>
  & { progress: SwitchProgressStore }

/**
 * The bar itself: a line along the top of the frame and one line of text.
 *
 * Returns nothing when no switch is in flight — this layer is mounted for the
 * page's whole life, so idle has to cost no pixels.
 */
export function SwitchProgressLayer(props: SwitchProgressLayerProps): ReturnType<typeof createElement> | null {
  const store = props.progress
  const current = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot).current
  if (current === undefined) return null
  const text = props.t(PHASE_KEY[current.phase], { target: current.target })
  return createElement(
    'div',
    { className: styles.layer, 'data-phase': current.phase },
    createElement(
      'div',
      {
        className: styles.bar,
        role: 'progressbar',
        'aria-label': text,
        'aria-valuetext': text,
      },
      createElement('div', { className: styles.barRun }),
    ),
    createElement('div', { className: styles.pill, role: 'status' }, text),
  )
}

/** The part of the session object layer this surface uses, read structurally. */
type SessionsFace = {
  retain(target: string, options: { readonly source: string }): {
    readonly ready: Promise<unknown>
    release(): void
  }
}

/** The browser context, narrowed to what the surface reads. */
export type SwitchProgressContext = {
  logger(name: string): { info(message: string): void; warn(message: string): void }
  get(name: string): unknown
}

/** The slot host, the same narrow face the panel and the notice register through. */
export type SwitchProgressSlotHost = {
  inject(key: string, callback: () => (() => void) | Iterable<() => void, void, void>): () => void
  register: SlotCore['register']
}

/** What the caller gets back: show the bar, load the new session, then let it jump. */
export type SwitchProgressSurface = {
  prepare(target: { readonly sessionId: string; readonly target: string }): Promise<void>
}

/**
 * Read the session object layer, or say it is not there.
 *
 * A host without it still gets the bar and the jump; only the preloading is
 * missing, which is the same degradation the notice already has.
 */
function sessionsOf(ctx: SwitchProgressContext): SessionsFace | undefined {
  let service: unknown
  try {
    service = ctx.get('sessions')
  } catch {
    return undefined
  }
  const retain = (service as { retain?: unknown } | undefined)?.retain
  if (typeof retain !== 'function') return undefined
  return service as SessionsFace
}

/** Wait for one promise, but never longer than the budget. */
async function within(promise: Promise<unknown>, ms: number): Promise<void> {
  await Promise.race([
    promise.then(() => {}, () => {}),
    new Promise<void>(resolve => { setTimeout(resolve, ms) }),
  ])
}

const wait = (ms: number): Promise<void> => new Promise<void>(resolve => { setTimeout(resolve, ms) })

/**
 * Put the bar up, load the new session's first page, and let the caller jump
 * once that is done — or once the budget is spent, whichever comes first.
 *
 * The preloaded reference is held past the jump: releasing it before the
 * workspace has opened the session tears the very window down that was just
 * loaded, and the user lands on the loading state the preload was meant to
 * avoid.
 * @param params - the page context, the shared store, and the slot host.
 * @returns the `prepare` the switched-turn notice calls before it jumps.
 */
export function startSwitchProgressSurface(params: {
  readonly ctx: SwitchProgressContext
  readonly store: SwitchProgressStore
  readonly slots: SwitchProgressSlotHost
}): SwitchProgressSurface {
  const { ctx, store, slots } = params
  slots.inject('shell.overlay', () => slots.register(
    // `locale` puts the framework-synthesized `t` seat on the layer's props;
    // the dictionaries themselves register in the entry (locales.ts owns them).
    { name: 'shell.overlay', id: LAYER_ID, locale: NAMESPACE, inject: () => ({ progress: store }) },
    SwitchProgressLayer,
  ))
  return {
    async prepare({ sessionId, target }): Promise<void> {
      const sessions = sessionsOf(ctx)
      store.actions.begin({ sessionId, target })
      let reference: ReturnType<SessionsFace['retain']> | undefined
      if (sessions !== undefined) {
        try {
          reference = sessions.retain(sessionId, { source: 'agentSwitch' })
        } catch (error) {
          // A session the client cannot address (created and dropped between
          // the handover and this call) is not a reason to keep the user in a
          // conversation that is no longer theirs.
          ctx.logger('threadharbor-client').warn(
            `agent-switch progress: session ${sessionId} cannot be preloaded — ${String(error)}; jumping without it`,
          )
        }
      }
      if (reference !== undefined) {
        store.actions.phase('loading')
        await within(reference.ready, PRELOAD_TIMEOUT_MS)
      }
      store.actions.phase('ready')
      await wait(SETTLE_MS)
      if (reference !== undefined) {
        setTimeout(() => { reference.release() }, HOLD_MS)
      }
      // The bar goes away just after the swap, so the moment the panel changes
      // is covered rather than announced.
      setTimeout(() => { store.actions.finish(sessionId) }, FINISH_DELAY_MS)
    },
  }
}