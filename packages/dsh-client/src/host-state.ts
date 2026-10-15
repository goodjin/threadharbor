/**
 * 主机状态推导：一组事实推出一个状态词，状态词再查到按钮表。
 *
 * 面板上每台主机只该有一个说得通的状态。过去这句话由各处 UI 代码现场拼装，
 * 拼出来的词会说谎：没部署的主机显示成已连接，直连主机读不到凭据时错标成
 * unknown。这个模块把推导收拢成纯函数——没有网络、没有时间、每个分支都有
 * 返回值，全表可以用测试逐格核对。它只产出状态与动作的标识符，不说人话：
 * 文案仍然归 locales.ts。
 */

/** 本机自己的事实永远优先：self 状态下其余事实一律不看。 */
export type HostReach = 'unchecked' | 'checking' | 'reachable' | 'unreachable'

/**
 * 推导一台主机状态所需的全部事实。
 * `reported` 指对方部署体是否已回连本机（面板因此才谈得上 connected）。
 */
export type HostFacts = {
  readonly self: boolean
  readonly readable: boolean
  readonly deployment: RemoteDeployment
  readonly liveness: RemoteLiveness
  readonly reach: HostReach
  readonly reported: boolean
}

// 这两个词表来自 '@threadharbor/dsh-host-federation'；本任务先就地声明，
// Task 2 再改为从彼处转出，词面保持一致。
type RemoteDeployment = 'undeployed' | 'deployed' | 'unknown'
type RemoteLiveness = 'stopped' | 'running' | 'unknown'

/** 主机上显示的那一个状态词，九选一、不重叠。 */
export type HostStatus = 'self' | 'reading' | 'undeployed' | 'stopped'
  | 'connected' | 'reachable' | 'disconnected' | 'unchecked' | 'unknown'

/** 状态行上可以出现的动作标识符，交给调用方去映射成按钮与文案。 */
export type HostAction = 'deploy' | 'read-peer' | 'start-peer' | 'redeploy'
  | 'open-page' | 'connect-open' | 'check-reach' | 'fill-ssh' | 'retry-read'

/**
 * 从事实推导主机的状态词。推导顺序固定：self → reading → 直连主机（读不出
 * 部署事实，只按连通性说话）→ 未部署 → 读不出 → 已部署时看对方在不在跑、
 * 再按连通性与回连收尾。每个分支都有返回值：宁可给出 honest 的 unknown，
 * 也不给 undefined。
 * @param facts - 这台主机当前掌握的全部事实。
 * @param reading - 面板此刻是否正在读取远端事实（读取中不抢答）。
 * @returns 九个状态词之一。
 */
export function hostStatus(facts: HostFacts, reading: boolean): HostStatus {
  if (facts.self) return 'self'
  if (reading) return 'reading'
  if (!facts.readable) {
    // 直连主机（或读不到凭据的主机）：没有部署事实可看，只按 reach 分支。
    if (facts.reach === 'reachable') return facts.reported ? 'connected' : 'reachable'
    if (facts.reach === 'unreachable') return 'disconnected'
    return 'unchecked'
  }
  if (facts.deployment === 'undeployed') return 'undeployed'
  if (facts.deployment === 'unknown') return 'unknown'
  if (facts.liveness === 'stopped') return 'stopped'
  if (facts.liveness === 'unknown') return 'unknown'
  if (facts.reach === 'reachable') return facts.reported ? 'connected' : 'reachable'
  if (facts.reach === 'unreachable') return 'disconnected'
  return 'unchecked'
}

/** 每个状态的按钮表，顺序即主按钮在前。 */
const ACTIONS: Readonly<Record<HostStatus, readonly HostAction[]>> = {
  self: [],
  reading: [],
  undeployed: ['deploy', 'read-peer'],
  stopped: ['start-peer', 'redeploy'],
  connected: ['open-page', 'check-reach'],
  reachable: ['connect-open', 'check-reach'],
  disconnected: ['connect-open', 'check-reach'],
  unchecked: ['check-reach', 'connect-open'],
  unknown: ['fill-ssh', 'retry-read'],
}

/**
 * 查一个状态的按钮表。
 * @param status - 推导出的状态词。
 * @returns 该状态的按钮序列，主按钮在前；可能为空。
 */
export function hostActions(status: HostStatus): readonly HostAction[] {
  return ACTIONS[status]
}
