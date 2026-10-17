import { describe, expect, it, vi, afterEach } from 'vitest'
import { rollUpViewWithRegistry } from '../src/host-roll-up.ts'
import { createRemoteSessionStore } from '../src/remote-session-store.ts'
import { fetchHostSessions } from '../src/remote-session-poll.ts'
import type { HostRegistration, HostSession, RollUp } from '@threadharbor/dsh-host-federation'

const registration = (hostId: string, extra: Record<string, unknown> = {}): HostRegistration =>
  ({ hostId, hostTitle: hostId, address: 'http://127.0.0.1:1', ...extra }) as HostRegistration

const emptyRollUp: RollUp = { hosts: [] }

const session = (sessionId: string, projectId = 'p1'): HostSession =>
  ({ sessionId, projectId, title: sessionId, projectTitle: '研究' })

describe('rollUpViewWithRegistry（登记簿并入树）', () => {
  it('登记了但从未部署（无 launchUrl）：行标记 undeployed 且 empty', () => {
    const view = rollUpViewWithRegistry(emptyRollUp, [registration('mini')], new Map())
    expect(view.hosts).toHaveLength(1)
    expect(view.hosts[0]?.undeployed).toBe(true)
    expect(view.hosts[0]?.empty).toBe(true)
  })

  it('读数说未部署时行是未部署（即使登记里有 launchUrl —— 装了又卸了）', () => {
    const reg = registration('mini', { launchUrl: 'http://127.0.0.1:45000/?token=x', remote: { deployment: 'undeployed' } })
    const view = rollUpViewWithRegistry(emptyRollUp, [reg], new Map())
    expect(view.hosts[0]?.undeployed).toBe(true)
  })

  it('读数说已部署时行不是未部署（即使登记里没有 launchUrl —— 装了但还没连过）', () => {
    const reg = registration('mini', { remote: { deployment: 'deployed' } })
    const view = rollUpViewWithRegistry(emptyRollUp, [reg], new Map())
    expect(view.hosts[0]?.undeployed).not.toBe(true)
  })

  it('没有读数时退回旧启发式（无 launchUrl 即未部署）', () => {
    const reg = registration('mini', { launchUrl: 'http://127.0.0.1:45000/?token=x' })
    const view = rollUpViewWithRegistry(emptyRollUp, [reg], new Map())
    expect(view.hosts[0]?.undeployed).not.toBe(true)
  })

  it('读数说 unknown：行不带 undeployed，也不退回旧启发式（本例旧启发式会说未部署）', () => {
    const reg = registration('mini', { remote: { deployment: 'unknown' } })
    const view = rollUpViewWithRegistry(emptyRollUp, [reg], new Map())
    expect(view.hosts[0]?.undeployed).toBeUndefined()
  })

  it('部署过且远端有会话：并入项目与会话', () => {
    const reg = registration('mini', { launchUrl: 'http://127.0.0.1:45000/?token=x' })
    const view = rollUpViewWithRegistry(emptyRollUp, [reg], new Map([['mini', [session('s1')]]]))
    expect(view.hosts[0]?.empty).toBe(false)
    expect(view.hosts[0]?.projects[0]?.sessions.map(s => s.sessionId)).toEqual(['s1'])
    expect(view.hosts[0]?.undeployed).not.toBe(true)
  })

  it('部署过但拉取失败（store 记 note）：行不 empty 也不 undeployed，note 透传', () => {
    const reg = registration('mini', { launchUrl: 'http://127.0.0.1:45000/?token=x' })
    const store = createRemoteSessionStore()
    store.set('mini', [], 'HTTP 500')
    const view = rollUpViewWithRegistry(emptyRollUp, [reg], store.snapshotWithNotes())
    expect(view.hosts[0]?.empty).toBe(true)
    expect(view.hosts[0]?.undeployed).not.toBe(true)
    expect(view.hosts[0]?.note).toBe('HTTP 500')
  })

  it('本机永远排第一，登记主机按名序追加', () => {
    const reg = registration('zeta', { launchUrl: 'http://127.0.0.1:1/?token=x' })
    const rollUp: RollUp = { hosts: [{ hostId: 'self', hostTitle: '本机', lastSeen: 1, self: true, projects: [], sessions: [] }] }
    const view = rollUpViewWithRegistry(rollUp, [reg], new Map())
    expect(view.hosts.map(h => h.hostId)).toEqual(['self', 'zeta'])
  })
})

describe('createRemoteSessionStore', () => {
  it('set/get/snapshot/subscribe 与 note 分层', () => {
    const store = createRemoteSessionStore()
    const heard: number[] = []
    store.subscribe(() => heard.push(1))
    store.set('mini', [session('s1')])
    store.set('down', [], 'HTTP 500')
    expect(store.get('mini')?.sessions).toHaveLength(1)
    expect(store.get('down')?.note).toBe('HTTP 500')
    expect(store.snapshot().get('mini')).toHaveLength(1)
    expect(heard).toHaveLength(2)
  })
})

describe('fetchHostSessions', () => {
  afterEach(() => { delete (globalThis as { fetch?: unknown }).fetch })

  it('服务端返回 ok：解出会话清单', async () => {
    globalThis.fetch = (async () => Response.json({ ok: true, value: { sessions: [{ projectId: 'p1', sessionId: 's1', title: '会话 1' }] } })) as typeof fetch
    const result = await fetchHostSessions('http://127.0.0.1:45000/?token=x')
    expect(result).toEqual({ sessions: [{ projectId: 'p1', sessionId: 's1', title: '会话 1' }] })
  })

  it('服务端返回错误：failed 带原始文本', async () => {
    globalThis.fetch = (async () => Response.json({ ok: false, error: 'launchUrl 无效' })) as typeof fetch
    const result = await fetchHostSessions('::::')
    expect(result).toEqual({ failed: 'launchUrl 无效' })
  })

  it('网络异常：failed 带异常原文，不抛', async () => {
    globalThis.fetch = (async () => { throw new Error('socket hang up') }) as typeof fetch
    const result = await fetchHostSessions('http://127.0.0.1:45000/?token=x')
    expect(result).toEqual({ failed: 'socket hang up' })
  })
})
