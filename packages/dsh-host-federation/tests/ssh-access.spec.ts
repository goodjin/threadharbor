import { describe, expect, it } from 'vitest'
import { composeLaunchUrl, parseAccessMode, parseDeployMarkers, planConnection, validateBindHost } from '../src/ssh/access.ts'

describe('ssh access helpers', () => {
  it('rejects wildcard bind hosts', () => {
    expect(() => validateBindHost('0.0.0.0')).toThrow()
  })

  it('keeps host-ip as its own mode and leaves an omitted mode on the tunnel', () => {
    expect(parseAccessMode('host-ip')).toBe('host-ip')
    expect(parseAccessMode('serve')).toBe('serve')
    expect(parseAccessMode(undefined)).toBe('tunnel')
    expect(parseAccessMode('tailscale')).toBe('tunnel')
    expect(parseAccessMode('custom')).toBe('tunnel')
    expect(() => parseAccessMode('magic')).toThrow('accessMode must be host-ip, tunnel, or serve')
  })

  it('strips brackets so --host stays an unbracketed address', () => {
    expect(validateBindHost('[2001:db8::10]')).toBe('2001:db8::10')
  })

  it('rewrites token onto the local tunnel origin', () => {
    const url = composeLaunchUrl('http://127.0.0.1:45678', 'http://127.0.0.1:3081/?token=abc')
    expect(url).toBe('http://127.0.0.1:45678/?token=abc')
  })

  it('parses deploy markers from remote stdout', () => {
    const markers = parseDeployMarkers([
      'ALREADY_RUNNING=1',
      'BIND_HOST=100.64.0.2',
      'LAUNCH_URL=http://100.64.0.2:3081/?token=secret',
    ].join('\n'))
    expect(markers.alreadyRunning).toBe(true)
    expect(markers.bindHost).toBe('100.64.0.2')
    expect(markers.launchUrl).toContain('token=secret')
  })
})

describe('planConnection — how to reach a deployed peer', () => {
  const loopbackPeer = {
    pluginsInstalled: true,
    listen: 'loopback' as const,
    port: 3081,
    launchUrl: 'http://127.0.0.1:3081/?token=secret',
  }

  it('a loopback peer plans a tunnel on the port its record names', () => {
    const plan = planConnection(loopbackPeer, 9999, 3081)
    expect(plan).toEqual({ mode: 'tunnel', remotePort: 3081, launchUrl: 'http://127.0.0.1:3081/?token=secret' })
  })

  it('a loopback record without a port falls back to the caller default', () => {
    const plan = planConnection({ pluginsInstalled: true, listen: 'loopback', launchUrl: 'http://127.0.0.1:3081/?token=s' }, 4242, 3081)
    expect(plan).toEqual({ mode: 'tunnel', remotePort: 4242, launchUrl: 'http://127.0.0.1:3081/?token=s' })
  })

  it('a peer with no install record refuses with the reason the operator can act on', () => {
    expect(() => planConnection({ pluginsInstalled: false }, undefined, 3081))
      .toThrow('远端还没有 ThreadHarbor 部署记录')
  })

  it('a loopback record without a tokenized URL says redeploy instead of guessing', () => {
    expect(() => planConnection({ pluginsInstalled: true, listen: 'loopback', port: 3081 }, undefined, 3081))
      .toThrow('带令牌的启动网址')
  })

  it('a host-ip record plans a direct open, no tunnel', () => {
    const plan = planConnection({
      pluginsInstalled: true,
      listen: 'host-ip',
      port: 3081,
      bindHost: '192.168.1.10',
      launchUrl: 'http://192.168.1.10:3081/?token=s',
    }, undefined, 3081)
    expect(plan).toEqual({ mode: 'direct', remotePort: 3081, launchUrl: 'http://192.168.1.10:3081/?token=s' })
  })

  it('a non-loopback launch URL is direct even when the record still says loopback', () => {
    const plan = planConnection({
      pluginsInstalled: true,
      listen: 'loopback',
      port: 3081,
      launchUrl: 'http://10.0.0.8:3081/?token=s',
    }, undefined, 3081)
    expect(plan.mode).toBe('direct')
    expect(plan.launchUrl).toBe('http://10.0.0.8:3081/?token=s')
  })

  it('a legacy direct-listening peer plans a direct open, no tunnel', () => {
    const plan = planConnection({
      pluginsInstalled: true,
      listen: 'tailscale',
      port: 3081,
      bindHost: '100.64.0.2',
      launchUrl: 'http://100.64.0.2:3081/?token=s',
    }, undefined, 3081)
    expect(plan).toEqual({ mode: 'direct', remotePort: 3081, launchUrl: 'http://100.64.0.2:3081/?token=s' })
  })

  it('a record naming no port anywhere refuses rather than forwarding to nothing', () => {
    expect(() => planConnection({ pluginsInstalled: true, listen: 'loopback', launchUrl: 'http://127.0.0.1:3081/?token=s' }, undefined, undefined))
      .toThrow('端口')
  })
})

