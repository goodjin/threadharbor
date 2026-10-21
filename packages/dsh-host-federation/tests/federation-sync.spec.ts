/**
 * 主机互通条目：报到、对端推送、手机配对网址三条路由，以及「登记簿一变
 * 就推给对端」的协调器。全部走真实 HTTP 语义（请求体是流、应答状态码），
 * 只有设置服务与连接服务是假的。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../src/federation-sync.ts'
import {
  FEDERATION_ANNOUNCE_PATH,
  FEDERATION_PUSH_PATH,
  FULL_UI_PAIR_PATH,
  HOST_ACCESS_ORIGIN_KEY,
  HOST_SELF_KEY,
  parseSelfRecord,
} from '../src/federation-keys.ts'
import { HOST_REGISTRY_KEY } from '../src/registry.ts'

type Route = {
  readonly kind: string
  readonly path: string
  handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>
}

type Harness = {
  routes: Map<string, Route>
  data: Map<string, string>
  cleanups: Array<() => void>
}

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => { resolve() })
  })))
})

function createHarness(initial: Record<string, string> = {}): Harness {
  const routes = new Map<string, Route>()
  const cleanups: Array<() => void> = []
  const data = new Map(Object.entries(initial))
  let revision = 1
  const settings = {
    describe: async () => [{
      ns: 'threadharbor-host-store',
      value: { data: Object.fromEntries(data) },
      revision,
    }],
    mutate: async (_ns: string, ops: readonly unknown[]) => {
      for (const raw of ops) {
        const op = raw as { op?: string; path?: unknown; value?: unknown }
        if (op.op === 'set' && Array.isArray(op.path) && op.path[0] === 'data' && typeof op.path[1] === 'string' && typeof op.value === 'string') {
          data.set(op.path[1], op.value)
        }
      }
      revision += 1
      return {}
    },
  }
  apply({
    effect(run: () => unknown) {
      const dispose = run()
      cleanups.push(typeof dispose === 'function' ? dispose as () => void : () => {})
    },
    webServer: {
      register(route: Route) {
        routes.set(route.path, route)
        return () => { routes.delete(route.path) }
      },
    },
    connection: {
      admit: () => ({ peer: {} }),
      authenticatedUrl: (base: string) => `${base}?token=tk`,
    },
    inject(names: readonly string[], run: (child: unknown) => void) {
      if (names.includes('settings')) run({ settings })
    },
  })
  return { routes, data, cleanups }
}

type Reply = { status: number; body: string; headers: Record<string, unknown> }

async function invoke(
  harness: Harness,
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Reply> {
  const route = harness.routes.get(path)
  if (route === undefined) throw new Error(`route not registered: ${path}`)
  const payload = body === undefined ? '' : JSON.stringify(body)
  const req = Object.assign(Readable.from([Buffer.from(payload)]), {
    method,
    headers: { host: '192.168.1.5:3080', ...headers },
    socket: { encrypted: false },
  }) as unknown as IncomingMessage
  const chunks: Buffer[] = []
  const reply: Reply = { status: 0, body: '', headers: {} }
  const res = {
    writeHead(status: number, outgoing: Record<string, unknown> = {}) {
      reply.status = status
      reply.headers = outgoing
      return res
    },
    end(data?: string) {
      if (data !== undefined) chunks.push(Buffer.from(data))
    },
  } as unknown as ServerResponse
  await route.handler(req, res)
  reply.body = Buffer.concat(chunks).toString('utf8')
  return reply
}

function storedSelf(harness: Harness) {
  const raw = harness.data.get(HOST_SELF_KEY)
  return raw === undefined ? undefined : parseSelfRecord(JSON.parse(raw))
}

describe('报到与推送', () => {
  it('装载时挂上三条精确路由', () => {
    const harness = createHarness()
    try {
      expect([...harness.routes.keys()].sort()).toEqual([
        FEDERATION_ANNOUNCE_PATH,
        FEDERATION_PUSH_PATH,
        FULL_UI_PAIR_PATH,
      ].sort())
      expect([...harness.routes.values()].every(route => route.kind === 'exact')).toBe(true)
    } finally {
      for (const cleanup of harness.cleanups) cleanup()
    }
  })

  it('浏览器报到：身份取请求体，地址与令牌按请求来源由宿主铸出', async () => {
    const harness = createHarness()
    try {
      const reply = await invoke(harness, 'POST', FEDERATION_ANNOUNCE_PATH, { hostId: 'mac1', hostTitle: 'Mac 1' })
      expect(reply.status).toBe(200)
      expect(JSON.parse(reply.body)).toEqual({ ok: true, hostId: 'mac1' })
      expect(storedSelf(harness)).toMatchObject({
        hostId: 'mac1',
        hostTitle: 'Mac 1',
        address: 'http://192.168.1.5:3080',
        launchUrl: 'http://192.168.1.5:3080/?token=tk',
      })
    } finally {
      for (const cleanup of harness.cleanups) cleanup()
    }
  })

  it('配了对外访问地址就以它为准，来源不可达时也不会铸出 localhost 令牌', async () => {
    const harness = createHarness({ [HOST_ACCESS_ORIGIN_KEY]: 'https://mac1.example.ts.net' })
    try {
      const reply = await invoke(harness, 'POST', FEDERATION_ANNOUNCE_PATH, { hostId: 'mac1' }, { host: 'localhost:3080' })
      expect(reply.status).toBe(200)
      expect(storedSelf(harness)).toMatchObject({
        hostTitle: 'mac1',
        address: 'https://mac1.example.ts.net',
        launchUrl: 'https://mac1.example.ts.net/?token=tk',
      })
    } finally {
      for (const cleanup of harness.cleanups) cleanup()
    }
  })

  it('进程重启换了令牌：宿主按已记的地址重铸入口，不等浏览器报到', async () => {
    const harness = createHarness({
      [HOST_SELF_KEY]: JSON.stringify({
        hostId: 'mac1',
        hostTitle: '本机',
        address: 'https://mac1.example.ts.net',
        launchUrl: 'https://mac1.example.ts.net/?token=old-process',
        announcedAt: 1,
      }),
    })
    try {
      await waitFor(() => storedSelf(harness)?.launchUrl === 'https://mac1.example.ts.net/?token=tk')
      expect(storedSelf(harness)).toMatchObject({
        hostId: 'mac1',
        address: 'https://mac1.example.ts.net',
        launchUrl: 'https://mac1.example.ts.net/?token=tk',
      })
    } finally {
      for (const cleanup of harness.cleanups) cleanup()
    }
  })

  it('坏主机标识、坏方法、没报到的推送各自给出明确状态', async () => {
    const harness = createHarness()
    try {
      const badId = await invoke(harness, 'POST', FEDERATION_ANNOUNCE_PATH, { hostId: 'a/b' })
      expect(badId.status).toBe(400)
      expect(JSON.parse(badId.body)).toEqual({ error: 'bad-host-id' })
      const noBody = await invoke(harness, 'POST', FEDERATION_ANNOUNCE_PATH, undefined)
      expect(noBody.status).toBe(400)
      const wrongMethod = await invoke(harness, 'GET', FEDERATION_ANNOUNCE_PATH, undefined)
      expect(wrongMethod.status).toBe(405)
      const early = await invoke(harness, 'POST', FEDERATION_PUSH_PATH, {
        self: { hostId: 'mac2', hostTitle: '小机器', address: 'http://10.0.0.8:3081', launchUrl: 'http://10.0.0.8:3081/?token=t', announcedAt: 1 },
        hosts: [],
      })
      expect(early.status).toBe(409)
      expect(JSON.parse(early.body)).toEqual({ error: 'self-not-announced' })
    } finally {
      for (const cleanup of harness.cleanups) cleanup()
    }
  })

  it('对端推送把登记簿合并进本机，发送方的自述与介绍都收下', async () => {
    const harness = createHarness()
    try {
      await invoke(harness, 'POST', FEDERATION_ANNOUNCE_PATH, { hostId: 'mac1', hostTitle: '本机' })
      const reply = await invoke(harness, 'POST', FEDERATION_PUSH_PATH, {
        self: { hostId: 'mac2', hostTitle: '小机器', address: 'http://10.0.0.8:3081', launchUrl: 'http://10.0.0.8:3081/?token=t2', announcedAt: 1 },
        hosts: [
          { hostId: 'mac3', hostTitle: '第三台', address: 'http://10.0.0.9:3080', launchUrl: 'http://10.0.0.9:3080/?token=t3', createdAt: 1 },
        ],
      })
      expect(reply.status).toBe(200)
      expect(JSON.parse(reply.body)).toEqual({ ok: true, changed: true, added: 2 })
      const registry = JSON.parse(harness.data.get(HOST_REGISTRY_KEY) ?? '[]') as Array<Record<string, unknown>>
      expect(registry.map(entry => entry['hostId']).sort()).toEqual(['mac2', 'mac3'])
    } finally {
      for (const cleanup of harness.cleanups) cleanup()
    }
  })
})

describe('手机配对网址', () => {
  it('按请求来源铸完整界面的带令牌网址，本机来源标出 loopback', async () => {
    const harness = createHarness()
    try {
      const reply = await invoke(harness, 'GET', FULL_UI_PAIR_PATH, undefined, { host: '127.0.0.1:3080' })
      expect(reply.status).toBe(200)
      expect(JSON.parse(reply.body)).toEqual({
        url: 'http://127.0.0.1:3080/?token=tk',
        origin: 'http://127.0.0.1:3080',
        loopback: true,
      })
      expect(reply.headers['cache-control']).toBe('no-store')
    } finally {
      for (const cleanup of harness.cleanups) cleanup()
    }
  })

  it('配了对外访问地址时配对网址用那个源，loopback 为假', async () => {
    const harness = createHarness({ [HOST_ACCESS_ORIGIN_KEY]: 'https://mac1.example.ts.net' })
    try {
      const reply = await invoke(harness, 'GET', FULL_UI_PAIR_PATH, undefined, { host: 'localhost:3080' })
      expect(JSON.parse(reply.body)).toEqual({
        url: 'https://mac1.example.ts.net/?token=tk',
        origin: 'https://mac1.example.ts.net',
        loopback: false,
      })
    } finally {
      for (const cleanup of harness.cleanups) cleanup()
    }
  })
})

describe('向对端推送', () => {
  it('向登记簿里的主机换 cookie、推送自己与公开条目，SSH 与读数不出门', async () => {
    const received: Array<Record<string, unknown>> = []
    let pushedCookie: string | undefined
    const peer = createServer((req, res) => {
      if ((req.url ?? '').startsWith('/?token=peer-token')) {
        res.writeHead(303, { 'set-cookie': 'dsh-auth=peer-cookie; Path=/; HttpOnly', location: '/' })
        res.end()
        return
      }
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      req.on('end', () => {
        if (req.url === FEDERATION_PUSH_PATH) {
          pushedCookie = req.headers.cookie
          received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{"ok":true}')
          return
        }
        res.writeHead(404)
        res.end()
      })
    })
    const peerOrigin = `http://127.0.0.1:${await listen(peer)}`
    const harness = createHarness({
      [HOST_SELF_KEY]: JSON.stringify({
        hostId: 'mac1',
        hostTitle: '本机',
        address: 'http://127.0.0.1:1',
        launchUrl: 'http://127.0.0.1:1/?token=self',
        announcedAt: 1,
      }),
      [HOST_REGISTRY_KEY]: JSON.stringify([{
        hostId: 'mac2',
        hostTitle: '小机器',
        address: peerOrigin,
        launchUrl: `${peerOrigin}/?token=peer-token`,
        createdAt: 1,
        ssh: { target: '10.0.0.8', authMode: 'identityFile', identityFile: '/secret/key' },
        remote: { hostId: 'mac2', online: true, onlineIds: ['mac2'], self: false, at: 1 },
      }]),
    })
    try {
      await waitFor(() => received.length > 0)
      expect(pushedCookie).toBe('dsh-auth=peer-cookie')
      const push = received[0] as { self: Record<string, unknown>; hosts: Array<Record<string, unknown>> }
      expect(push.self).toMatchObject({ hostId: 'mac1', hostTitle: '本机' })
      expect(push.hosts).toHaveLength(1)
      expect(push.hosts[0]).toMatchObject({
        hostId: 'mac2',
        hostTitle: '小机器',
        address: peerOrigin,
        launchUrl: `${peerOrigin}/?token=peer-token`,
      })
      expect(push.hosts[0]).not.toHaveProperty('ssh')
      expect(push.hosts[0]).not.toHaveProperty('remote')
    } finally {
      for (const cleanup of harness.cleanups) cleanup()
    }
  })
})

async function listen(server: Server): Promise<number> {
  servers.push(server)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port)
    })
  })
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for push')
    await new Promise(resolve => { setTimeout(resolve, 20) })
  }
}
