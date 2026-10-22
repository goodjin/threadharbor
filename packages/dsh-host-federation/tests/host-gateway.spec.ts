/**
 * 本机网关：浏览器只访问本机路径，请求被转到登记簿里的那台主机。
 * 登录 cookie 留在网关，浏览器自己的 cookie 不往前送。
 */

import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, createGateway, gatewayErrorPage, type Gateway } from '../src/host-gateway.ts'
import {
  gatewayClientScript,
  listGatewayHosts,
  parseGatewayRequest,
  parseGatewayUpgrade,
  resolveLaunch,
  rewriteHtml,
  rewriteJs,
} from '../src/host-gateway-path.ts'

type Seen = {
  method?: string | undefined
  url?: string | undefined
  cookie?: string | undefined
  origin?: string | undefined
  host?: string | undefined
  body?: string | undefined
}

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => { resolve() })
  })))
})

describe('网关路径', () => {
  it('拆出主机标识和要转到对面的路径', () => {
    expect(parseGatewayRequest('/threadharbor/gateway/mini/api/session/page?x=1')).toEqual({
      ok: true,
      hostId: 'mini',
      upstreamPath: '/api/session/page',
      search: '?x=1',
    })
    expect(parseGatewayRequest('/threadharbor/gateway/mini/../../etc/passwd').ok).toBe(false)
    expect(parseGatewayUpgrade('/threadharbor/gateway-ws?host=mini&path=%2Fapi%2Fremote.mux')).toMatchObject({
      ok: true,
      hostId: 'mini',
      upstreamPath: '/api/remote.mux',
    })
  })

  it('只认登记簿里的打开地址，令牌对不上地址就拒绝', () => {
    const json = JSON.stringify([
      { hostId: 'mini', address: 'http://10.0.0.8:3081', launchUrl: 'http://10.0.0.9:3081/?token=tk' },
    ])
    expect(resolveLaunch(json, 'mini').ok).toBe(false)
    expect(resolveLaunch(json, 'other').ok).toBe(false)
    expect(resolveLaunch(JSON.stringify([
      { hostId: 'mini', address: 'http://10.0.0.8:3081', launchUrl: 'http://10.0.0.8:3081/?token=tk' },
    ]), 'mini')).toMatchObject({ ok: true, origin: 'http://10.0.0.8:3081', token: 'tk' })
  })

  it('页面被改写到网关前缀，注入脚本能解析', () => {
    const html = rewriteHtml('<html><head><script src="/assets/app.js"></script></head><body>REMOTE</body></html>', 'mini', '迷你')
    expect(html.indexOf('<base href="/threadharbor/gateway/mini/">')).toBeLessThan(html.indexOf('src="/threadharbor/gateway/mini/assets/app.js"'))
    expect(html).toContain('REMOTE')
    expect(html).not.toContain('src="/assets/app.js"')
    const withManifest = rewriteHtml(
      '<html><head><link rel="manifest" href="./manifest.webmanifest" /></head><body>REMOTE</body></html>',
      'mini',
      '迷你',
    )
    expect(withManifest).not.toContain('manifest.webmanifest')
    expect(() => { new Function(gatewayClientScript('mini', '迷你')) }).not.toThrow()
    expect(gatewayClientScript('mini', '迷你')).toContain('/threadharbor/gateway-ws')
    expect(gatewayClientScript('mini', '迷你')).toContain('thSession=')
    expect(gatewayClientScript('mini', '迷你')).toContain('openSession')
    expect(gatewayClientScript('mini', '迷你')).not.toContain('</script')
    const rewritten = rewriteJs('ctx.get("uiWorkspace");ctx.uiWorkspace.openSession(id);import("/assets/app.js")', 'mini')
    expect(rewritten).toContain('(window.__thUiWorkspace=ctx.get("uiWorkspace"))')
    expect(rewritten).toContain('(window.__thUiWorkspace=ctx.uiWorkspace).openSession(id)')
    expect(rewritten).toContain('/threadharbor/gateway/mini/assets/app.js')
  })

  it('注入脚本带上当前主机名与回本机入口', () => {
    const html = rewriteHtml('<html><head></head><body>REMOTE</body></html>', 'mini', '小机器')
    expect(html).toContain('小机器')
    expect(gatewayClientScript('mini', '小机器')).toContain('th-host-bar')
    expect(gatewayClientScript('mini', '小机器')).toContain('th-back-home')
    expect(() => { new Function(gatewayClientScript('mini', '小机器')) }).not.toThrow()
  })

  it('切换器只列出有打开地址的其余主机，排除正在看的那台并去重', () => {
    const json = JSON.stringify([
      { hostId: 'mini', hostTitle: '迷你', address: 'http://10.0.0.8:3081', launchUrl: 'http://10.0.0.8:3081/?token=a' },
      { hostId: 'far', hostTitle: '远端', address: 'http://10.0.0.9:3080', launchUrl: 'http://10.0.0.9:3080/?token=b' },
      { hostId: 'far', hostTitle: '重复的远端', address: 'http://10.0.0.9:3080', launchUrl: 'http://10.0.0.9:3080/?token=c' },
      { hostId: 'no-token', hostTitle: '没令牌', address: 'http://10.0.0.10:3080' },
      { hostId: '', hostTitle: '空标识', address: 'http://10.0.0.11:3080', launchUrl: 'http://10.0.0.11:3080/?token=d' },
    ])
    expect(listGatewayHosts(json, 'mini')).toEqual([{ hostId: 'far', hostTitle: '远端' }])
    expect(listGatewayHosts(json, 'far')).toEqual([{ hostId: 'mini', hostTitle: '迷你' }])
    expect(listGatewayHosts('not json', 'mini')).toEqual([])
    expect(listGatewayHosts(undefined, 'mini')).toEqual([])
  })
})

describe('错误页', () => {
  it('页面导航的失败回错误页，程序请求仍是纯文本', async () => {
    const gateway = createGateway({
      admit: () => ({ peer: {} }),
      registry: async () => ({ ready: true, json: '[]' }),
    })
    const local = await startGateway(gateway)
    const page = await rawRequest(local.port, '/threadharbor/gateway/missing/', { accept: 'text/html' })
    expect(page.status).toBe(404)
    expect(page.headers['content-type']).toContain('text/html')
    expect(page.body).toContain('没有这台已登记的主机')
    expect(page.body).toContain('回本机')
    expect(page.body).toContain('去设置')
    expect(page.body).toContain('href="/"')
    const plain = await rawRequest(local.port, '/threadharbor/gateway/missing/')
    expect(plain.status).toBe(404)
    expect(plain.headers['content-type']).toContain('text/plain')
    expect(plain.body).toBe('没有这台已登记的主机')
  })

  it('fetch 的默认接受头 */* 拿到纯文本，不会拿到一整页 HTML', async () => {
    const gateway = createGateway({
      admit: () => ({ peer: {} }),
      registry: async () => ({ ready: true, json: '[]' }),
    })
    const local = await startGateway(gateway)
    const fetched = await rawRequest(local.port, '/threadharbor/gateway/missing/', { accept: '*/*' })
    expect(fetched.status).toBe(404)
    expect(fetched.headers['content-type']).toContain('text/plain')
    expect(fetched.body).toBe('没有这台已登记的主机')
  })

  it('错误页正文按 HTML 转义，不把消息当标签', () => {
    const html = gatewayErrorPage('连不上这台主机（<b>http://x</b>）& 重试', { back: '回本机', settings: '去设置' })
    expect(html).toContain('连不上这台主机（&lt;b&gt;http://x&lt;/b&gt;）&amp; 重试')
    expect(html).not.toContain('<b>http://x</b>')
    expect(html).toContain('href="/"')
  })

  it('页面标题是出错的理由，不是按钮上的文案', () => {
    const html = gatewayErrorPage('没有这台已登记的主机', { back: '回本机', settings: '去设置' })
    expect(html).toContain('<title>没有这台已登记的主机</title>')
  })
})

describe('转发', () => {
  it('页面和接口转到登记的主机，cookie 留在网关', async () => {
    const seen: Seen[] = []
    const upstream = await startUpstream(seen)
    const gateway = createGateway({
      admit: () => ({ peer: {} }),
      registry: async () => ({ ready: true, json: registryJson(upstream.port) }),
    })
    const local = await startGateway(gateway)
    const page = await rawRequest(local.port, '/threadharbor/gateway/mini/', {
      cookie: 'local=secret',
      origin: 'http://evil.example',
    })
    expect(page.status).toBe(200)
    expect(page.headers['set-cookie']).toBeUndefined()
    expect(page.headers['content-security-policy']).toBeUndefined()
    expect(page.headers['x-frame-options']).toBeUndefined()
    expect(page.body).toContain('REMOTE_UI')
    expect(page.body).toContain('<base href="/threadharbor/gateway/mini/">')
    expect(page.body).not.toContain('token=tk')
    const posted = await rawRequest(local.port, '/threadharbor/gateway/mini/api/session/page', {
      cookie: 'local=secret',
      origin: 'http://127.0.0.1:9',
      'content-type': 'application/json',
    }, 'POST', '{"n":1}')
    expect(posted.status).toBe(200)
    expect(posted.body).toBe('{"ok":true}')
    const api = seen.find(row => row.url === '/api/session/page')
    expect(api).toMatchObject({
      method: 'POST',
      cookie: 'dsh-auth=abc',
      origin: `http://127.0.0.1:${upstream.port}`,
      host: `127.0.0.1:${upstream.port}`,
      body: '{"n":1}',
    })
    expect(api?.cookie).not.toContain('local=secret')
    const socket = await openUpgrade(local.port, '/threadharbor/gateway-ws?host=mini&path=%2Fapi%2Fremote.mux', {
      cookie: 'local=secret',
      origin: 'http://evil.example',
    })
    expect(socket).toContain('hello-mux')
    const mux = seen.find(row => row.url === '/api/remote.mux')
    expect(mux?.cookie).toBe('dsh-auth=abc')
    expect(mux?.origin).toBe(`http://127.0.0.1:${upstream.port}`)
  })

  it('没登记的主机和指回本机的地址都不转发', async () => {
    const seen: Seen[] = []
    const upstream = await startUpstream(seen)
    const localPort = { current: 0 }
    const gateway = createGateway({
      admit: () => ({ peer: {} }),
      registry: async () => ({
        ready: true,
        json: JSON.stringify([{
          hostId: 'self',
          address: `http://127.0.0.1:${localPort.current}`,
          launchUrl: `http://127.0.0.1:${localPort.current}/?token=tk`,
          hostTitle: '本机',
          createdAt: 1,
        }]),
      }),
    })
    const local = await startGateway(gateway)
    localPort.current = local.port
    const missing = await rawRequest(local.port, '/threadharbor/gateway/mini/')
    expect(missing.status).toBe(404)
    const loop = await rawRequest(local.port, '/threadharbor/gateway/self/')
    expect(loop.status).toBe(400)
    expect(loop.body).toContain('不能把本机页面再代理回本机')
    expect(seen).toEqual([])
    expect(upstream.port).toBeGreaterThan(0)
  })

  it('没登录的浏览器进不了网关', async () => {
    const gateway = createGateway({
      admit: () => ({ rejection: 401 }),
      registry: async () => ({ ready: true, json: '[]' }),
    })
    const local = await startGateway(gateway)
    const denied = await rawRequest(local.port, '/threadharbor/gateway/mini/')
    expect(denied.status).toBe(401)
  })

  it('装载时挂上前缀路由和升级路由，登记从设置文档里读', async () => {
    const seen: Seen[] = []
    const upstream = await startUpstream(seen)
    const routes: Array<{ kind?: string; path: string; handler: (...args: never[]) => void }> = []
    apply({
      effect: (run: () => unknown) => { run() },
      webServer: {
        register(route: { kind: string; path: string; handler: (...args: never[]) => void }) {
          routes.push(route)
          return () => {}
        },
        registerUpgrade(route: { path: string; handler: (...args: never[]) => void }) {
          routes.push(route)
          return () => {}
        },
      },
      connection: { admit: () => ({ peer: {} }) },
      inject(_names: readonly string[], run: (child: unknown) => void) {
        // 真的设置服务是对象方法，靠 this 读自己的状态；摘下来单独调用会炸，
        // 网关每次取登记簿都会 503。这里照这个形状假一份。
        const settings = {
          registry: registryJson(upstream.port),
          async describe() {
            return [{
              ns: 'threadharbor-host-store',
              value: { data: { 'dsh.host.registry': this.registry } },
            }]
          },
        }
        run({ settings })
      },
    })
    expect(routes.map(route => route.path)).toEqual(['/threadharbor/gateway', '/threadharbor/gateway-ws'])
    const httpRoute = routes[0]
    if (httpRoute === undefined) throw new Error('missing route')
    const local = await listen(createServer((req, res) => { httpRoute.handler(req as never, res as never) }))
    const page = await rawRequest(local, '/threadharbor/gateway/mini/')
    expect(page.status).toBe(200)
    expect(page.body).toContain('REMOTE_UI')
  })
})

function registryJson(port: number): string {
  return JSON.stringify([{
    hostId: 'mini',
    address: `http://127.0.0.1:${port}`,
    launchUrl: `http://127.0.0.1:${port}/?token=tk`,
    hostTitle: '迷你',
    createdAt: 1,
  }])
}

async function startUpstream(seen: Seen[]): Promise<{ port: number }> {
  const server = createServer((req, res) => {
    void collect(req, seen).then(row => {
      if ((req.url ?? '').startsWith('/?token=')) {
        res.writeHead(303, { 'set-cookie': 'dsh-auth=abc; Path=/; HttpOnly', location: '/' })
        res.end()
        return
      }
      if (req.url === '/api/session/page') {
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'leaked=1' })
        res.end('{"ok":true}')
        return
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': 'leaked=1',
        'content-security-policy': "default-src 'none'",
        'x-frame-options': 'DENY',
      })
      res.end(`<html><head><script src="/assets/app.js"></script></head><body>REMOTE_UI ${row.cookie ?? ''}</body></html>`)
    })
  })
  server.on('upgrade', (req, socket) => {
    seen.push({
      method: req.method,
      url: req.url,
      cookie: header(req, 'cookie'),
      origin: header(req, 'origin'),
      host: header(req, 'host'),
    })
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nhello-mux')
    socket.end()
  })
  return { port: await listen(server) }
}

async function startGateway(gateway: Gateway): Promise<{ port: number }> {
  const server = createServer((req, res) => { void gateway.handleHttp(req, res) })
  server.on('upgrade', (req, socket, head) => { gateway.handleUpgrade(req, socket, head) })
  return { port: await listen(server) }
}

function listen(server: Server): Promise<number> {
  servers.push(server)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo
      resolve(address.port)
    })
  })
}

function rawRequest(
  port: number,
  path: string,
  headers: Record<string, string> = {},
  method = 'GET',
  body?: string,
): Promise<{ status: number; headers: IncomingMessage['headers']; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers }, res => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

function openUpgrade(port: number, path: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      headers: {
        ...headers,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': Buffer.from('0123456789abcdef').toString('base64'),
      },
    })
    req.on('upgrade', (_res, socket, head) => {
      const chunks: Buffer[] = [head]
      socket.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      socket.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
      socket.on('error', reject)
    })
    req.on('error', reject)
    req.on('response', res => {
      res.resume()
      reject(new Error(`upgrade failed: ${res.statusCode ?? 0}`))
    })
    req.end()
  })
}

function collect(req: IncomingMessage, seen: Seen[]): Promise<Seen> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    req.on('end', () => {
      const row: Seen = {
        method: req.method,
        url: req.url,
        cookie: header(req, 'cookie'),
        origin: header(req, 'origin'),
        host: header(req, 'host'),
        body: Buffer.concat(chunks).toString('utf8'),
      }
      seen.push(row)
      resolve(row)
    })
  })
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}
