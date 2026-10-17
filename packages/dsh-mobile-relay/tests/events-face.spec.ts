/**
 * 事件面的**真握手**用例。
 *
 * 这一面以前没有任何用例，于是它从来没工作过：处理器把裸 TCP 当 WebSocket 用，
 * 既没写 101 也没做帧编解码。真机验收时用 curl 发 Upgrade 请求，**一个应答头都收
 * 不到**，手机侧会一直停在「连接中」。这里用一个真的 http 服务 + 真的 ws 客户端
 * 把握手走完：没有握手，客户端连不上，ready 帧也就收不到。
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, type MobileRelayConfig } from '../src/index.ts'

const PEER = { role: 'operator' }

function relayConfig(): MobileRelayConfig {
  return {
    mobileOrigin: 'https://relay.example.com',
    sshKnownHostsPath: join(mkdtempSync(join(tmpdir(), 'relay-ws-')), 'known_hosts'),
    statePath: join(mkdtempSync(join(tmpdir(), 'relay-ws-state-')), 'state.json'),
    machines: [{ hostId: 'laptop', target: '100.64.0.2', remotePort: 3081, logPath: '/var/log/dsh.log' }],
  }
}

/**
 * 跑一遍 apply，捕获事件面登记的升级处理器，然后挂到一个真 http 服务上。
 * 返回端口与服务器。
 */
function serveUpgrade(config: MobileRelayConfig, admit: () => unknown) {
  let handler: ((req: IncomingMessage, socket: Duplex, head: Buffer) => void) | undefined
  const ctx = {
    effect(factory: () => unknown) {
      factory()
    },
    webServer: {
      register() {
        return () => {}
      },
      registerUpgrade(route: { path: string; handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void }) {
        handler = route.handler
        return () => {}
      },
    },
    connection: { admit: () => admit() },
  } as never
  apply(ctx, config)

  if (handler === undefined) throw new Error('没有登记事件面')
  const upgrade = handler
  const server: Server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(404).end()
  })
  server.on('upgrade', (req, socket, head) => {
    // 插件的门要看到 Host：公网入口的 origin 绑定就靠这一个头。
    req.headers.host = 'relay.example.com'
    upgrade(req, socket, head)
  })
  const address = server.listen(0).address() as { port: number }
  return { server, port: address.port }
}

const opened: Server[] = []
afterEach(() => {
  for (const server of opened.splice(0)) server.close()
})

describe('事件面（/threadharbor/relay/events）', () => {
  it('真的升级握手成功，手机第一帧就收到 ready', async () => {
    const { server, port } = serveUpgrade(relayConfig(), () => ({ peer: PEER }))
    opened.push(server)

    const client = new WebSocket(`ws://127.0.0.1:${port}/threadharbor/relay/events`, { headers: { host: 'relay.example.com' } })
    const first = await new Promise<string>((resolve, reject) => {
      client.once('message', data => resolve(String(data)))
      client.once('error', reject)
      client.once('unexpected-response', (_req, res) => reject(new Error(`非 101 应答：${res.statusCode}`)))
      client.once('close', () => reject(new Error('还没收到 ready 就断了')))
    })
    client.close()

    expect(first).toBe('{"type":"ready"}')
  })

  it('准入没过就不握手（连接直接断，不给 101）', async () => {
    const { server, port } = serveUpgrade(relayConfig(), () => ({ rejection: 403 as const }))
    opened.push(server)

    const outcome = await new Promise<string>(resolve => {
      const client = new WebSocket(`ws://127.0.0.1:${port}/threadharbor/relay/events`, { headers: { host: 'relay.example.com' } })
      client.once('open', () => { client.close(); resolve('升级成功') })
      client.once('error', () => resolve('连接被拒'))
      client.once('close', () => resolve('连接被拒'))
    })

    expect(outcome).toBe('连接被拒')
  })
})
