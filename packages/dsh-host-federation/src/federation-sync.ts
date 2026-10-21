/**
 * 主机之间的登记簿互通：让任意一台 DSH 都能看到并使用其余已部署的主机。
 *
 * 浏览器侧的名单只跟着"这台机器"的设置文档走，同源广播也只覆盖同一个源的
 * 标签页——所以 A 登记了 B，B 并不知道 A，更不知道 A 还登记了 C。这个宿主
 * 条目补上这一半：浏览器报到（announce）说出自己是谁，宿主据此铸出自己的
 * 带令牌入口，再把"自己 + 自己知道的主机"推给登记簿里的每一台（push）。
 * 对端用同样宽容的规则合并：已登记的条目以本机为准（地址、SSH、读数都
 * 不被改写），只补缺失的令牌；没见过的条目按对端推来的事实新增。
 *
 * 为什么报到走浏览器而不是宿主自己猜：hostId 与显示名是浏览器侧的身份
 * 配置（dsh-client 的 rollup-section / settings-source），宿主侧没有这份
 * 信息。浏览器只报身份，地址与令牌一律由宿主按请求来源自己铸——浏览器
 * 传来的 URL 一个字节都不采信。
 *
 * 同样在这个条目里出手机配对接口：它铸的是完整 DSH 界面的带令牌网址
 * （不是中转页的精简 SPA），手机配到任意一台主机后，就能用那台主机的
 * 网关切换到其余主机。
 */

import Schema from '@deepseek-ai/schemastery'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { exchangeAuthCookie } from './host-remote-sessions.ts'
import { HOST_STORE_ENTRY_ID } from './host-store-id.ts'
import { HOST_REGISTRY_KEY, normalizeAddress, parseRegistration, type HostRegistration } from './registry.ts'
import {
  FEDERATION_ANNOUNCE_PATH,
  FEDERATION_PUSH_PATH,
  FULL_UI_PAIR_PATH,
  HOST_ACCESS_ORIGIN_KEY,
  HOST_SELF_KEY,
  isLoopbackOrigin,
  normalizeAccessOrigin,
  originOfRequest,
  parseSelfRecord,
  type HostSelfRecord,
} from './federation-keys.ts'
import { mergeFederationRegistry } from './federation-merge.ts'

export const name = 'threadharbor-federation-sync'

/** webServer mounts the routes; connection admits the browser and mints tokens. */
export const inject = ['webServer', 'connection']

export const Config: Schema = Schema.object({})

const SYNC_TICK_MS = 5_000
const PUSH_REFRESH_MS = 10 * 60 * 1000
const PUSH_RETRY_MS = 60_000
const PUSH_TIMEOUT_MS = 8_000
const ANNOUNCE_LIMIT_BYTES = 4 * 1024
const PUSH_LIMIT_BYTES = 256 * 1024

type Admission = { readonly peer: unknown } | { readonly rejection: 401 | 403 }

type ConnectionFace = {
  admit(req: IncomingMessage): Admission
  authenticatedUrl?(baseUrl: string): string
}

type SettingsFace = {
  describe(): Promise<unknown>
  mutate(ns: string, ops: readonly unknown[], expectedRevision?: number): Promise<unknown>
}

type DocSnapshot = {
  readonly data: Record<string, string>
  readonly revision: number | undefined
}

type Route = {
  kind: 'exact'
  path: string
  handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>
}

type WebServerFace = {
  register(route: Route): () => void
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * Mount the entry: three routes plus a slow reconciler that pushes when the
 * self record or the registry changed (and refreshes everything every ten
 * minutes, which refreshes peers' copy of this host's launch token).
 */
export function apply(ctx: unknown): void {
  const holder: { settings?: SettingsFace } = {}
  const connection = connectionOf(ctx)
  const web = webServerOf(ctx)
  const effect = effectOf(ctx)
  let timer: ReturnType<typeof setInterval> | undefined

  const sync = createSync({
    settings: () => holder.settings,
    log: say,
    // 进程重启后令牌会换。自述里记的地址仍是这台机器的对外源，直接用它
    // 重铸一次，对端不必等这台机器有人打开浏览器才恢复入口。
    remint: address => connection.authenticatedUrl?.(`${address}/`),
  })

  const routes: Route[] = [
    {
      kind: 'exact',
      path: FEDERATION_ANNOUNCE_PATH,
      handler: (req, res) => handleAnnounce(req, res, connection, holder.settings, sync),
    },
    {
      kind: 'exact',
      path: FEDERATION_PUSH_PATH,
      handler: (req, res) => handlePush(req, res, connection, holder.settings, sync),
    },
    {
      kind: 'exact',
      path: FULL_UI_PAIR_PATH,
      handler: (req, res) => handlePairUrl(req, res, connection, holder.settings),
    },
  ]
  for (const route of routes) {
    effect(() => web.register(route), `threadharbor-federation-sync: ${route.path}`)
  }

  bindSettings(ctx, face => {
    holder.settings = face
    sync.wake()
  })
  effect(() => {
    timer = setInterval(() => { sync.tick() }, SYNC_TICK_MS)
    sync.wake()
    return () => {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
    }
  }, 'threadharbor-federation-sync: timer')
  say(`mounted: browsers announce their identity, peers exchange registries, and ${FULL_UI_PAIR_PATH} points at the full UI`)
}

type Sync = {
  tick(force?: boolean): void
  wake(): void
}

/**
 * The reconciler. It reads the settings document often (5s) but only pushes
 * when the signature changed, a host is due for a token refresh, or a failed
 * host's backoff expired — so a quiet fleet stays quiet.
 */
function createSync(deps: {
  settings(): SettingsFace | undefined
  log(message: string): void
  /** Mints the current process's launch URL for a stored origin, if possible. */
  remint?(address: string): string | undefined
}): Sync {
  let lastSignature = ''
  let lastPushAt = 0
  let running = false
  let pending: ReturnType<typeof setTimeout> | undefined
  const failures = new Map<string, { message: string; at: number }>()

  const wake = (): void => {
    if (pending !== undefined) return
    pending = setTimeout(() => {
      pending = undefined
      void tick(true)
    }, 50)
    // Timers here only delay a local read; unref keeps a probe from holding
    // the host process open when the plugin is unloaded.
    pending.unref?.()
  }

  async function tick(force = false): Promise<void> {
    if (running) return
    const settings = deps.settings()
    if (settings === undefined) return
    running = true
    try {
      const doc = await readDoc(settings)
      if (doc === undefined) return
      let self = selfOf(doc)
      if (self === undefined) return
      if (deps.remint !== undefined) {
        const launchUrl = deps.remint(self.address)
        if (launchUrl !== undefined && launchUrl !== self.launchUrl) {
          const next: HostSelfRecord = { ...self, launchUrl, announcedAt: Date.now() }
          if (await writeKey(settings, HOST_SELF_KEY, JSON.stringify(next))) {
            self = next
            deps.log('self launch URL refreshed for this process')
          }
        }
      }
      const registryRaw = doc.data[HOST_REGISTRY_KEY]
      const hosts = registryOf(registryRaw)
      const signature = JSON.stringify([self, registryRaw ?? ''])
      const now = Date.now()
      if (!force && signature === lastSignature && now - lastPushAt < PUSH_REFRESH_MS && failures.size === 0) return
      let attempted = false
      for (const host of hosts) {
        if (host.hostId === self.hostId) continue
        if (host.launchUrl === undefined) continue
        const failed = failures.get(host.hostId)
        if (failed !== undefined && now - failed.at < PUSH_RETRY_MS) continue
        attempted = true
        try {
          await pushTo(host, { self, hosts: publicEntries(hosts) })
          if (failed !== undefined) {
            failures.delete(host.hostId)
            deps.log(`push to ${host.hostId} recovered`)
          }
        } catch (error) {
          const message = messageOf(error)
          failures.set(host.hostId, { message, at: Date.now() })
          if (failed?.message !== message) {
            // Never echo the launch URL or its token: only the host id and
            // the transport-level reason.
            deps.log(`push to ${host.hostId} failed: ${message}`)
          }
        }
      }
      lastSignature = signature
      if (attempted || hosts.every(host => host.launchUrl === undefined || host.hostId === self.hostId)) {
        lastPushAt = Date.now()
      }
    } catch (error) {
      deps.log(`sync tick failed: ${messageOf(error)}`)
    } finally {
      running = false
    }
  }

  return { tick, wake }
}

async function handleAnnounce(
  req: IncomingMessage,
  res: ServerResponse,
  connection: ConnectionFace,
  settings: SettingsFace | undefined,
  sync: Sync,
): Promise<void> {
  const denial = admit(connection, req, res)
  if (denial) return
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
  if (settings === undefined) return json(res, 503, { error: 'settings-unavailable' })
  const body = await readJson(req, ANNOUNCE_LIMIT_BYTES)
  if (!body.ok) return json(res, body.status, { error: body.error })
  const hostId = nonEmpty(body.value['hostId'])
  if (hostId === undefined || hostId.length > 64 || /[/\\]/.test(hostId) || /[\u0000-\u001f]/.test(hostId)) {
    return json(res, 400, { error: 'bad-host-id' })
  }
  const rawTitle = body.value['hostTitle']
  const hostTitle = typeof rawTitle === 'string' && rawTitle.trim() !== '' ? rawTitle.trim().slice(0, 200) : hostId

  const doc = await readDoc(settings).catch(() => undefined)
  if (doc === undefined) return json(res, 503, { error: 'settings-unreadable' })
  const configured = doc.data[HOST_ACCESS_ORIGIN_KEY]
  const access = configured === undefined ? undefined : normalizeAccessOrigin(configured)
  const origin = access !== undefined && access.ok ? access.origin : originOfRequest(req.headers, socketEncrypted(req))
  if (origin === undefined) return json(res, 400, { error: 'origin-unknown' })
  if (connection.authenticatedUrl === undefined) return json(res, 500, { error: 'authenticated-url-unavailable' })
  const launchUrl = connection.authenticatedUrl(`${origin}/`)
  const record: HostSelfRecord = { hostId, hostTitle, address: origin, launchUrl, announcedAt: Date.now() }
  const previous = selfOf(doc)
  const unchanged = previous !== undefined
    && previous.hostId === record.hostId
    && previous.hostTitle === record.hostTitle
    && previous.address === record.address
    && previous.launchUrl === record.launchUrl
  if (!unchanged) {
    const saved = await writeKey(settings, HOST_SELF_KEY, JSON.stringify(record))
    if (!saved) return json(res, 503, { error: 'settings-write-failed' })
    say(`self announced: ${hostId} at ${origin}`)
  }
  sync.wake()
  return json(res, 200, { ok: true, hostId })
}

async function handlePush(
  req: IncomingMessage,
  res: ServerResponse,
  connection: ConnectionFace,
  settings: SettingsFace | undefined,
  sync: Sync,
): Promise<void> {
  const denial = admit(connection, req, res)
  if (denial) return
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
  if (settings === undefined) return json(res, 503, { error: 'settings-unavailable' })
  const body = await readJson(req, PUSH_LIMIT_BYTES)
  if (!body.ok) return json(res, body.status, { error: body.error })
  const doc = await readDoc(settings).catch(() => undefined)
  if (doc === undefined) return json(res, 503, { error: 'settings-unreadable' })
  const self = selfOf(doc)
  if (self === undefined) return json(res, 409, { error: 'self-not-announced' })
  const merged = mergeFederationRegistry(doc.data[HOST_REGISTRY_KEY], body.value, self.hostId, Date.now())
  if (merged.changed) {
    const saved = await writeKey(settings, HOST_REGISTRY_KEY, merged.json)
    if (!saved) return json(res, 503, { error: 'settings-write-failed' })
    if (merged.added > 0 || merged.refreshed > 0) {
      say(`registry merged from a peer: ${merged.added} new, ${merged.refreshed} token(s) filled`)
    }
    sync.wake()
  }
  return json(res, 200, { ok: true, changed: merged.changed, added: merged.added })
}

async function handlePairUrl(
  req: IncomingMessage,
  res: ServerResponse,
  connection: ConnectionFace,
  settings: SettingsFace | undefined,
): Promise<void> {
  const denial = admit(connection, req, res)
  if (denial) return
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
  if (settings === undefined) return json(res, 503, { error: 'settings-unavailable' })
  if (connection.authenticatedUrl === undefined) return json(res, 500, { error: 'authenticated-url-unavailable' })
  const doc = await readDoc(settings).catch(() => undefined)
  const configured = doc?.data[HOST_ACCESS_ORIGIN_KEY]
  const access = configured === undefined ? undefined : normalizeAccessOrigin(configured)
  const origin = access !== undefined && access.ok ? access.origin : originOfRequest(req.headers, socketEncrypted(req))
  if (origin === undefined) return json(res, 500, { error: 'origin-unknown' })
  const url = connection.authenticatedUrl(`${origin}/`)
  // no-store: the URL carries the process token.
  return json(res, 200, { url, origin, loopback: isLoopbackOrigin(origin) }, true)
}

/** Only the facts a peer can use; SSH settings and remote reads stay home. */
function publicEntries(hosts: readonly HostRegistration[]): HostRegistration[] {
  return hosts.map(host => ({
    hostId: host.hostId,
    hostTitle: host.hostTitle,
    address: host.address,
    ...(host.launchUrl === undefined ? {} : { launchUrl: host.launchUrl }),
    createdAt: host.createdAt,
  }))
}

async function pushTo(host: HostRegistration, body: { self: HostSelfRecord; hosts: readonly HostRegistration[] }): Promise<void> {
  const launch = host.launchUrl === undefined ? undefined : safeUrl(host.launchUrl)
  const token = launch?.searchParams.get('token')
  if (launch === undefined || token === null || token === undefined || token === '') {
    throw new Error('登记里没有可用的打开地址')
  }
  const origin = launch.origin
  const cookie = await exchangeAuthCookie(origin, token)
  if (cookie === undefined) throw new Error('对端没有换出登录 cookie')
  const response = await fetch(`${origin}${FEDERATION_PUSH_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
  })
  if (response.status === 409) throw new Error('对端还没报到（等待它的页面打开一次）')
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
}

/** Read the host-store document; undefined when the namespace is absent. */
async function readDoc(settings: SettingsFace): Promise<DocSnapshot | undefined> {
  const described: unknown = await settings.describe()
  const rows = Array.isArray(described)
    ? described
    : isRecord(described) && Array.isArray(described['namespaces'])
      ? described['namespaces']
      : []
  const view = rows.find(row => isRecord(row) && row['ns'] === HOST_STORE_ENTRY_ID)
  if (!isRecord(view)) return undefined
  const value = isRecord(view['value']) ? view['value'] : {}
  const data = isRecord(value['data']) ? value['data'] : {}
  const plain: Record<string, string> = {}
  for (const [key, entry] of Object.entries(data)) {
    if (typeof entry === 'string') plain[key] = entry
  }
  return {
    data: plain,
    revision: typeof view['revision'] === 'number' ? view['revision'] : undefined,
  }
}

/** Write one data key, retrying once when another writer moved the revision. */
async function writeKey(settings: SettingsFace, key: string, value: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const doc = await readDoc(settings).catch(() => undefined)
    if (doc === undefined) return false
    try {
      await settings.mutate(HOST_STORE_ENTRY_ID, [{ op: 'set', path: ['data', key], value }], doc.revision)
      return true
    } catch {
      // A revision conflict is worth one retry; the next tick retries anyway.
    }
  }
  return false
}

function selfOf(doc: DocSnapshot): HostSelfRecord | undefined {
  const raw = doc.data[HOST_SELF_KEY]
  if (raw === undefined) return undefined
  try {
    return parseSelfRecord(JSON.parse(raw))
  } catch {
    return undefined
  }
}

function registryOf(raw: string | undefined): HostRegistration[] {
  if (raw === undefined || raw.trim() === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap(item => {
    const entry = parseRegistration(item)
    return entry === undefined ? [] : [entry]
  })
}

async function readJson(req: IncomingMessage, limit: number): Promise<
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly status: 400 | 413; readonly error: string }
> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    total += (chunk as Buffer).length
    if (total > limit) return { ok: false, status: 413, error: 'body-too-large' }
    chunks.push(chunk as Buffer)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!isRecord(parsed)) return { ok: false, status: 400, error: 'body-not-object' }
    return { ok: true, value: parsed }
  } catch {
    return { ok: false, status: 400, error: 'body-not-json' }
  }
}

function admit(connection: ConnectionFace, req: IncomingMessage, res: ServerResponse): boolean {
  const admission = connection.admit(req)
  if ('rejection' in admission) {
    res.writeHead(admission.rejection)
    res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
    return true
  }
  return false
}

function json(res: ServerResponse, status: number, body: unknown, noStore = false): void {
  const text = JSON.stringify(body)
  const headers: Record<string, string | number> = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  }
  if (noStore) headers['cache-control'] = 'no-store'
  res.writeHead(status, headers)
  res.end(text)
}

function methodNotAllowed(res: ServerResponse, allow: string): void {
  res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow })
  res.end('method not allowed')
}

function socketEncrypted(req: IncomingMessage): boolean {
  const socket = req.socket as { encrypted?: boolean }
  return socket.encrypted === true
}

function safeUrl(value: string): URL | undefined {
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function connectionOf(ctx: unknown): ConnectionFace {
  if (!isRecord(ctx) || !isRecord(ctx['connection']) || typeof ctx['connection']['admit'] !== 'function') {
    throw new Error('threadharbor-federation-sync requires the host connection service')
  }
  const connection = ctx['connection'] as Record<string, unknown>
  return {
    admit: req => (connection['admit'] as (request: IncomingMessage) => Admission).call(connection, req),
    ...(typeof connection['authenticatedUrl'] === 'function'
      ? { authenticatedUrl: (baseUrl: string) => (connection['authenticatedUrl'] as (url: string) => string).call(connection, baseUrl) }
      : {}),
  }
}

function webServerOf(ctx: unknown): WebServerFace {
  if (!isRecord(ctx) || !isRecord(ctx['webServer']) || typeof ctx['webServer']['register'] !== 'function') {
    throw new Error('threadharbor-federation-sync requires the host web server')
  }
  return ctx['webServer'] as WebServerFace
}

function effectOf(ctx: unknown): (run: () => unknown, label?: string) => void {
  if (!isRecord(ctx) || typeof ctx['effect'] !== 'function') return run => { run() }
  const effect = ctx['effect'] as (run: () => unknown, label?: string) => void
  return (run, label) => { effect(run, label) }
}

function bindSettings(ctx: unknown, accept: (face: SettingsFace) => void): void {
  if (!isRecord(ctx) || typeof ctx['inject'] !== 'function') {
    say('settings service not reachable — announce and push stay closed')
    return
  }
  const inject = ctx['inject'] as (names: readonly string[], run: (child: unknown) => void) => void
  inject(['settings'], child => {
    if (!isRecord(child) || !isRecord(child['settings'])) {
      say('settings service did not arrive — announce and push stay closed')
      return
    }
    const service = child['settings'] as Record<string, unknown>
    if (typeof service['describe'] !== 'function' || typeof service['mutate'] !== 'function') {
      say('settings service lacks describe/mutate — announce and push stay closed')
      return
    }
    const describe = service['describe'] as () => Promise<unknown>
    const mutate = service['mutate'] as (ns: string, ops: readonly unknown[], revision?: number) => Promise<unknown>
    accept({
      describe: () => describe.call(service),
      mutate: (ns, ops, revision) => mutate.call(service, ns, ops, revision),
    })
  })
}

function say(message: string): void {
  process.stderr.write(`[threadharbor] federation-sync: ${message}\n`)
}
