/**
 * 主机状态推导纯函数的合同。
 *
 * 面板过去在各自的 UI 代码里拼主机状态，拼出来的词会说谎：没部署的主机
 * 显示成已连接、直连主机被读不出凭据时错标成 unknown。这一组测试把推导表
 * 整张钉下来：事实进、状态词出、状态词再查到按钮表，三步都是纯函数——
 * 没有网络、没有时间、没有分支漏网，任何一行改动了行为都会在这里现形。
 */

import { describe, expect, it } from 'vitest'
import { hostActions, hostStatus } from '../src/host-state.ts'
import type { HostFacts } from '../src/host-state.ts'

/** 造一组事实：默认是一台已部署、在跑、打得开但还没回连的远端主机。 */
const facts = (overrides: Partial<HostFacts> = {}): HostFacts => ({
  self: false,
  readable: true,
  deployment: 'deployed',
  liveness: 'running',
  reach: 'reachable',
  reported: false,
  ...overrides,
})

describe('hostStatus', () => {
  it('self 为真时是 self（其余事实任意）', () => {
    // 其余事实故意给成会推导出别的答案的组合：读不出凭据、连通未查，
    // 还在读取中——self 必须压过这一切。
    expect(hostStatus(facts({ self: true, readable: false, deployment: 'unknown', liveness: 'unknown', reach: 'unchecked' }), true)).toBe('self')
  })

  it('正在读时是 reading，即使 deployment 已读到未部署', () => {
    expect(hostStatus(facts({ deployment: 'undeployed' }), true)).toBe('reading')
  })

  it('读到没装是 undeployed', () => {
    expect(hostStatus(facts({ deployment: 'undeployed' }), false)).toBe('undeployed')
  })

  it('装了但对方没应答是 stopped', () => {
    expect(hostStatus(facts({ liveness: 'stopped' }), false)).toBe('stopped')
  })

  it('对方在跑、打得开、对方回连了是 connected', () => {
    expect(hostStatus(facts({ reported: true }), false)).toBe('connected')
  })

  it('对方在跑、打得开、没回连是 reachable', () => {
    expect(hostStatus(facts({}), false)).toBe('reachable')
  })

  it('对方在跑、本机打不开是 disconnected', () => {
    expect(hostStatus(facts({ reach: 'unreachable' }), false)).toBe('disconnected')
  })

  it('对方在跑、reach 为 unchecked 是 unchecked，checking 同样是 unchecked', () => {
    expect(hostStatus(facts({ reach: 'unchecked' }), false)).toBe('unchecked')
    expect(hostStatus(facts({ reach: 'checking' }), false)).toBe('unchecked')
  })

  it('可读但读不出来是 unknown', () => {
    expect(hostStatus(facts({ deployment: 'unknown' }), false)).toBe('unknown')
  })

  it('直连主机不显示 unknown', () => {
    expect(hostStatus(facts({ readable: false, deployment: 'unknown', liveness: 'unknown', reach: 'reachable' }), false)).toBe('reachable')
    expect(hostStatus(facts({ readable: false, deployment: 'unknown', liveness: 'unknown', reach: 'unreachable' }), false)).toBe('disconnected')
  })
})

describe('hostActions', () => {
  it('self 无按钮', () => {
    expect(hostActions('self')).toEqual([])
  })

  it('reading 无按钮', () => {
    expect(hostActions('reading')).toEqual([])
  })

  it('undeployed 的按钮是 deploy、read-peer', () => {
    expect(hostActions('undeployed')).toEqual(['deploy', 'read-peer'])
  })

  it('stopped 的按钮是 start-peer、redeploy', () => {
    expect(hostActions('stopped')).toEqual(['start-peer', 'redeploy'])
  })

  it('connected 的按钮是 open-page、check-reach', () => {
    expect(hostActions('connected')).toEqual(['open-page', 'check-reach'])
  })

  it('reachable 的按钮是 connect-open、check-reach', () => {
    expect(hostActions('reachable')).toEqual(['connect-open', 'check-reach'])
  })

  it('disconnected 的按钮同样是 connect-open、check-reach', () => {
    expect(hostActions('disconnected')).toEqual(['connect-open', 'check-reach'])
  })

  it('unchecked 的按钮是 check-reach、connect-open', () => {
    expect(hostActions('unchecked')).toEqual(['check-reach', 'connect-open'])
  })

  it('unknown 的按钮是 fill-ssh、retry-read', () => {
    expect(hostActions('unknown')).toEqual(['fill-ssh', 'retry-read'])
  })
})
