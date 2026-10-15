import { describe, expect, it } from 'vitest'
import {
  buildPeerCheckScript,
  buildServeScript,
  buildServiceScript,
  manualServeCommands,
  derivePeerCheckSteps,
  findServeUrl,
  parsePeerCheckOutput,
} from '../src/ssh/peer-check.ts'
import { probeServeHttps } from '../src/ssh/manager.ts'

const b64 = (value: unknown): string => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64')

const SERVE = { TCP: { 443: { HTTPS: true } }, Web: { 'box.tail1.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3081' } } } } }
const PEER = { pluginsInstalled: true, listen: 'loopback', port: 3081, bindHost: '127.0.0.1', launchUrl: 'http://127.0.0.1:3081/?token=tok' }

function output(overrides: Record<string, string | undefined> = {}): string {
  const base: Record<string, string | undefined> = {
    SSH_OK: '1',
    TS_INSTALLED: '1',
    TS_STATUS_B64: b64({ BackendState: 'Running', Self: { DNSName: 'box.tail1.ts.net.' } }),
    TS_SERVE_B64: b64(SERVE),
    NODE_VERSION: 'v22.19.0',
    DSH_VERSION: '0.2.0-rc.2',
    PEER_B64: b64(PEER),
    HEALTH: '200',
    ...overrides,
  }
  return Object.entries(base).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join('\n')
}

const states = (report: ReturnType<typeof derivePeerCheckSteps>): string =>
  report.steps.map(step => `${step.id}:${step.state}`).join(' ')

describe('peer check', () => {
  it('builds scripts only for valid ports', () => {
    expect(buildPeerCheckScript(3081)).toContain('http://127.0.0.1:3081/')
    expect(buildServeScript(3081)).toContain('serve --bg --https=443 http://127.0.0.1:3081')
    expect(() => buildPeerCheckScript(0)).toThrow()
    expect(() => buildServeScript(70_000)).toThrow()
  })

  it('finds the serve handler proxying the DSH port', () => {
    expect(findServeUrl(SERVE, 3081)).toEqual({ url: 'https://box.tail1.ts.net', other: false })
    expect(findServeUrl(SERVE, 4000)).toEqual({ other: true })
    expect(findServeUrl({ Web: { 'box.ts.net:8443': { Handlers: { '/': { Proxy: 'http://localhost:4000' } } } } }, 4000))
      .toEqual({ url: 'https://box.ts.net:8443', other: false })
    expect(findServeUrl(undefined, 3081)).toEqual({ other: false })
  })

  it('parses facts', () => {
    const facts = parsePeerCheckOutput(output(), 3081)
    expect(facts).toMatchObject({
      sshOk: true, tailscaleInstalled: true, tailscaleBackendState: 'Running', magicDnsName: 'box.tail1.ts.net',
      nodeVersion: 'v22.19.0', dshVersion: '0.2.0-rc.2', healthCode: 200, serveUrl: 'https://box.tail1.ts.net', serveOther: false,
    })
    expect(facts.peer.pluginsInstalled).toBe(true)
  })

  it('is ready and yields the ts.net launch URL when everything passes', () => {
    const report = derivePeerCheckSteps(parsePeerCheckOutput(output(), 3081), { reachable: true, authOk: true, status: 200 })
    expect(report.ready).toBe(true)
    expect(states(report)).toBe('ssh:ok tailscale:ok node:ok dsh:ok plugins:ok running:ok serve:ok https:ok')
    expect(report.serveLaunchUrl).toBe('https://box.tail1.ts.net/?token=tok')
  })

  it('offers deploy for a bare machine and skips everything after the first failure', () => {
    const report = derivePeerCheckSteps(parsePeerCheckOutput(output({ DSH_VERSION: undefined, PEER_B64: '', HEALTH: '000', TS_SERVE_B64: '' }), 3081), undefined)
    expect(states(report)).toBe('ssh:ok tailscale:ok node:ok dsh:fail plugins:skip running:skip serve:skip https:skip')
    expect(report.steps.find(step => step.id === 'dsh')?.actions).toEqual(['deploy'])
    expect(report.ready).toBe(false)
    expect(report.serveLaunchUrl).toBeUndefined()
  })

  it('offers start when DSH is down, serve when serve is missing', () => {
    const down = derivePeerCheckSteps(parsePeerCheckOutput(output({ HEALTH: '000' }), 3081), undefined)
    expect(down.steps.find(step => step.id === 'running')).toMatchObject({ state: 'fail', actions: ['start'] })
    const noServe = derivePeerCheckSteps(parsePeerCheckOutput(output({ TS_SERVE_B64: '' }), 3081), undefined)
    expect(noServe.steps.find(step => step.id === 'serve')).toMatchObject({ state: 'fail', reason: 'not-configured', actions: ['serve'] })
  })

  it('a tailscale problem still allows deploying but blocks serve', () => {
    const report = derivePeerCheckSteps(parsePeerCheckOutput(output({ TS_STATUS_B64: b64({ BackendState: 'NeedsLogin', Self: {} }), DSH_VERSION: undefined }), 3081), undefined)
    expect(states(report)).toBe('ssh:ok tailscale:fail node:ok dsh:fail plugins:skip running:skip serve:skip https:skip')
    const loggedOut = derivePeerCheckSteps(parsePeerCheckOutput(output({ TS_STATUS_B64: b64({ BackendState: 'NeedsLogin', Self: {} }) }), 3081), undefined)
    expect(states(loggedOut)).toBe('ssh:ok tailscale:fail node:ok dsh:ok plugins:ok running:ok serve:skip https:skip')
    expect(loggedOut.steps[1]).toMatchObject({ reason: 'logged-out' })
  })

  it('flags old node and rejected tokens', () => {
    const old = derivePeerCheckSteps(parsePeerCheckOutput(output({ NODE_VERSION: 'v20.1.0' }), 3081), undefined)
    expect(old.steps.find(step => step.id === 'node')).toMatchObject({ state: 'fail', reason: 'node-too-old' })
    const rejected = derivePeerCheckSteps(parsePeerCheckOutput(output(), 3081), { reachable: true, authOk: false, status: 401 })
    expect(rejected.steps.at(-1)).toMatchObject({ id: 'https', state: 'fail', reason: 'auth-failed', actions: ['restart', 'retry'] })
  })
})

describe('serve permission and service control scripts', () => {
  it('serve tries the user first, then sudo -n, and exits 4 when both are refused', () => {
    const script = buildServeScript(3081)
    const user = script.indexOf('"$ts" serve --bg')
    const sudo = script.indexOf('sudo -n "$ts" serve --bg')
    expect(user).toBeGreaterThan(-1)
    expect(sudo).toBeGreaterThan(user)
    expect(script).toContain('exit 4')
    expect(manualServeCommands(3081)).toEqual(['sudo tailscale set --operator=$USER', 'tailscale serve --bg --https=443 http://127.0.0.1:3081'])
  })

  it('start/restart use systemctl (user unit, system unit via sudo -n) and re-read the token into peer.json', () => {
    const restart = buildServiceScript('restart', 'managed', 3081)
    expect(restart).toContain('systemctl --user restart "$unit"')
    expect(restart).toContain('sudo -n systemctl restart "$unit"')
    expect(restart).toContain('threadharbor-dsh-web-managed.service')
    expect(restart).toContain('LAUNCH_URL=')
    expect(restart).toContain('peer.json')
    expect(restart).not.toContain('dsh plugin')
    expect(buildServiceScript('start', 'managed', 3081)).toContain('systemctl --user start "$unit"')
    expect(() => buildServiceScript('stop' as never, 'managed', 3081)).toThrow()
    expect(() => buildServiceScript('start', 'a b', 3081)).toThrow()
  })
})

describe('probeServeHttps', () => {
  it('reports reachability and token acceptance', async () => {
    const seen: string[] = []
    const fetcher = (async (url: string) => {
      seen.push(url)
      return new Response(null, { status: url.includes('token=') ? 302 : 401 })
    }) as unknown as typeof fetch
    expect(await probeServeHttps('https://box.ts.net', 'a b', fetcher)).toEqual({ reachable: true, status: 302, authOk: true })
    expect(seen).toEqual(['https://box.ts.net/', 'https://box.ts.net/?token=a%20b'])
  })

  it('reports network failure as unreachable', async () => {
    const fetcher = (async () => { throw new Error('ENOTFOUND') }) as unknown as typeof fetch
    expect(await probeServeHttps('https://box.ts.net', 'x', fetcher)).toEqual({ reachable: false, error: 'ENOTFOUND' })
  })
})
