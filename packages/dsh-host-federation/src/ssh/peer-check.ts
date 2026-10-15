/**
 * Step-by-step readiness check of a peer that will be reached over
 * `tailscale serve` (https://<host>.<tailnet>.ts.net → 127.0.0.1:<DSH port>).
 *
 * One SSH round trip runs {@link buildPeerCheckScript}; it prints `KEY=VALUE`
 * markers (JSON payloads base64-encoded so newlines cannot break the framing).
 * {@link parsePeerCheckOutput} turns them into facts and {@link derivePeerCheckSteps}
 * into the ordered status list the UI renders. Everything here is pure so it
 * is unit-testable without a remote machine; the HTTPS probe is done by the
 * caller and passed in.
 */

import { parsePeerStatus, type PeerStatus } from './peer-status.ts'

export type PeerCheckStepId =
  | 'ssh'
  | 'tailscale'
  | 'node'
  | 'dsh'
  | 'plugins'
  | 'running'
  | 'serve'
  | 'https'

export type PeerCheckState = 'ok' | 'fail' | 'warn' | 'skip'

/** Actions the UI can trigger over SSH for a step. */
export type PeerCheckAction = 'deploy' | 'start' | 'restart' | 'serve' | 'retry'

export type PeerCheckStep = {
  readonly id: PeerCheckStepId
  readonly state: PeerCheckState
  /** Short machine-readable fact (version, DNS name, URL…); the UI localizes the label. */
  readonly detail?: string
  /** Reason code when not ok, e.g. `not-installed`, `logged-out`, `node-too-old`. */
  readonly reason?: string
  readonly actions: readonly PeerCheckAction[]
}

/** Raw facts read over SSH. */
export type PeerCheckFacts = {
  readonly sshOk: boolean
  readonly tailscaleInstalled: boolean
  readonly tailscaleBackendState?: string
  /** MagicDNS name without trailing dot, e.g. `box.tail1234.ts.net`. */
  readonly magicDnsName?: string
  readonly nodeVersion?: string
  readonly dshVersion?: string
  readonly peer: PeerStatus
  /** HTTP status of the loopback health probe on the remote (0 = no answer). */
  readonly healthCode: number
  /** Origin served by `tailscale serve` that proxies to the DSH port, if any. */
  readonly serveUrl?: string
  /** The serve config exists but proxies other ports only. */
  readonly serveOther: boolean
  readonly port: number
}

/** Result of the caller's HTTPS probe through the ts.net URL. */
export type PeerHttpsProbe = {
  readonly reachable: boolean
  /** The tokenized URL was accepted (`undefined` = no token to test). */
  readonly authOk?: boolean
  readonly status?: number
  readonly error?: string
}

export type PeerCheckReport = {
  readonly steps: readonly PeerCheckStep[]
  readonly facts: PeerCheckFacts
  /** `https://<magicdns>/?token=…` when every step passed; save this. */
  readonly serveLaunchUrl?: string
  readonly ready: boolean
}

export const MIN_NODE_MAJOR = 22

/** Remote script: never exits non-zero on a missing piece, it reports it. */
export function buildPeerCheckScript(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('port 无效')
  return [
    'export PATH="$HOME/.local/bin:$HOME/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"',
    'b64() { base64 | tr -d "\\n"; }',
    'echo SSH_OK=1',
    'ts="$(command -v tailscale 2>/dev/null || true)"',
    'if [ -z "$ts" ] && [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then ts=/Applications/Tailscale.app/Contents/MacOS/Tailscale; fi',
    'if [ -n "$ts" ]; then echo TS_INSTALLED=1; echo "TS_STATUS_B64=$("$ts" status --json --peers=false 2>/dev/null | b64)"; echo "TS_SERVE_B64=$("$ts" serve status --json 2>/dev/null | b64)"; fi',
    'node_path="$(command -v node 2>/dev/null || true)"',
    'if [ -n "$node_path" ]; then echo "NODE_VERSION=$("$node_path" -v 2>/dev/null)"; fi',
    'dsh_path="$(command -v dsh 2>/dev/null || true)"',
    'if [ -n "$dsh_path" ]; then echo "DSH_VERSION=$("$dsh_path" --version 2>/dev/null | head -1)"; fi',
    'echo "PEER_B64=$(cat "$HOME/.local/state/threadharbor/peer.json" 2>/dev/null | b64)"',
    `code="$(curl -sS -o /dev/null -w "%{http_code}" --max-time 3 http://127.0.0.1:${port}/ 2>/dev/null || true)"`,
    'echo "HEALTH=${code:-0}"',
    'exit 0',
  ].join('\n')
}

function decodeB64Json(value: string | undefined): unknown {
  if (value === undefined || value === '') return undefined
  try {
    const text = Buffer.from(value, 'base64').toString('utf8')
    return text.trim() === '' ? undefined : JSON.parse(text)
  } catch {
    return undefined
  }
}

function decodeB64Text(value: string | undefined): string {
  if (value === undefined || value === '') return ''
  try {
    return Buffer.from(value, 'base64').toString('utf8')
  } catch {
    return ''
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Find the `tailscale serve` web handler that proxies to the DSH port.
 * Serve JSON shape: `{ Web: { "host.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3081" } } } } }`.
 */
export function findServeUrl(serve: unknown, port: number): { readonly url?: string; readonly other: boolean } {
  if (!isRecord(serve) || !isRecord(serve['Web'])) return { other: false }
  let other = false
  for (const [hostPort, web] of Object.entries(serve['Web'])) {
    if (!isRecord(web) || !isRecord(web['Handlers'])) continue
    for (const handler of Object.values(web['Handlers'])) {
      if (!isRecord(handler) || typeof handler['Proxy'] !== 'string') continue
      const proxy = handler['Proxy']
      const match = /^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost|\[::1\])?:?(\d+)\/?$/.exec(proxy.trim())
      const proxied = match?.[1] === undefined ? Number.NaN : Number(match[1])
      if (proxied === port) {
        const [host, servePort] = hostPort.split(/:(?=\d+$)/)
        if (host === undefined || host === '') continue
        return { url: servePort === undefined || servePort === '443' ? `https://${host}` : `https://${host}:${servePort}`, other }
      }
      other = true
    }
  }
  return { other }
}

export function parsePeerCheckOutput(stdout: string, port: number): PeerCheckFacts {
  const markers = new Map<string, string>()
  for (const line of stdout.split(/\r?\n/)) {
    const index = line.indexOf('=')
    if (index <= 0) continue
    const key = line.slice(0, index)
    if (!/^[A-Z_0-9]+$/.test(key)) continue
    markers.set(key, line.slice(index + 1).trim())
  }
  const status = decodeB64Json(markers.get('TS_STATUS_B64'))
  const self = isRecord(status) && isRecord(status['Self']) ? status['Self'] : undefined
  const backend = isRecord(status) && typeof status['BackendState'] === 'string' ? status['BackendState'] : undefined
  const dnsRaw = self !== undefined && typeof self['DNSName'] === 'string' ? self['DNSName'] : ''
  const magicDnsName = dnsRaw.replace(/\.$/, '')
  const serve = findServeUrl(decodeB64Json(markers.get('TS_SERVE_B64')), port)
  const peer = parsePeerStatus(decodeB64Text(markers.get('PEER_B64')))
  const health = Number(markers.get('HEALTH') ?? '0')
  const nodeVersion = markers.get('NODE_VERSION')
  const dshVersion = markers.get('DSH_VERSION')
  return {
    sshOk: markers.get('SSH_OK') === '1',
    tailscaleInstalled: markers.get('TS_INSTALLED') === '1',
    ...(backend === undefined ? {} : { tailscaleBackendState: backend }),
    ...(magicDnsName === '' ? {} : { magicDnsName }),
    ...(nodeVersion === undefined || nodeVersion === '' ? {} : { nodeVersion }),
    ...(dshVersion === undefined || dshVersion === '' ? {} : { dshVersion }),
    peer,
    healthCode: Number.isFinite(health) ? health : 0,
    ...(serve.url === undefined ? {} : { serveUrl: serve.url }),
    serveOther: serve.other,
    port,
  }
}

export function nodeMajor(version: string | undefined): number | undefined {
  const match = /^v?(\d+)\./.exec(version?.trim() ?? '')
  return match?.[1] === undefined ? undefined : Number(match[1])
}

/** Token from the peer's recorded launch URL, if any. */
export function launchToken(peer: PeerStatus): string | undefined {
  if (peer.launchUrl === undefined) return undefined
  try {
    const token = new URL(peer.launchUrl).searchParams.get('token')
    return token === null || token === '' ? undefined : token
  } catch {
    return undefined
  }
}

/** The URL to save: the serve origin carrying the peer's launch token. */
export function serveLaunchUrl(facts: PeerCheckFacts): string | undefined {
  if (facts.serveUrl === undefined) return undefined
  const url = new URL(facts.serveUrl)
  url.pathname = '/'
  const token = launchToken(facts.peer)
  if (token !== undefined) url.searchParams.set('token', token)
  return url.toString()
}

const running = (code: number): boolean => code === 200 || code === 401 || (code >= 300 && code < 400)

/**
 * Ordered status list. A failed prerequisite turns later steps into `skip`
 * so the UI shows exactly one next action instead of a wall of red.
 */
export function derivePeerCheckSteps(facts: PeerCheckFacts, https: PeerHttpsProbe | undefined): PeerCheckReport {
  const steps: PeerCheckStep[] = []
  let blocked = false
  const push = (step: PeerCheckStep): void => {
    if (blocked) {
      steps.push({ id: step.id, state: 'skip', actions: [] })
      return
    }
    steps.push(step)
    if (step.state === 'fail') blocked = true
  }

  push(facts.sshOk ? { id: 'ssh', state: 'ok', actions: [] } : { id: 'ssh', state: 'fail', reason: 'unreachable', actions: ['retry'] })

  // Tailscale is independent of DSH install: a failure here does not block
  // deploying, but does block serve/https. Track it separately.
  let tailscaleOk = false
  if (!blocked) {
    if (!facts.tailscaleInstalled) {
      steps.push({ id: 'tailscale', state: 'fail', reason: 'not-installed', actions: ['retry'] })
    } else if (facts.tailscaleBackendState !== undefined && facts.tailscaleBackendState !== 'Running') {
      steps.push({ id: 'tailscale', state: 'fail', reason: 'logged-out', detail: facts.tailscaleBackendState, actions: ['retry'] })
    } else if (facts.magicDnsName === undefined) {
      steps.push({ id: 'tailscale', state: 'fail', reason: 'no-magicdns', actions: ['retry'] })
    } else {
      tailscaleOk = true
      steps.push({ id: 'tailscale', state: 'ok', detail: facts.magicDnsName, actions: [] })
    }
  } else {
    steps.push({ id: 'tailscale', state: 'skip', actions: [] })
  }

  const major = nodeMajor(facts.nodeVersion)
  push(major === undefined
    ? { id: 'node', state: 'fail', reason: 'not-installed', actions: ['retry'] }
    : major < MIN_NODE_MAJOR
      ? { id: 'node', state: 'fail', reason: 'node-too-old', detail: facts.nodeVersion ?? '', actions: ['retry'] }
      : { id: 'node', state: 'ok', detail: facts.nodeVersion ?? '', actions: [] })

  push(facts.dshVersion === undefined
    ? { id: 'dsh', state: 'fail', reason: 'not-installed', actions: ['deploy'] }
    : { id: 'dsh', state: 'ok', detail: facts.dshVersion, actions: ['deploy'] })

  push(facts.peer.pluginsInstalled
    ? { id: 'plugins', state: 'ok', actions: ['deploy'] }
    : { id: 'plugins', state: 'fail', reason: 'not-deployed', actions: ['deploy'] })

  push(running(facts.healthCode)
    ? { id: 'running', state: 'ok', detail: `127.0.0.1:${facts.port}`, actions: ['restart'] }
    : { id: 'running', state: 'fail', reason: 'not-running', detail: `127.0.0.1:${facts.port}`, actions: ['start'] })

  if (!blocked && !tailscaleOk) blocked = true

  push(facts.serveUrl !== undefined
    ? { id: 'serve', state: 'ok', detail: facts.serveUrl, actions: ['serve'] }
    : { id: 'serve', state: 'fail', reason: facts.serveOther ? 'other-port' : 'not-configured', actions: ['serve'] })

  if (https === undefined) {
    push({ id: 'https', state: 'fail', reason: 'not-checked', actions: ['retry'] })
  } else if (!https.reachable) {
    push({ id: 'https', state: 'fail', reason: 'unreachable', ...(https.error === undefined ? {} : { detail: https.error }), actions: ['retry'] })
  } else if (https.authOk === false) {
    push({ id: 'https', state: 'fail', reason: 'auth-failed', ...(https.status === undefined ? {} : { detail: String(https.status) }), actions: ['restart', 'retry'] })
  } else if (https.authOk === undefined) {
    push({ id: 'https', state: 'warn', reason: 'no-token', actions: ['restart', 'retry'] })
  } else {
    push({ id: 'https', state: 'ok', detail: facts.serveUrl ?? '', actions: ['retry'] })
  }

  const ready = steps.every(step => step.state === 'ok')
  const url = ready ? serveLaunchUrl(facts) : undefined
  return { steps, facts, ready, ...(url === undefined ? {} : { serveLaunchUrl: url }) }
}

/** Remote command that points `tailscale serve` (HTTPS 443) at the DSH loopback port. */
export function buildServeScript(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('port 无效')
  return [
    'export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"',
    'ts="$(command -v tailscale 2>/dev/null || true)"',
    'if [ -z "$ts" ] && [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then ts=/Applications/Tailscale.app/Contents/MacOS/Tailscale; fi',
    'if [ -z "$ts" ]; then echo "tailscale not installed" >&2; exit 3; fi',
    `if "$ts" serve --bg --https=443 http://127.0.0.1:${port} 2>/tmp/threadharbor-serve.err; then exit 0; fi`,
    // Linux without `tailscale set --operator=$USER` needs root; try non-interactive sudo once.
    `if command -v sudo >/dev/null 2>&1 && sudo -n "$ts" serve --bg --https=443 http://127.0.0.1:${port}; then exit 0; fi`,
    'cat /tmp/threadharbor-serve.err >&2',
    'echo "hint: run \\"sudo tailscale set --operator=$USER\\" on the peer once, then retry" >&2',
    'exit 1',
  ].join('\n')
}
