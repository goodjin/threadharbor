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
 *
 * The exec + parse core is {@link queryTailscalePeers}: mobile-entry 的
 * peers 接口 shares this same query; the bridge only adds the document
 * writes around it.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
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

/**
 * BackendState 不是 Running 时，说清为什么清单是空的。
 * `tailscale status --json` 在未登录/已停止时照样 exit 0、照样吐 JSON，所以命令层
 * 看不出坏——只有 BackendState 能分出「空是因为 tailnet 上没有 peer」还是「空是因为
 * tailnet 根本没起来」。返回 undefined 表示没事，runOnce 照常清掉 error 键。
 * @param status - 解析后的 status 文档；形状不对就读不到，当没事处理。
 */
function backendStateNote(status: unknown): string | undefined {
  if (!isRecord(status)) return undefined
  const state = status['BackendState']
  if (state === 'NeedsLogin') return 'Tailscale 未登录：先在这台机器上登录，peer 清单才会出现。'
  if (state === 'Stopped') return 'Tailscale 已停止：启动它之后 peer 清单才会出现。'
  return undefined
}

/** The slice of the tailscale CLI runner this query needs; injectable for tests. */
export type TailscaleStatusRun = (file: string, args: string[]) => Promise<{ readonly stdout: string }>

/**
 * The real command runner: node's execFile, promisified, carrying the same
 * timeout and buffer ceiling the bridge has always used.
 */
const execTailscale: TailscaleStatusRun = async (file, args) => {
  const { stdout } = await promisify(execFile)(file, args, { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 })
  return { stdout }
}

/**
 * Run `tailscale status --json` once and fold its stdout into the peer list.
 * 失败不抛是这份查询的合同：命令没装、没登录、输出不是 JSON，全都折成
 * 空清单加原因（error 字段），跟写进 host-store 的 error 键同一段话。
 * mobile-entry 的 peers 接口走同一份——两个消费方，一份解析。
 * @param run - the command runner; the default is node's promisified execFile.
 * @returns the folded peer list, plus the reason the list is empty when the command said nothing useful.
 */
export async function queryTailscalePeers(
  run: TailscaleStatusRun = execTailscale,
): Promise<{ peers: readonly TailscalePeer[]; error?: string }> {
  let stdout: string
  try {
    stdout = (await run('tailscale', ['status', '--json'])).stdout
  } catch (error) {
    // ENOENT（没装）和非零退出（最常见是没登录）是两种最常见的坏。
    // stderr 带着人话原因，原样跟出去，「为什么是空的」才有内容。
    const detail = stderrTextOf(error)
    return { peers: [], error: `tailscale status --json 失败：${messageOf(error)}${detail === '' ? '' : `：${detail}`}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return { peers: [], error: `tailscale status --json 的输出不是 JSON：${stdout.slice(0, 120)}` }
  }
  const peers = parseTailscaleStatus(parsed)
  // BackendState 不是 Running 时（最常见是未登录），说清为什么清单是空的。
  const note = backendStateNote(parsed)
  return note === undefined ? { peers } : { peers, error: note }
}

/** The stderr a failed command run carried, as text; most rejections carry none. */
function stderrTextOf(error: unknown): string {
  const stderr: unknown = (error as { stderr?: unknown } | null)?.['stderr']
  if (typeof stderr === 'string') return stderr.trim()
  return Buffer.isBuffer(stderr) ? stderr.toString().trim() : ''
}

/** The settings face this bridge writes through — describe and mutate, bound. */
export type TailscaleSettingsFace = {
  describe(): Promise<unknown>
  mutate(ns: string, ops: readonly unknown[]): Promise<unknown>
}

/** What the bridge needs from its host; everything is a port so tests stay hermetic. */
export type TailscaleBridgeDeps = {
  /** One tailscale query; undefined = the real promisified execFile. */
  run?: TailscaleStatusRun
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
  // 清单与原因（命令失败、未登录、已停止）都由 queryTailscalePeers 折好；
  // 这里只管把这一拍写进文档：peers 键、应答键、error 键。
  const { peers, error: note } = await queryTailscalePeers(deps.run)
  const ops: unknown[] = [
    { op: 'set', path: ['data', TAILSCALE_PEERS_KEY], value: JSON.stringify(peers) },
    // 应答键写「消费到的那一拍」，不是本地时钟：面板比对的是它自己写下去的值。
    { op: 'set', path: ['data', TAILSCALE_REFRESHED_KEY], value: demand },
    note === undefined
      ? { op: 'unset', path: ['data', TAILSCALE_ERROR_KEY] }
      : { op: 'set', path: ['data', TAILSCALE_ERROR_KEY], value: note },
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
