/**
 * 浏览器侧报到：身份一落地就报，身份变更立刻重报，失败按同一条原因去重，
 * 退订/停止后不再发请求。请求里只有 id 与显示名——地址与令牌由宿主按
 * 请求来源自己铸。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ANNOUNCE_INTERVAL_MS, startFederationAnnounce } from '../src/federation-announce.ts'
import { FEDERATION_ANNOUNCE_PATH } from '@threadharbor/dsh-host-federation'

type Call = { path: string; body: Record<string, unknown> }

afterEach(() => {
  vi.useRealTimers()
})

describe('主机报到', () => {
  it('启动即报一次；请求只有 id 与显示名，没有地址或令牌', async () => {
    vi.useFakeTimers()
    const calls: Call[] = []
    const announcer = startFederationAnnounce({
      identity: () => ({ hostId: 'mac1', hostTitle: 'Mac 1' }),
      fetchLike: async (path, init) => {
        calls.push({ path, body: JSON.parse(init.body) as Record<string, unknown> })
        return { status: 200, ok: true }
      },
      intervalMs: 1_000,
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toEqual([{
      path: FEDERATION_ANNOUNCE_PATH,
      body: { hostId: 'mac1', hostTitle: 'Mac 1' },
    }])
    expect(JSON.stringify(calls[0]?.body)).not.toContain('token')
    announcer.dispose()
  })

  it('身份变更立即重报；慢轮询也再报一次（刷新重启后的令牌）', async () => {
    vi.useFakeTimers()
    const calls: Call[] = []
    let current = { hostId: 'mac1', hostTitle: 'Mac 1' }
    let notify: (() => void) | undefined
    const announcer = startFederationAnnounce({
      identity: () => current,
      subscribe: listener => {
        notify = listener
        return () => { notify = undefined }
      },
      fetchLike: async (path, init) => {
        calls.push({ path, body: JSON.parse(init.body) as Record<string, unknown> })
        return { status: 200, ok: true }
      },
      intervalMs: 2_000,
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(1)
    current = { hostId: 'mac1', hostTitle: '改名了' }
    notify?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(2)
    expect(calls[1]?.body).toEqual({ hostId: 'mac1', hostTitle: '改名了' })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(ANNOUNCE_INTERVAL_MS).toBeGreaterThan(1_000)
    expect(calls).toHaveLength(3)
    announcer.dispose()
  })

  it('失败按同一条原因只记一次，恢复后记一条 recovered', async () => {
    vi.useFakeTimers()
    const lines: string[] = []
    let outcome: 'fail' | 'ok' = 'fail'
    const announcer = startFederationAnnounce({
      identity: () => ({ hostId: 'mac1', hostTitle: 'Mac 1' }),
      fetchLike: async () => {
        if (outcome === 'fail') throw new Error('offline')
        return { status: 200, ok: true }
      },
      intervalMs: 1_000,
      log: message => { lines.push(message) },
    })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(lines).toEqual(['federation announce failed: offline'])
    outcome = 'ok'
    await vi.advanceTimersByTimeAsync(1_000)
    expect(lines).toEqual(['federation announce failed: offline', 'federation announce recovered'])
    announcer.dispose()
  })

  it('空身份不发请求；dispose 后停止轮询并退订', async () => {
    vi.useFakeTimers()
    const calls: Call[] = []
    let notify: (() => void) | undefined
    let unsubscribed = false
    const announcer = startFederationAnnounce({
      identity: () => ({ hostId: '', hostTitle: '' }),
      subscribe: listener => {
        notify = listener
        return () => { unsubscribed = true }
      },
      fetchLike: async (path, init) => {
        calls.push({ path, body: JSON.parse(init.body) as Record<string, unknown> })
        return { status: 200, ok: true }
      },
      intervalMs: 1_000,
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(0)
    notify = undefined
    announcer.dispose()
    expect(unsubscribed).toBe(true)
    expect(notify).toBeUndefined()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(calls).toHaveLength(0)
  })

  it('请求在途时重复触发不叠加', async () => {
    vi.useFakeTimers()
    let resolve: ((value: { status: number; ok: boolean }) => void) | undefined
    let calls = 0
    let notify: (() => void) | undefined
    const announcer = startFederationAnnounce({
      identity: () => ({ hostId: 'mac1', hostTitle: 'Mac 1' }),
      subscribe: listener => {
        notify = listener
        return () => {}
      },
      fetchLike: () => {
        calls += 1
        return new Promise<{ status: number; ok: boolean }>(done => { resolve = done })
      },
      intervalMs: 1_000,
    })
    notify?.()
    expect(calls).toBe(1)
    resolve?.({ status: 200, ok: true })
    await vi.advanceTimersByTimeAsync(0)
    notify?.()
    expect(calls).toBe(2)
    resolve?.({ status: 200, ok: true })
    await vi.advanceTimersByTimeAsync(0)
    announcer.dispose()
  })
})
