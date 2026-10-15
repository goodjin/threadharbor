/**
 * 转发接口与跨机事件汇流的用例。
 *
 * 这一组盯的核心是**归属**：两台机器同时有待批请求时，手机对 A 的应答必须
 * 只落到 A，发错机器要么静默失败、要么批错事——后者比崩掉更糟。
 */

import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Relay, RELAY_SESSIONS_PATH, RELAY_EVENTS_PATH, RELAY_ANSWER_PATH } from '../src/relay.ts'
import type { ClientPool } from '../src/relay.ts'
import type { EventOutcome, MachineClient } from '../src/machine-client.ts'

const HOST_A = 'mac-a'
const HOST_B = 'linux-b'

/** 假上游客户端：记录被调了什么、能让它发事件。 */
function fakeClient() {
  const calls: { endpoint: string; args: unknown }[] = []
  const answers: { eventId: string; outcome: EventOutcome }[] = []
  // 假件与真客户端同形：`'*'` 通配订阅收全部事件（真实实现在 machine-client.dispatch）。
  const handlers = new Map<string, (value: unknown) => void>()
  /** 假件要能换结果：上游 401 / 上游报错这两种形态分别靠它造。 */
  const state: { result: unknown } = { result: { ok: true as const, value: { ok: true } } }
  const client = {
    calls,
    answers,
    state,
    async call(endpoint: string, args: unknown) {
      calls.push({ endpoint, args })
      return state.result as { ok: true; value: unknown }
    },
    async answer(eventId: string, outcome: EventOutcome) {
      answers.push({ eventId, outcome })
      return { ok: true }
    },
    onEvent(type: string, listener: (value: unknown) => void) {
      if (type === '*') client.lastEventType = '*'
      handlers.set(type, listener)
      return () => handlers.delete(type)
    },
    lastEventType: '',
    connect() {},
    close() {},
  }
  return {
    client: client as unknown as MachineClient,
    calls,
    answers,
    state,
    emit(type: string, value: unknown) {
      handlers.get(type)?.(value)
      handlers.get('*')?.(value)
    },
  }
}

/** 响应记录器：把 handler 对响应的完整处置收下来。 */
function recorder() {
  const state = { status: 0, headers: {} as Record<string, string | number | string[] | undefined>, body: '' }
  const res = {
    writeHead(status: number, headers?: Record<string, string | number | string[]>) {
      state.status = status
      Object.assign(state.headers, headers ?? {})
    },
    end(chunk?: string) {
      state.body = chunk ?? ''
    },
  }
  return { state, res: res as unknown as ServerResponse }
}

function relayWith(clients: Record<string, ReturnType<typeof fakeClient>>) {
  const closed: string[] = []
  const pool: ClientPool = {
    async clientFor(hostId: string) {
      return clients[hostId]?.client as MachineClient
    },
    invalidate(hostId: string) {
      clients[hostId]?.calls.length
      void hostId
    },
    closeAll() {
      for (const hostId of Object.keys(clients)) closed.push(hostId)
    },
  }
  const relay = new Relay({
    knownHostIds: new Set([HOST_A, HOST_B]),
    clients: pool,
    onCredentialStale: () => {},
  })
  return { relay, closed }
}

/**
 * 请求假件：带 url/method/headers，并给一个能收 body 的最小流。
 * POST 用例要真的把体读出来，所以 `on('data'|'end')` 要在注册后立刻喂数据——
 * 真实流也是这么走的（先注册监听，数据随后到达）。
 */
const req = (path: string, method = 'GET', body?: unknown): IncomingMessage => {
  const payload = body === undefined ? '' : JSON.stringify(body)
  return {
    method,
    url: path,
    headers: { host: 'dsh.agentlab.fun' },
    on(event: string, handler: (chunk?: unknown) => void) {
      if (event === 'data' && payload !== '') handler(Buffer.from(payload))
      if (event === 'end' || event === 'error') handler()
      return this
    },
  } as unknown as IncomingMessage
}

function urlOf(path: string): URL {
  return new URL(path, 'http://relay.invalid')
}

describe('会话转发（按机器归属）', () => {
  it('两台机器各挂一个待批事件 → 手机收到两条且都带 hostId', async () => {
    const a = fakeClient()
    const b = fakeClient()
    const { relay } = relayWith({ [HOST_A]: a, [HOST_B]: b })
    const frames: { type: string; hostId: string; value: { id: string } }[] = []
    const socket = {
      send(data: string) {
        frames.push(JSON.parse(data))
      },
      close() {},
      on() {},
    }
    relay.registerPhone(socket as never)

    await relay.attachClients()
    a.emit('approval/request', { id: 'e1' })
    b.emit('approval/request', { id: 'e2' })

    // 信封与手机页同形：type 恒为 'item'，事件类型与载荷都在 value 里原样透传，
    // 手机据此知道「这是哪台机器的什么事」。
    expect(frames).toEqual([
      { type: 'item', hostId: HOST_A, value: { id: 'e1' } },
      { type: 'item', hostId: HOST_B, value: { id: 'e2' } },
    ])
  })

  it('对 A 的审批应答只落到 A，B 不被调用（评审重点 1）', async () => {
    const a = fakeClient()
    const b = fakeClient()
    const { relay } = relayWith({ [HOST_A]: a, [HOST_B]: b })
    await relay.attachClients()
    const { state, res } = recorder()

    await relay.handleAnswer(req(RELAY_ANSWER_PATH, 'POST', { hostId: HOST_A, eventId: 'e1', outcome: { kind: 'next' } }), res)

    expect(state.status).toBe(200)
    expect(a.answers).toEqual([{ eventId: 'e1', outcome: { kind: 'next' } }])
    expect(b.answers).toEqual([])
  })

  it('手机断开只摘它自己，上游不受影响', async () => {
    const a = fakeClient()
    const b = fakeClient()
    const { relay } = relayWith({ [HOST_A]: a, [HOST_B]: b })
    await relay.attachClients()
    const frames: unknown[] = []
    const first = { send: (data: string) => frames.push(JSON.parse(data)), close() {}, on() {} }
    const second = { send: (data: string) => frames.push(JSON.parse(data)), close() {}, on() {} }
    relay.registerPhone(first as never)
    relay.registerPhone(second as never)

    relay.dropPhone(first as never)
    a.emit('approval/request', { id: 'e1' })

    expect(frames).toHaveLength(1) // 只剩第二台手机
  })
})

describe('路径形状与白名单', () => {
  it('hostId 不在配置内 → 404，且不发起上游调用', async () => {
    const a = fakeClient()
    const { relay } = relayWith({ [HOST_A]: a })
    const { state, res } = recorder()

    await relay.handleSessions(req(`${RELAY_SESSIONS_PATH}unknown-host/sessions`), res, urlOf(`${RELAY_SESSIONS_PATH}unknown-host/sessions`))

    expect(state.status).toBe(404)
    expect(JSON.parse(state.body)).toEqual({ error: 'not-found' })
    expect(a.calls).toEqual([])
  })

  it('sid 含路径穿越 → 404，不发起上游调用', async () => {
    const a = fakeClient()
    const { relay } = relayWith({ [HOST_A]: a })
    const bad = `${RELAY_SESSIONS_PATH}${HOST_A}/sessions/..%2F..%2Fetc/messages`
    const { state, res } = recorder()

    await relay.handleMessages(req(bad), res, urlOf(bad))

    expect(state.status).toBe(404)
    expect(a.calls).toEqual([])
  })

  it('段数不符 → 404', async () => {
    const a = fakeClient()
    const { relay } = relayWith({ [HOST_A]: a })
    const bad = `${RELAY_SESSIONS_PATH}${HOST_A}`
    const { state, res } = recorder()

    await relay.handleSessions(req(bad), res, urlOf(bad))

    expect(state.status).toBe(404)
    expect(a.calls).toEqual([])
  })
})

describe('上游失败的对手机表达', () => {
  it('上游 401 → credential-stale，并触发该机凭据重换', async () => {
    const a = fakeClient()
    a.state.result = { ok: false, kind: 'unauthorized', message: '上游说没 cookie' }
    const stale: string[] = []
    const { relay } = relayWith({ [HOST_A]: a })
    relay.onStale = (hostId: string) => stale.push(hostId)
    const { state, res } = recorder()

    await relay.handleSessions(req(`${RELAY_SESSIONS_PATH}${HOST_A}/sessions`), res, urlOf(`${RELAY_SESSIONS_PATH}${HOST_A}/sessions`))

    expect(state.status).toBe(200)
    expect(JSON.parse(state.body)).toEqual({ error: 'credential-stale' })
    expect(stale).toEqual([HOST_A])
  })

  it('上游 rpc-error → 有界中文提示，不把上游原文转发给手机', async () => {
    const a = fakeClient()
    // 上游原文可能含内部细节（路径、栈、机器上的用户名），不该原样出公网。
    a.state.result = { ok: false, kind: 'rpc-error', message: 'Error: EACCES /root/.ssh/id_rsa at /home/hello/…' }
    const { relay } = relayWith({ [HOST_A]: a })
    const { state, res } = recorder()

    await relay.handleSessions(req(`${RELAY_SESSIONS_PATH}${HOST_A}/sessions`), res, urlOf(`${RELAY_SESSIONS_PATH}${HOST_A}/sessions`))

    const body = JSON.parse(state.body)
    expect(body.error).toBe('machine-error')
    expect(JSON.stringify(body)).not.toContain('/root/.ssh/id_rsa')
  })
})

describe('常量', () => {
  it('三条路径都在 relay 前缀下', () => {
    expect(RELAY_SESSIONS_PATH).toBe('/threadharbor/relay/hosts/')
    expect(RELAY_EVENTS_PATH).toBe('/threadharbor/relay/events')
    expect(RELAY_ANSWER_PATH).toBe('/threadharbor/relay/answer')
  })
})
