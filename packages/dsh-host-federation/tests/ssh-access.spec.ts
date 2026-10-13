import { describe, expect, it } from 'vitest'
import { composeLaunchUrl, parseDeployMarkers, validateBindHost } from '../src/ssh/access.ts'

describe('ssh access helpers', () => {
  it('rejects wildcard bind hosts', () => {
    expect(() => validateBindHost('0.0.0.0')).toThrow()
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
