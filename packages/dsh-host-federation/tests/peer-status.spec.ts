import { describe, expect, it } from 'vitest'
import { parsePeerStatus } from '../src/ssh/peer-status.ts'

describe('parsePeerStatus', () => {
  it('treats a missing file as not installed', () => {
    expect(parsePeerStatus('')).toEqual({ pluginsInstalled: false })
    expect(parsePeerStatus('not-json')).toEqual({ pluginsInstalled: false })
  })

  it('reads listen mode and launch url', () => {
    expect(parsePeerStatus(JSON.stringify({
      pluginsInstalled: true,
      listen: 'loopback',
      port: 3081,
      bindHost: '127.0.0.1',
      launchUrl: 'http://127.0.0.1:3081/?token=abc',
    }))).toEqual({
      pluginsInstalled: true,
      listen: 'loopback',
      port: 3081,
      bindHost: '127.0.0.1',
      launchUrl: 'http://127.0.0.1:3081/?token=abc',
    })
  })
})
