/**
 * The browser client for the SSH routes: shape of what goes over the wire and
 * how errors come back. The route semantics live host-side; here we only pin
 * the contract the panel relies on.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectRemoteHost, ROUTE_START, startRemotePeer } from '../src/ssh-deploy.ts'
// The host constant is imported from source: the federation package root
// deliberately does not re-export ./ssh-deploy (node built-ins), but a test
// runs in Node, and the equality check is the point of this spec.
import { ROUTE_START as HOST_ROUTE_START } from '../../dsh-host-federation/src/ssh-deploy.ts'

function stubFetchOnce(payload: unknown, status = 200): typeof fetch {
  const mock = vi.fn(async () => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } }))
  globalThis.fetch = mock as unknown as typeof fetch
  return mock
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('connectRemoteHost', () => {
  it('posts the ssh facts and optional port to the connect route', async () => {
    const fetchMock = stubFetchOnce({ ok: true, value: { endpoint: 'http://127.0.0.1:45555', launchUrl: 'http://127.0.0.1:45555/?token=s', mode: 'tunnel', peer: { pluginsInstalled: true } } })
    const result = await connectRemoteHost({ target: 'mini.ts.net', hostKeyFingerprint: 'SHA256:abc' }, 3081)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.endpoint).toBe('http://127.0.0.1:45555')
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(call[0]).toBe('/api/threadharbor.host-ssh.connect')
    expect(JSON.parse(String(call[1].body))).toEqual({ ssh: { target: 'mini.ts.net', hostKeyFingerprint: 'SHA256:abc' }, remoteWebPort: 3081 })
  })

  it('omits the port when the caller has none', async () => {
    const fetchMock = stubFetchOnce({ ok: true, value: { endpoint: 'http://127.0.0.1:1', launchUrl: 'http://127.0.0.1:1/?token=s', mode: 'tunnel', peer: { pluginsInstalled: true } } })
    await connectRemoteHost({ target: 'x', hostKeyFingerprint: 'SHA256:1' })
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(call[1].body))).toEqual({ ssh: { target: 'x', hostKeyFingerprint: 'SHA256:1' } })
  })

  it('carries the raw server-side refusal text back untouched', async () => {
    stubFetchOnce({ ok: false, error: '远端还没有 ThreadHarbor 部署记录（未安装或未成功启动）；请先执行一次部署' }, 400)
    const result = await connectRemoteHost({ target: 'x', hostKeyFingerprint: 'SHA256:1' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('请先执行一次部署')
  })
})

describe('startRemotePeer', () => {
  it('the host and client ROUTE_START constants are the same string', () => {
    expect(ROUTE_START).toBe('/api/threadharbor.host-ssh.start')
    expect(ROUTE_START).toBe(HOST_ROUTE_START)
  })

  it('startRemotePeer posts the ssh facts and port to the start route', async () => {
    const fetchMock = stubFetchOnce({ ok: true, value: { port: 3081 } })
    const result = await startRemotePeer({ target: 'mini.ts.net', hostKeyFingerprint: 'SHA256:abc' }, 3081)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.port).toBe(3081)
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(call[0]).toBe('/api/threadharbor.host-ssh.start')
    expect(call[1].method).toBe('POST')
    expect(JSON.parse(String(call[1].body))).toEqual({ ssh: { target: 'mini.ts.net', hostKeyFingerprint: 'SHA256:abc' }, port: 3081 })
  })
})
