/**
 * Same-origin reverse proxy onto a registered host's own DSH.
 *
 * The browser calls the same APIs it would call on this machine. The only
 * difference is the path prefix, which names a host in the registry. This
 * process exchanges that host's launch token for a cookie and forwards the
 * bytes. The cookie stays here: it is not written into the browser, and the
 * browser's own session cookie is not forwarded upstream.
 */

import Schema from '@deepseek-ai/schemastery'
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Duplex } from 'node:stream'
import { exchangeAuthCookie } from './host-remote-sessions.ts'
import { HOST_REGISTRY_KEY } from './registry.ts'
import { HOST_STORE_ENTRY_ID } from './host-store-id.ts'
import {
  GATEWAY_PREFIX,
  GATEWAY_REWRITE_LIMIT_BYTES,
  GATEWAY_WS_PATH,
  listGatewayHosts,
  parseGatewayRequest,
  parseGatewayUpgrade,
  pointsAtPageHost,
  resolveLaunch,
  rewriteBody,
  rewriteKind,
  rewriteLocation,
  type GatewayPeer,
} from './host-gateway-path.ts'

export const name = 'threadharbor-host-gateway'

/** webServer mounts the prefix; connection admits the browser that loaded this page. */
export const inject = ['webServer', 'connection']

export const Config: Schema = Schema.object({})

const COOKIE_TTL_MS = 10 * 60 * 1000
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
const DROP_RESPONSE = new Set([
  'set-cookie',
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'proxy-authenticate',
  'trailer',
])
const DROP_ALWAYS = new Set([
  'cookie',
  'host',
  'origin',
  'referer',
  'proxy-authenticate',
  'proxy-authorization',
  'keep-alive',
  'transfer-encoding',
  'proxy-connection',
  'te',
  'trailer',
])
const DROP_HTTP_HOP = new Set(['connection', 'upgrade'])

type Admission = { readonly rejection: 401 | 403 } | { readonly peer: unknown }

type RegistryRead =
  | { readonly ready: false }
  | { readonly ready: true; readonly json: string | undefined }

export type GatewayDeps = {
  admit(req: IncomingMessage): Admission
  registry(): Promise<RegistryRead>
  exchange?(origin: string, token: string): Promise<string | undefined>
}

type CookieJar = {
  get(origin: string, token: string): Promise<string | undefined>
  invalidate(origin: string, token: string): void
}

export type Gateway = {
  handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void>
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void
}

type SettingsFace = {
  describe(): Promise<unknown>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

export function createGateway(deps: GatewayDeps): Gateway {
  const exchange = deps.exchange ?? exchangeAuthCookie
  const jar = createJar(exchange)
  return {
    handleHttp: (req, res) => handleHttp(deps, jar, req, res),
    handleUpgrade: (req, socket, head) => { handleUpgrade(deps, jar, req, socket, head) },
  }
}

export function apply(ctx: unknown): void {
  const holder: { settings?: SettingsFace } = {}
  const gateway = createGateway({
    admit: req => admitOf(ctx, req),
    registry: async () => {
      if (holder.settings === undefined) return { ready: false }
      try {
        return { ready: true, json: registryJsonFromDescribe(await holder.settings.describe()) }
      } catch {
        return { ready: false }
      }
    },
  })
  bindSettings(ctx, face => { holder.settings = face })
  const effect = effectOf(ctx)
  const web = webServerOf(ctx)
  effect(
    () => web.register({
      kind: 'prefix',
      path: GATEWAY_PREFIX,
      handler(req, res) { void gateway.handleHttp(req, res) },
    }),
    'threadharbor-host-gateway: http',
  )
  if (typeof web.registerUpgrade !== 'function') {
    say('这台宿主没有 WebSocket 升级面，远端界面的实时流会连不上')
    return
  }
  effect(
    () => web.registerUpgrade?.({
      path: GATEWAY_WS_PATH,
      handler(req, socket, head) { gateway.handleUpgrade(req, socket, head) },
    }) ?? (() => {}),
    'threadharbor-host-gateway: ws',
  )
  say('mounted: browser calls stay on this origin and are forwarded to the registered host')
}

async function handleHttp(deps: GatewayDeps, jar: CookieJar, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const admission = deps.admit(req)
  if ('rejection' in admission) {
    text(res, admission.rejection, admission.rejection === 401 ? 'unauthorized' : 'forbidden')
    return
  }
  const method = (req.method ?? 'GET').toUpperCase()
  if (!METHODS.has(method)) {
    res.writeHead(405, {
      'content-type': 'text/plain; charset=utf-8',
      allow: [...METHODS].join(', '),
    })
    res.end('method not allowed')
    return
  }
  const route = parseGatewayRequest(req.url ?? '/')
  if (!route.ok) {
    text(res, route.status, route.message)
    return
  }
  const target = await targetOf(deps, route.hostId, headerString(req.headers.host))
  if (!target.ok) {
    text(res, target.status, target.message)
    return
  }
  let cookie: string | undefined
  try {
    cookie = await jar.get(target.origin, target.token)
  } catch (error) {
    text(res, 502, `换取远端登录 cookie 失败：${messageOf(error)}`)
    return
  }
  if (cookie === undefined) {
    text(res, 502, '远端没有换出登录 cookie，打开地址可能已失效')
    return
  }
  await forwardHttp(req, res, target.origin, route.upstreamPath, route.search, route.hostId, target.hostTitle, target.peers, cookie, () => {
    jar.invalidate(target.origin, target.token)
  })
}

function handleUpgrade(deps: GatewayDeps, jar: CookieJar, req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const admission = deps.admit(req)
  if ('rejection' in admission) {
    socket.destroy()
    return
  }
  const route = parseGatewayUpgrade(req.url ?? '/')
  if (!route.ok) {
    socket.destroy()
    return
  }
  void (async () => {
    const target = await targetOf(deps, route.hostId, headerString(req.headers.host))
    if (!target.ok) {
      socket.destroy()
      return
    }
    const cookie = await jar.get(target.origin, target.token).catch(() => undefined)
    if (cookie === undefined) {
      socket.destroy()
      return
    }
    forwardUpgrade(req, socket, head, target.origin, route.upstreamPath, route.search, cookie, () => {
      jar.invalidate(target.origin, target.token)
    })
  })().catch(() => { socket.destroy() })
}

async function targetOf(
  deps: GatewayDeps,
  hostId: string,
  pageHost: string | undefined,
): Promise<
  | { readonly ok: true; readonly origin: string; readonly token: string; readonly hostTitle: string; readonly peers: readonly GatewayPeer[] }
  | { readonly ok: false; readonly status: 400 | 404 | 503; readonly message: string }
> {
  let read: RegistryRead
  try {
    read = await deps.registry()
  } catch {
    return { ok: false, status: 503, message: '主机登记暂时读不出来' }
  }
  if (!read.ready) return { ok: false, status: 503, message: '主机登记暂时读不出来' }
  const launch = resolveLaunch(read.json, hostId)
  if (!launch.ok) return launch
  if (pointsAtPageHost(launch.origin, pageHost)) {
    return { ok: false, status: 400, message: '不能把本机页面再代理回本机' }
  }
  return { ...launch, peers: listGatewayHosts(read.json, hostId) }
}

function forwardHttp(
  req: IncomingMessage,
  res: ServerResponse,
  origin: string,
  upstreamPath: string,
  search: string,
  hostId: string,
  hostTitle: string,
  peers: readonly GatewayPeer[],
  cookie: string,
  onUnauthorized: () => void,
): Promise<void> {
  const target = upstreamUrl(origin, upstreamPath, search)
  const headers = requestHeaders(req.headers, target, cookie, false)
  const transport = target.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise(resolve => {
    const upstream = transport({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port === '' ? undefined : target.port,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers,
    }, upRes => {
      if (upRes.statusCode === 401 || upRes.statusCode === 403) onUnauthorized()
      const kind = rewriteKind(headerString(upRes.headers['content-type']))
      const rewritten = kind !== undefined && (req.method ?? 'GET').toUpperCase() !== 'HEAD'
      if (!rewritten) {
        res.writeHead(upRes.statusCode ?? 502, responseHeaders(upRes, origin, hostId, false))
        upRes.pipe(res)
        upRes.on('end', () => { resolve() })
        upRes.on('error', () => { resolve() })
        return
      }
      const chunks: Buffer[] = []
      let total = 0
      upRes.on('data', (chunk: Buffer) => {
        total += chunk.length
        chunks.push(chunk)
      })
      upRes.on('end', () => {
        const raw = Buffer.concat(chunks)
        const body = total > GATEWAY_REWRITE_LIMIT_BYTES || kind === undefined
          ? raw
          : Buffer.from(rewriteBody(kind, raw.toString('utf8'), hostId, hostTitle, peers))
        const headersOut = responseHeaders(upRes, origin, hostId, true)
        headersOut['content-length'] = Buffer.byteLength(body)
        res.writeHead(upRes.statusCode ?? 502, headersOut)
        res.end(body)
        resolve()
      })
      upRes.on('error', () => {
        if (!res.headersSent) text(res, 502, `连不上这台主机（${origin}）`)
        resolve()
      })
    })
    upstream.on('error', () => {
      if (!res.headersSent) text(res, 502, `连不上这台主机（${origin}）`)
      else res.destroy()
      resolve()
    })
    req.pipe(upstream)
    res.on('close', () => {
      if (!res.writableEnded) upstream.destroy()
    })
  })
}

function forwardUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  origin: string,
  upstreamPath: string,
  search: string,
  cookie: string,
  onUnauthorized: () => void,
): void {
  const target = upstreamUrl(origin, upstreamPath, search)
  const headers = requestHeaders(req.headers, target, cookie, true)
  headers['connection'] = 'Upgrade'
  headers['upgrade'] = headerString(req.headers.upgrade) ?? 'websocket'
  const transport = target.protocol === 'https:' ? httpsRequest : httpRequest
  const upstream = transport({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port === '' ? undefined : target.port,
    method: 'GET',
    path: `${target.pathname}${target.search}`,
    headers,
  })
  upstream.on('upgrade', (upRes, upSocket, upHead) => {
    if ((upRes.statusCode ?? 101) === 401 || (upRes.statusCode ?? 101) === 403) onUnauthorized()
    const lines = [`HTTP/1.1 ${upRes.statusCode ?? 101} ${upRes.statusMessage ?? 'Switching Protocols'}`]
    for (const [key, value] of Object.entries(upRes.headers)) {
      if (value === undefined || key.toLowerCase() === 'set-cookie') continue
      const list = Array.isArray(value) ? value : [value]
      for (const item of list) lines.push(`${key}: ${item}`)
    }
    socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (upHead.length > 0) socket.write(upHead)
    if (head.length > 0) upSocket.write(head)
    upSocket.pipe(socket)
    socket.pipe(upSocket)
    const fail = (): void => {
      upSocket.destroy()
      socket.destroy()
    }
    upSocket.on('error', fail)
    socket.on('error', fail)
  })
  upstream.on('error', () => { socket.destroy() })
  upstream.on('response', upRes => {
    if (upRes.statusCode === 401 || upRes.statusCode === 403) onUnauthorized()
    upRes.resume()
    socket.destroy()
  })
  upstream.end()
}

function upstreamUrl(origin: string, upstreamPath: string, search: string): URL {
  const target = new URL(origin)
  target.pathname = upstreamPath
  target.search = search
  return target
}

function requestHeaders(
  incoming: IncomingMessage['headers'],
  target: URL,
  cookie: string,
  keepUpgrade: boolean,
): Record<string, string | string[] | number> {
  const headers: Record<string, string | string[] | number> = {}
  for (const [key, value] of Object.entries(incoming)) {
    const lower = key.toLowerCase()
    if (value === undefined || DROP_ALWAYS.has(lower)) continue
    if (!keepUpgrade && DROP_HTTP_HOP.has(lower)) continue
    headers[key] = value
  }
  headers['host'] = target.host
  headers['origin'] = target.origin
  headers['cookie'] = cookie
  if (!keepUpgrade) headers['accept-encoding'] = 'identity'
  return headers
}

function responseHeaders(
  up: IncomingMessage,
  origin: string,
  hostId: string,
  rewritten: boolean,
): Record<string, string | string[] | number> {
  const headers: Record<string, string | string[] | number> = {}
  for (const [key, value] of Object.entries(up.headers)) {
    const lower = key.toLowerCase()
    if (value === undefined || DROP_RESPONSE.has(lower)) continue
    if (rewritten && (lower === 'content-length' || lower === 'content-encoding')) continue
    if (lower === 'location') {
      const list = Array.isArray(value) ? value : [String(value)]
      headers['location'] = list.map(item => rewriteLocation(item, origin, hostId))
      continue
    }
    headers[key] = value
  }
  return headers
}

function createJar(exchange: (origin: string, token: string) => Promise<string | undefined>): CookieJar {
  const cache = new Map<string, { cookie: string; at: number }>()
  const inflight = new Map<string, Promise<string | undefined>>()
  const keyOf = (origin: string, token: string): string => `${origin}\n${token}`
  return {
    async get(origin, token) {
      const key = keyOf(origin, token)
      const hit = cache.get(key)
      if (hit !== undefined && Date.now() - hit.at < COOKIE_TTL_MS) return hit.cookie
      let pending = inflight.get(key)
      if (pending === undefined) {
        pending = exchange(origin, token).then(cookie => {
          if (cookie !== undefined) cache.set(key, { cookie, at: Date.now() })
          return cookie
        }).finally(() => { inflight.delete(key) })
        inflight.set(key, pending)
      }
      return await pending
    },
    invalidate(origin, token) { cache.delete(keyOf(origin, token)) },
  }
}

function text(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) return
  const accept = headerString(res.req.headers.accept)
  if (accept !== undefined && accept.toLowerCase().includes('text/html')) {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(gatewayErrorPage(message, { back: '回本机', settings: '去设置' }))
    return
  }
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end(message)
}

/**
 * A standalone HTML page for browser navigations that cannot reach the host.
 *
 * Used only when the request asks for HTML (`Accept` contains `text/html`); a
 * fetch/XHR that asks for JSON or nothing keeps getting plain text. The page
 * carries its own inline styles and two exits to this machine: back home and
 * the settings entry, both at `/`. The caller's message is HTML-escaped so it
 * can never open a tag.
 */
export function gatewayErrorPage(message: string, t: { back: string; settings: string }): string {
  const body = escapeHtml(message)
  const back = escapeHtml(t.back)
  const settings = escapeHtml(t.settings)
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${body}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #151a24; color: #e6e9ef;
         font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 34em; padding: 32px; text-align: center; }
  h1 { margin: 0 0 16px; font-size: 17px; font-weight: 600; overflow-wrap: anywhere; }
  nav { display: flex; gap: 12px; justify-content: center; }
  a { color: #8ab4ff; text-decoration: none; font-weight: 600; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
<main>
  <h1>${body}</h1>
  <nav>
    <a href="/">${back}</a>
    <a href="/">${settings}</a>
  </nav>
</main>
</body>
</html>`
}

/** Escape a string for safe interpolation into HTML text content. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function headerString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function registryJsonFromDescribe(described: unknown): string | undefined {
  const answered = isRecord(described) && typeof described['ok'] === 'boolean' ? described['value'] : described
  const rows = Array.isArray(answered)
    ? answered
    : isRecord(answered) && Array.isArray(answered['namespaces'])
      ? answered['namespaces']
      : []
  const view = rows.find(row => isRecord(row) && row['ns'] === HOST_STORE_ENTRY_ID)
  if (!isRecord(view) || !isRecord(view['value'])) return undefined
  const data = view['value']['data']
  if (!isRecord(data)) return undefined
  const raw = data[HOST_REGISTRY_KEY]
  return typeof raw === 'string' ? raw : undefined
}

function admitOf(ctx: unknown, req: IncomingMessage): Admission {
  if (!isRecord(ctx) || !isRecord(ctx['connection']) || typeof ctx['connection']['admit'] !== 'function') {
    return { rejection: 403 }
  }
  const result: unknown = ctx['connection']['admit'](req)
  if (isRecord(result) && (result['rejection'] === 401 || result['rejection'] === 403)) {
    return { rejection: result['rejection'] }
  }
  return { peer: isRecord(result) ? result['peer'] : undefined }
}

function webServerOf(ctx: unknown): {
  register(route: { kind: 'prefix'; path: string; handler(req: IncomingMessage, res: ServerResponse): void }): () => void
  registerUpgrade?(route: { path: string; handler(req: IncomingMessage, socket: Duplex, head: Buffer): void }): () => void
} {
  if (!isRecord(ctx) || !isRecord(ctx['webServer']) || typeof ctx['webServer']['register'] !== 'function') {
    throw new Error('webServer.register is not available — threadharbor-host-gateway requires the host web server')
  }
  return ctx['webServer'] as ReturnType<typeof webServerOf>
}

function effectOf(ctx: unknown): (run: () => unknown, label?: string) => void {
  if (!isRecord(ctx) || typeof ctx['effect'] !== 'function') return run => { run() }
  const effect = ctx['effect'] as (run: () => unknown, label?: string) => void
  return (run, label) => { effect(run, label) }
}

function bindSettings(ctx: unknown, accept: (face: SettingsFace) => void): void {
  if (!isRecord(ctx) || typeof ctx['inject'] !== 'function') {
    say('settings service not reachable — the gateway cannot read the host registry')
    return
  }
  const inject = ctx['inject'] as (names: readonly string[], run: (child: unknown) => void) => void
  inject(['settings'], child => {
    if (!isRecord(child) || !isRecord(child['settings']) || typeof child['settings']['describe'] !== 'function') {
      say('settings service did not arrive with describe — the gateway stays closed')
      return
    }
    const describe = child['settings']['describe'] as () => Promise<unknown>
    accept({ describe: () => describe() })
  })
}

function say(message: string): void {
  process.stderr.write(`[threadharbor] host-gateway: ${message}\n`)
}
