/**
 * The host-side half of the Tailscale host picker.
 *
 * The 各主机 panel runs in the browser and has no way to run commands on the
 * machine serving the page — its only host-side channels are the settings
 * document and the session gateway, and the gateway drives agents, not
 * commands. So `tailscale status --json` runs HERE, on the serving machine,
 * and the result travels to the panel through the one document the browser can
 * already read: the `threadharbor-host-store` namespace's `data` dictionary
 * (see {@link ./tailscale-keys.ts} for the exact keys).
 *
 * This is a behavioral entry, not a carrier like host-store.ts: it is inserted
 * into the composition by cordis.patch.yml and cordis calls
 * `apply(ctx, config)` on it (the loader imports the module named by the
 * entry, unwraps the exports, and starts the object's `apply` as the plugin
 * body once its injected services are available). It deliberately declares no
 * volatile Config of its own — a second settings namespace would be one more
 * form for nothing; the peers live in the host-store namespace the browser
 * already addresses.
 *
 * Failure never throws: tailscale missing, not logged in, or answering
 * nonsense all land in the document as an empty list plus the reason, because
 * a picker that silently shows nothing is indistinguishable from a bridge
 * that never loaded.
 */

import { execFile } from 'node:child_process'
import { HOST_STORE_ENTRY_ID } from './host-store-id.ts'
import {
  TAILSCALE_ERROR_KEY,
  TAILSCALE_PEERS_KEY,
  TAILSCALE_REFRESHED_KEY,
  TAILSCALE_REFRESH_KEY,
  type TailscalePeer,
} from './tailscale-keys.ts'

export {
  HOST_STORE_ENTRY_ID,
  TAILSCALE_ERROR_KEY,
  TAILSCALE_PEERS_KEY,
  TAILSCALE_REFRESHED_KEY,
  TAILSCALE_REFRESH_KEY,
}
export type { TailscalePeer }

export const name = 'threadharbor-tailscale'

/** One entry of `tailscale status --json`, narrowed to the fields this bridge reads. */
type StatusNode = {
  readonly DNSName?: unknown
  readonly HostName?: unknown
  readonly TailscaleIPs?: unknown
  readonly Online?: unknown
}

/**
 * Fold a parsed `tailscale status --json` document into the picker's peer list.
 * Self comes first, peers follow sorted by name, so the list reads the same
 * way no matter which order the CLI printed the map in.
 * @param status - the parsed JSON document, however wrong it turns out to be.
 * @returns Self and every usable peer; entries with no carrier address are dropped.
 */
export function parseTailscaleStatus(status: unknown): readonly TailscalePeer[] {
  if (!isRecord(status)) return []
  const peers: TailscalePeer[] = []
  const self = nodeOf(status['Self'])
  if (self !== undefined) {
    const peer = peerOf(self)
    if (peer !== undefined) peers.push(peer)
  }
  const map = status['Peer']
  if (!isRecord(map)) return peers
  for (const value of Object.values(map)) {
    const node = nodeOf(value)
    if (node === undefined) continue
    const peer = peerOf(node)
    if (peer !== undefined) peers.push(peer)
  }
  // Self 已在队首；其余按名字排，输出顺序不再跟着 CLI 的 map 顺序走。
  const [head, ...rest] = peers
  return [head, ...rest.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)]
    .filter((peer): peer is TailscalePeer => peer !== undefined)
}

/** Narrow one status entry; anything that is not a plain record reads as absent. */
function nodeOf(value: unknown): StatusNode | undefined {
  return isRecord(value) ? value : undefined
}

/** One status entry to a peer, or undefined when it carries no address at all. */
function peerOf(node: StatusNode): TailscalePeer | undefined {
  const ip = carrierAddressOf(node['TailscaleIPs'])
  if (ip === undefined) return undefined
  const dns = textOf(node['DNSName']).replace(/\.$/, '')
  const host = textOf(node['HostName'])
  return {
    // MagicDNS 名最稳（换 IP 不换名字），HostName 次之，最后退到 IP 本身——
    // 没开 MagicDNS 的机器也得住进清单里，地址照样能用。
    name: dns !== '' ? dns : host !== '' ? host : ip,
    ip,
    online: node['Online'] === true,
  }
}

/** The first 100.x address of a TailscaleIPs array; anything else reads as absent. */
function carrierAddressOf(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    if (entry.startsWith('100.')) return entry
  }
  return undefined
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** What one status run produced, whatever went wrong. */
export type TailscaleStatusOutcome =
  | { readonly ok: true; readonly status: unknown }
  | { readonly ok: false; readonly reason: string }

/** The slice of node:child_process execFile this bridge needs; injectable for tests. */
export type ExecFileFace = (
  file: string,
  args: readonly string[],
  options: { readonly timeout: number; readonly maxBuffer: number },
  callback: (error: { readonly message: string; readonly code?: string | number | null | undefined } | null, stdout: string | Buffer, stderr: string | Buffer) => void,
) => void

/** The real command runner: node's execFile, adapted to the face. */
const nodeExecFile: ExecFileFace = (file, args, options, callback) => {
  execFile(file, args, options, (error, stdout, stderr) => { callback(error, stdout, stderr) })
}

/**
 * Run `tailscale status --json` once and parse its stdout.
 * @param exec - the command runner; the default is node's execFile.
 * @returns the parsed document, or the reason the run said nothing useful.
 */
export async function runTailscaleStatus(exec: ExecFileFace = nodeExecFile): Promise<TailscaleStatusOutcome> {
  return await new Promise<TailscaleStatusOutcome>(resolve => {
    exec('tailscale', ['status', '--json'], { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error !== null) {
        // ENOENT（没装）和非零退出（最常见是没登录）是两种最常见的坏。
        // stderr 带着人话原因，原样跟出去，面板上那句「为什么是空的」才有内容。
        const detail = stderr.toString().trim()
        resolve({ ok: false, reason: `tailscale status --json 失败：${error.message}${detail === '' ? '' : `：${detail}`}` })
        return
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(stdout.toString())
      } catch {
        resolve({ ok: false, reason: `tailscale status --json 的输出不是 JSON：${stdout.toString().slice(0, 120)}` })
        return
      }
      resolve({ ok: true, status: parsed })
    })
  })
}

/** The settings face this bridge writes through — describe and mutate, bound. */
export type TailscaleSettingsFace = {
  describe(): Promise<unknown>
  mutate(ns: string, ops: readonly unknown[]): Promise<unknown>
}

/** What the bridge needs from its host; everything is a port so tests stay hermetic. */
export type TailscaleBridgeDeps = {
  /** One status run. */
  status(): Promise<TailscaleStatusOutcome>
  /** The settings service of this machine (already resolved). */
  settings: TailscaleSettingsFace
  /** Fires on every settings document change; the argument is the namespace id. */
  onDocumentUpdated(handler: (ns: string) => void): () => void
  /** Where self-report lines go. */
  say(message: string): void
}

/** A started bridge whose async work a test can wait out. */
export type TailscaleBridge = {
  /** Resolves once the startup run and every refresh drain started so far settled. */
  settled(): Promise<void>
}

/**
 * Run the bridge: write the tailnet once now, then again whenever the panel
 * bumps the refresh key.
 *
 * The refresh demand is consumed through the document, not trusted from the
 * event: the event only says 「host-store 变了」, and the drain re-reads the
 * document to find out whether THAT change is an unanswered demand. This is
 * also what keeps the bridge's own writes from feeding back into itself —
 * it consumes the demand value before the first write, so the
 * document-updated its own writes trigger reads a demand already served.
 * @param deps - the command, channel, event and reporting ports.
 */
export function startTailscaleBridge(deps: TailscaleBridgeDeps): TailscaleBridge {
  /** The refresh demand this bridge has already served ('' = the startup run). */
  let served = ''
  /** Chain of in-flight work; `settled()` hands it out so tests can wait. */
  let tail: Promise<void> = Promise.resolve()
  let draining = false

  const enqueue = (step: () => Promise<void>): void => {
    tail = tail.then(step, step)
  }

  /** Serve every refresh demand standing at read time, then stop. */
  const drain = (): void => {
    if (draining) return
    draining = true
    enqueue(async () => {
      try {
        for (;;) {
          const demand = await demandOf(deps)
          if (demand === undefined || demand === served) break
          served = demand
          await runOnce(deps, demand)
        }
      } catch (error) {
        deps.say(`刷新循环中断：${messageOf(error)}`)
      } finally {
        draining = false
      }
    })
  }

  // 启动即跑一次：面板第一次打开就有清单可读，不用先点刷新。
  enqueue(async () => {
    try {
      served = await demandOf(deps) ?? ''
    } catch (error) {
      deps.say(`启动读取失败：${messageOf(error)}`)
      return
    }
    await runOnce(deps, served)
  })
  deps.onDocumentUpdated(ns => {
    if (ns !== HOST_STORE_ENTRY_ID) return
    drain()
  })

  return {
    settled: () => tail,
  }
}

/** The refresh demand standing in the document right now, or undefined when unreadable. */
async function demandOf(deps: TailscaleBridgeDeps): Promise<string | undefined> {
  const data = await documentDataOf(deps)
  return data?.[TAILSCALE_REFRESH_KEY] ?? ''
}

/** Write one full picture: peers, the error note, and which demand this was. */
async function runOnce(deps: TailscaleBridgeDeps, demand: string): Promise<void> {
  const outcome = await deps.status()
  const ops: unknown[] = [
    { op: 'set', path: ['data', TAILSCALE_PEERS_KEY], value: JSON.stringify(outcome.ok ? parseTailscaleStatus(outcome.status) : []) },
    // 应答键写「消费到的那一拍」，不是本地时钟：面板比对的是它自己写下去的值。
    { op: 'set', path: ['data', TAILSCALE_REFRESHED_KEY], value: demand },
    outcome.ok
      ? { op: 'unset', path: ['data', TAILSCALE_ERROR_KEY] }
      : { op: 'set', path: ['data', TAILSCALE_ERROR_KEY], value: outcome.reason },
  ]
  try {
    await deps.settings.mutate(HOST_STORE_ENTRY_ID, ops)
  } catch (error) {
    deps.say(`清单写不进 threadharbor-host-store：${messageOf(error)}`)
  }
}

/** The host-store data dictionary as the settings service serves it right now. */
async function documentDataOf(deps: TailscaleBridgeDeps): Promise<Record<string, string> | undefined> {
  const described: unknown = await deps.settings.describe()
  // 本机直连的服务返回描述数组；过一层远端包装的形状（{namespaces} / {ok,value}）
  // 一并认下，读账的代码就不用关心它站在哪一侧。
  const answered = isRecord(described) && typeof described['ok'] === 'boolean' ? described['value'] : described
  const rows = Array.isArray(answered)
    ? answered
    : isRecord(answered) && Array.isArray(answered['namespaces'])
      ? answered['namespaces']
      : []
  const view = rows.find(row => isRecord(row) && row['ns'] === HOST_STORE_ENTRY_ID)
  if (!isRecord(view)) return undefined
  const value = isRecord(view['value']) ? view['value']['data'] : undefined
  return stringRecord(value)
}

/**
 * Mount. Asks the host context for the settings service through a child-scope
 * injection — the same pattern host-store.ts uses — because a module-level
 * `inject` would park this whole entry waiting for a service the composition
 * resolves later, and a parked behavioral entry is an invisible one.
 * @param ctx - the host context; only the logger and inject facets are used.
 * @param _config - the composition entry carries no config for this entry.
 */
export function apply(ctx: unknown, _config: unknown): void {
  const say = sayOf(ctx)
  const injectFacet = isRecord(ctx) && typeof ctx['inject'] === 'function'
    ? ctx['inject'] as (names: readonly string[], run: (child: unknown) => void) => void
    : undefined
  if (injectFacet === undefined) {
    say('settings service not reachable from this entry — the bridge cannot start; is this entry mounted outside a cordis host?')
    return
  }
  injectFacet(['settings'], child => {
    const service = isRecord(child) ? child['settings'] : undefined
    const describe = boundOf(service, 'describe')
    const mutate = boundOf(service, 'mutate')
    const onFacet = boundOf(child, 'on')
    if (describe === undefined || mutate === undefined) {
      say('settings service did not reach this entry with describe/mutate — the bridge stays idle rather than writing through a guessed face')
      return
    }
    const listen = onFacet === undefined
      ? (handler: (ns: string) => void): (() => void) => {
          // 没有事件面就没有按需刷新；启动那一次照跑，但要说清少了什么。
          say('this context offers no event facet — the picker 的「刷新」将没有应答，只有启动时那一次清单')
          return () => {}
        }
      : (handler: (ns: string) => void): (() => void) =>
          onFacet('settings/document-updated', (ns: unknown) => { handler(typeof ns === 'string' ? ns : '') }) as () => void
    startTailscaleBridge({
      status: () => runTailscaleStatus(),
      settings: {
        describe: async () => await describe(),
        mutate: async (ns, ops) => await mutate(ns, ops),
      },
      onDocumentUpdated: listen,
      say,
    })
    say(`bridge mounted: tailnet peers land in ${HOST_STORE_ENTRY_ID} data.${TAILSCALE_PEERS_KEY} (refresh via data.${TAILSCALE_REFRESH_KEY})`)
  })
}

/** Self-report through whatever logger face the host offers, then stderr. */
function sayOf(ctx: unknown): (message: string) => void {
  return message => {
    const logger = isRecord(ctx) ? ctx['logger'] : undefined
    const named = typeof logger === 'function' ? logger('threadharbor-tailscale') : undefined
    if (isRecord(named) && typeof named['info'] === 'function') named['info'](message)
    process.stderr.write(`[threadharbor] tailscale: ${message}\n`)
  }
}

/** A named method of a holder, bound to it; anything else reads as absent. */
function boundOf(holder: unknown, method: string): ((...args: unknown[]) => unknown) | undefined {
  if (!isRecord(holder)) return undefined
  let value: unknown
  try {
    value = holder[method]
  } catch {
    return undefined
  }
  return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(holder) : undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** Whether a value is a plain record whose every value is a string. */
function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  for (const entry of Object.values(value)) {
    if (typeof entry !== 'string') return undefined
  }
  // 上面一圈已验过每个值都是 string；这一步收窄是结论，不是猜测。
  return value as Record<string, string>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
