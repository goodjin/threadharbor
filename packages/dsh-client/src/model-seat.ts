/**
 * 座位遮蔽：把输入框上的模型入口换成 ThreadHarbor 自己那一版。
 *
 * 官方 0.2.0-rc.2 的触发按钮只显示模型名，选了 Cursor 也看不出是谁在回答
 * （上游到 0.2.1-alpha 才补上 agent 前缀）。本仓在同一个座位上以更低的优先级
 * 注册自己那一份盖住官方那份——和覆盖工作区列表是同一套机制：座位按优先级
 * 从小到大渲染，冲突只在优先级完全相同时才发生。
 *
 * 官方那一份**不摘**。注册返回的 dispose 一执行，官方那份立刻回到原位，所以
 * 这是一次可退的接管而不是一次替换。localStorage 开关 `off` 让这次接管根本
 * 不发生，和侧栏树是同一个理由：harness 升级漂移时要有一条不改代码的退路。
 *
 * 注入的是官方自己的目录服务（ui-model-selection 的 `ctx.modelDirectories`），
 * 所以目录加载、选择提交、两处入口的同步、加载失败重试全都还是官方的；这里
 * 只换了画出来的那一层。座位声明、注入面、组件签名三者都与官方那一版同形，
 * 换的只是触发按钮上那个前缀。
 */

import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import { ComposerModelSelect } from './composer-model-select.tsx'

/** The composer's model seat, declared by ui-conversation. */
const SEAT = 'conversation.input.model'

/** The locale namespace the official seat's own strings already occupy. */
const NAMESPACE = 'model'

/** Below the official registration's priority 0, so this one renders. */
const SHADOW_PRIORITY = -10

/**
 * The kill switch: `off` leaves the official model seat in place.
 *
 * Set `threadharbor.modelSeat = "off"` in localStorage and reload.
 */
export const MODEL_SEAT_STORAGE_KEY = 'threadharbor.modelSeat'

/** One session's directory controller, as the official seat reads it. */
type Directory = {
  readonly store: unknown
  load(): Promise<unknown>
  select(selection: ModelSelection): Promise<unknown>
}

/** The injected face the seat's component renders from. */
type SeatFace = {
  available: boolean
  directory: unknown
  load: () => void
  select: (selection: ModelSelection) => Promise<unknown>
}

/** The options table `slots.register` accepts; only these members are ever passed. */
type SeatRegistration = {
  name: string
  priority?: number
  locale?: string
  inject: (sessionId: string) => SeatFace
}

/** The slot face the client entry hands in; tests build a recording fake. */
export type ModelSeatSlotHost = {
  inject(slot: string, callback: () => () => void): () => void
  // The real register takes the full options table (children/store/…); this
  // module only ever passes name+priority+locale+inject, and the return is a
  // disposer.
  register(options: SeatRegistration, component: unknown): () => void
}

/** The two services this seat reads: the shared model directory and sessions. */
export type ModelSeatServices = {
  readonly modelDirectories: { directoryFor(sessionId: string): Directory }
  readonly sessions: { subagentAddress(sessionId: string): unknown }
}

/**
 * Whether the kill switch is set to `off`.
 *
 * Absent localStorage (a server render, a locked-down browser) counts as on:
 * only an explicit `off` retreats.
 *
 * @returns true when this browser asked for the official seat.
 */
export function modelSeatShadowedOff(): boolean {
  try {
    return globalThis.localStorage?.getItem(MODEL_SEAT_STORAGE_KEY) === 'off'
  } catch {
    return false
  }
}

/**
 * Register ThreadHarbor's model seat over the official one.
 *
 * @param slots - the slot host, to register into once ui-conversation declares
 * the seat.
 * @param services - the shared model directory and the session registry.
 * @returns the disposer that hands the seat back to the official occupant; a
 * no-op when the kill switch asked for the official seat, or when this host
 * composes no model directory to render from.
 */
export function registerModelSeat(slots: ModelSeatSlotHost, services: Partial<ModelSeatServices>): () => void {
  if (modelSeatShadowedOff()) return () => {}
  const models = services.modelDirectories
  const sessions = services.sessions
  // No directory means no seat to shadow: the official registration reads the
  // same service, so a host without it renders no model seat at all. Registering
  // an occupant here would only trade that for a crash at mount.
  if (models === undefined || sessions === undefined) return () => {}
  return slots.inject(SEAT, () => slots.register(
    {
      name: SEAT,
      priority: SHADOW_PRIORITY,
      locale: NAMESPACE,
      inject: (sessionId: string): SeatFace => {
        const directory = models.directoryFor(sessionId)
        // An addressed subagent session would activate persisted history outside
        // the direct-parent continuation path, so the seat stays hidden there —
        // the same condition the official registration hides it under.
        const available = sessions.subagentAddress(sessionId) === undefined
        return {
          available,
          directory: directory.store,
          load: () => {
            if (available) directory.load().catch(() => { /* surfaced on the store */ })
          },
          select: (selection: ModelSelection) => available
            ? directory.select(selection)
            : Promise.resolve(undefined),
        }
      },
    },
    ComposerModelSelect,
  ))
}
