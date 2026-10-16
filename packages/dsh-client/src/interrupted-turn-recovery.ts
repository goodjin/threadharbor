/**
 * 「被打断且无正文」轮次的找回入口（2026-10-16 治本，用户拍板）。
 *
 * 会话视图把已结束轮次的过程内容（思考、工具卡片）默认折叠。正常轮次有一段
 * 正文答复当锚点，折叠行也能点开；但「重启打断 + 全程没吐过正文」的轮次两头
 * 落空——过程被收走、又没有正文可显示，整个轮次在界面上消失（会话
 * ef20f6ac 第 17 轮：58 步、70 次工具调用，一段正文都没有）。长工具轮次是
 * 外部 agent 的常态，这个死角因此必踩；官方视图对 interrupted 结尾不豁免
 * 折叠（aborted/error 豁免），插件侧也没有改别家组件规则的口子。
 *
 * 修法是补一个入口而不是改规则：在轮次结尾的列表座位
 * （conversation.chat.turnTail——它在折叠范围之外，turn-tail 属于豁免名单，
 * 永远渲染）挂一行兜底提示，只在盲区条件命中时出现：轮次已关闭、interrupted
 * 收尾、无正文锚点（turn-process spec 的 answerAnchorSeq 为 null）、确有
 * 过程内容。按钮调用聊天存储现成的 setTurnProcessOpen(turn, 0, true)——与
 * 官方折叠行的展开完全同路，展开后本行自行消失。
 *
 * 展开动作拿不到时整行不渲染：一条点不动的提示只会徒增困惑。这里是渲染期
 * 的能力探测（座位 props 逐次到达），没有注册期可以留日志的时机；座位缺位
 * 的极端环境里官方兜底（JsonBlock）仍在。
 */

import { createElement } from 'react'
import type { ReactNode } from 'react'
import { fallbackT, NAMESPACE } from './locales.ts'
import type { RuntimeT } from './locales.ts'

/** turnTail 座位条目的 id；order 排在官方结尾内容之后。 */
export const RECOVERY_TAIL_ID = 'threadharbor-interrupted-recovery'
export const RECOVERY_TAIL_ORDER = 10

/** turn-process 投影里本行读的字段（官方 TurnProcessSpec 的结构子集）。 */
interface RecoverySpecFace {
  readonly answerAnchorSeq: number | null
  readonly messageCount: number
  readonly toolCallCount: number
  readonly subagentCount: number
}

/** 轮次座位数据的结构子集：编号、状态、结尾原因、turn 数据仓。 */
export interface RecoveryTurnFace {
  readonly turn: number
  readonly status: string
  readonly end?: { readonly data: { readonly reason?: { readonly kind?: unknown } } }
  readonly data: { get(key: string): unknown }
}

/** 聊天存储的结构子集：已展开轮次表的读钩子与展开动作。 */
export interface RecoveryStoreFace {
  readonly useStore?: <S>(selector: (state: { readonly turnProcesses: ReadonlyArray<{ readonly turn: number }> }) => S) => S
  readonly actions?: { setTurnProcessOpen(turn: number, answerStep: number, open: boolean): void }
}

function specHasProcess(spec: RecoverySpecFace): boolean {
  return spec.messageCount + spec.toolCallCount + spec.subagentCount > 0
}

/**
 * 渲染盲区轮的找回入口。
 *
 * @param props - 轮次座位数据（turnTail 的 owner props）、聊天存储面与词典座位。
 * @returns 提示行；条件不命中或动作不可用时为 null。
 */
export function InterruptedTurnRecoveryRow(props: RecoveryStoreFace & {
  turn?: RecoveryTurnFace
  t?: RuntimeT
}): ReactNode {
  const turn = props.turn
  if (turn === undefined) return null
  if (turn.status !== 'closed') return null
  if (turn.end?.data.reason?.kind !== 'interrupted') return null
  const spec = turn.data.get('turn-process')
  if (typeof spec !== 'object' || spec === null) return null
  const face = spec as Partial<RecoverySpecFace>
  if (face.answerAnchorSeq !== null) return null
  if (face.messageCount === undefined || face.toolCallCount === undefined || face.subagentCount === undefined) return null
  if (!specHasProcess(face as RecoverySpecFace)) return null
  const reveal = props.actions?.setTurnProcessOpen
  if (reveal === undefined) return null
  const revealed = props.useStore?.(state => state.turnProcesses.some(entry => entry.turn === turn.turn)) ?? false
  if (revealed) return null
  const t = props.t ?? fallbackT
  return createElement('div', {
    'data-interrupted-recovery': turn.turn,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      margin: '4px 0',
      fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
      color: 'var(--dsw-alias-label-tertiary)',
    },
  },
    createElement('span', null, t('recovery.interrupted.note', {
      steps: String((face.messageCount ?? 0) + (face.toolCallCount ?? 0)),
    })),
    createElement('button', {
      type: 'button',
      onClick: () => { reveal(turn.turn, 0, true) },
      style: {
        border: 'none',
        background: 'none',
        padding: '0',
        font: 'inherit',
        color: 'var(--dsw-alias-label-secondary, inherit)',
        textDecoration: 'underline',
        cursor: 'pointer',
      },
    }, t('recovery.interrupted.expand')))
}

/** turnTail 座位宿主的结构类型（与其它座位宿主同一写法）。 */
type TailSlotHost = {
  inject(key: string, callback: () => (() => void) | Iterable<() => void, void, void>): () => void
  register(options: {
    name: string
    id?: string
    order?: number
    locale?: string
  }, component: unknown): () => void
}

/**
 * 把找回入口挂进轮次结尾的列表座位。
 *
 * 注册走 `slots.inject`：等 ui-chat 的 turn-tail 渲染器声明这个座位，而不是
 * 向一个可能还不存在的座位抢注；声明方消失时贡献随之回收。
 *
 * @param slots - 座位宿主（`ctx.slots`）。
 * @returns 注册的清理函数。
 */
export function registerInterruptedTurnRecovery(slots: TailSlotHost): () => void {
  return slots.inject('conversation.chat.turnTail', () => slots.register(
    {
      name: 'conversation.chat.turnTail',
      id: RECOVERY_TAIL_ID,
      order: RECOVERY_TAIL_ORDER,
      locale: NAMESPACE,
    },
    (props: {
      readonly turn?: RecoveryTurnFace
      readonly useStore?: RecoveryStoreFace['useStore']
      readonly actions?: RecoveryStoreFace['actions']
      readonly t?: RuntimeT
    }) => createElement(InterruptedTurnRecoveryRow, {
      ...(props.turn === undefined ? {} : { turn: props.turn }),
      ...(props.useStore === undefined ? {} : { useStore: props.useStore }),
      ...(props.actions === undefined ? {} : { actions: props.actions }),
      ...(props.t === undefined ? {} : { t: props.t }),
    }),
  )) as () => void
}
