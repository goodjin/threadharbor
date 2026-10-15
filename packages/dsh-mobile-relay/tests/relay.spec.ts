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
  /** connect 被调次数：C1 的判别面。 */
  const counters = { connects: 0 }
  /** 可换的应答结果：上游报错时 answer 带回原文，用它造。 */
  const answerState: { outcome: { ok: boolean; message?: string } } = { outcome: { ok: true } }
  const client = {
    calls,
    answers,
    state,
    get connects() { return counters.connects },
    get answerOutcome() { return answerState.outcome },
    set answerOutcome(value: { ok: boolean; message?: string }) { answerState.outcome = value },
    async call(endpoint: string, args: unknown) {
      calls.push({ endpoint, args })
      return state.result as { ok: true; value: unknown }
    },
    async answer(eventId: string, outcome: EventOutcome) {
      answers.push({ eventId, outcome })
      return answerState.outcome
    },
    onEvent(type: string, listener: (value: unknown) => void) {
      if (type === '*') client.lastEventType = '*'
      handlers.set(type, listener)
      return () => handlers.delete(type)
    },
    lastEventType: '',
    connect() { counters.connects += 1 },
    close() {},
  }
  return {
    client: client as unknown as MachineClient,
    calls,
    answers,
    state,
    get connects() { return counters.connects },
    get answerOutcome() { return answerState.outcome },
    set answerOutcome(value: { ok: boolean; message?: string }) { answerState.outcome = value },
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

    await relay.handleSessions(req(`${RELAY_SESSIONS_PATH}/unknown-host/sessions`), res, urlOf(`${RELAY_SESSIONS_PATH}/unknown-host/sessions`))

    expect(state.status).toBe(404)
    expect(JSON.parse(state.body)).toEqual({ error: 'not-found' })
    expect(a.calls).toEqual([])
  })

  it('sid 含路径穿越 → 404，不发起上游调用', async () => {
    const a = fakeClient()
    const { relay } = relayWith({ [HOST_A]: a })
    const bad = `${RELAY_SESSIONS_PATH}/${HOST_A}/sessions/..%2F..%2Fetc/messages`
    const { state, res } = recorder()

    await relay.handleMessages(req(bad), res, urlOf(bad))

    expect(state.status).toBe(404)
    expect(a.calls).toEqual([])
  })

  it('段数不符 → 404', async () => {
    const a = fakeClient()
    const { relay } = relayWith({ [HOST_A]: a })
    const bad = `${RELAY_SESSIONS_PATH}/${HOST_A}`
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

    await relay.handleSessions(req(`${RELAY_SESSIONS_PATH}/${HOST_A}/sessions`), res, urlOf(`${RELAY_SESSIONS_PATH}/${HOST_A}/sessions`))

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

    await relay.handleSessions(req(`${RELAY_SESSIONS_PATH}/${HOST_A}/sessions`), res, urlOf(`${RELAY_SESSIONS_PATH}/${HOST_A}/sessions`))

    const body = JSON.parse(state.body)
    expect(body.error).toBe('machine-error')
    expect(JSON.stringify(body)).not.toContain('/root/.ssh/id_rsa')
  })
})

describe('常量', () => {
  it('三条路径都在 relay 前缀下', () => {
    // 尾斜杠是这条路径唯一致命的地方：宿主匹配用 prefix + '/'，自带斜杠即永不命中。
    expect(RELAY_SESSIONS_PATH).toBe('/threadharbor/relay/hosts')
    expect(RELAY_SESSIONS_PATH.endsWith('/')).toBe(false)
    expect(RELAY_EVENTS_PATH).toBe('/threadharbor/relay/events')
    expect(RELAY_ANSWER_PATH).toBe('/threadharbor/relay/answer')
  })
})

describe('评审补的接线用例（C1/C2/I1/I2 的判别力）', () => {
  /** 转发一律走公开面：handleMessages + 一个把上游结果设好的假客户端。 */
  function relayWith(client: ReturnType<typeof fakeClient>, extra: Record<string, unknown> = {}) {
    return new Relay({ knownHostIds: new Set(['host-a']), clients: { clientFor: async () => client.client, invalidate: () => {}, closeAll: () => {} }, ...extra })
  }

  async function messagesVia(relay: Relay, url: string) {
    const { state, res } = recorder()
    await relay.handleMessages(
      { method: 'GET', url, headers: {} } as never,
      res as never,
      new URL(`http://x${url}`),
    )
    return state
  }

  const MESSAGES_URL = '/threadharbor/relay/hosts/host-a/sessions/s1/messages'

  it('C1：挂上订阅必须建连（不连则事件不来、应答拿不到 clientId）', async () => {
    const fake = fakeClient()
    await relayWith(fake).attachClients()
    expect(fake.connects).toBeGreaterThanOrEqual(1)
  })

  it('C2：上游 401 必须触达凭据层（只关客户端等于坏 cookie 永远用着）', async () => {
    const fake = fakeClient()
    fake.state.result = { ok: false, kind: 'unauthorized' }
    let stale: string | undefined
    const relay = relayWith(fake, { onCredentialStale: (hostId: string) => { stale = hostId } })
    const state = await messagesVia(relay, MESSAGES_URL)
    expect(state.body).toContain('credential-stale')
    expect(stale).toBe('host-a')
  })

  it('I1：401 换掉客户端后，对账给它重挂订阅（否则该机事件永久静音）', async () => {
    const seen: string[] = []
    const first = fakeClient()
    let current = first
    const relay = new Relay({
      knownHostIds: new Set(['host-a']),
      clients: {
        clientFor: async () => current.client,
        invalidate: () => { current = fakeClient() }, closeAll: () => {},
      },
    })
    relay.registerPhone({ on: () => {}, close: () => {}, send: (frame: string) => { seen.push(frame) } } as never)
    await relay.attachClients()
    current.emit('item', { t: 'one' })
    relay.invalidateClient('host-a')
    await relay.reconcile()
    current.emit('item', { t: 'two' })
    expect(seen).toHaveLength(2)
  })

  it('I1：启动时离线的机器，上线后对账能自己补上订阅', async () => {
    const seen: string[] = []
    const late = fakeClient()
    let up = false
    const relay = new Relay({
      knownHostIds: new Set(['host-a']),
      clients: { clientFor: async () => { if (!up) throw new Error('还没上线'); return late.client }, invalidate: () => {}, closeAll: () => {} },
    })
    relay.registerPhone({ on: () => {}, close: () => {}, send: (frame: string) => { seen.push(frame) } } as never)
    await relay.attachClients() // 离线：静默跳过
    up = true
    await relay.reconcile()
    late.emit('item', { t: 'late' })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain('late')
  })

  it('I2a：应答失败只给固定文案（上游 error.message 原文不进应答体）', async () => {
    const fake = fakeClient()
    fake.answerOutcome = { ok: false, message: '上游内部：ENOENT /srv/secret/creds.json' }
    const { state, res } = recorder()
    await relayWith(fake).handleAnswer(req(RELAY_ANSWER_PATH, 'POST', { hostId: 'host-a', eventId: 'e1', outcome: { kind: 'next' } }), res as never)
    expect(state.body).toContain('answer-failed')
    expect(state.body).not.toContain('secret')
  })

  it('I2b：取客户端失败时与 rpc-error 同形（不泄露 SSH stderr 原文）', async () => {
    const relay = new Relay({
      knownHostIds: new Set(['host-a']),
      clients: { clientFor: async () => { throw new Error('ssh failed: root@100.84.120.35: Permission denied (publickey)') }, invalidate: () => {}, closeAll: () => {} },
    })
    const state = await messagesVia(relay, MESSAGES_URL)
    expect(state.body).toContain('machine-error')
    expect(state.body).not.toContain('100.84')
  })

  it('尾随多余段一律 404（段数关不是冗余：多一段会被当真转发）', async () => {
    const fake = fakeClient()
    const state = await messagesVia(relayWith(fake), '/threadharbor/relay/hosts/host-a/sessions/s1/messages/extra')
    expect(state.status).toBe(404)
    expect(fake.calls).toHaveLength(0)
  })
})

describe('内部故障有落点（有界化不等于静默）', () => {
  it('取客户端失败：应答有界，但日志里有 hostId 与原因', async () => {
    const logs: string[] = []
    const relay = new Relay({
      knownHostIds: new Set(['host-a']),
      clients: { clientFor: async () => { throw new Error('ssh 退出码 255') }, invalidate: () => {}, closeAll: () => {} },
      log: message => { logs.push(message) },
    })
    const { state, res } = recorder()
    await relay.handleMessages(
      { method: 'GET', url: '/threadharbor/relay/hosts/host-a/sessions/s1/messages', headers: {} } as never,
      res as never,
      new URL('http://x/threadharbor/relay/hosts/host-a/sessions/s1/messages'),
    )
    expect(state.body).not.toContain('退出码')
    expect(logs.join('\n')).toContain('host-a')
    expect(logs.join('\n')).toContain('退出码')
  })

  it('上游 rpc-error：同样有界 + 有落点', async () => {
    const logs: string[] = []
    const fake = fakeClient()
    fake.state.result = { ok: false, kind: 'rpc-error', message: '上游内部：ENOENT /srv/secret' }
    const relay = new Relay({
      knownHostIds: new Set(['host-a']),
      clients: { clientFor: async () => fake.client, invalidate: () => {}, closeAll: () => {} },
      log: message => { logs.push(message) },
    })
    const { state, res } = recorder()
    await relay.handleMessages(
      { method: 'GET', url: '/threadharbor/relay/hosts/host-a/sessions/s1/messages', headers: {} } as never,
      res as never,
      new URL('http://x/threadharbor/relay/hosts/host-a/sessions/s1/messages'),
    )
    expect(state.body).not.toContain('secret')
    expect(logs.join('\n')).toContain('secret')
  })
})

describe('上游 RPC 的参数形状（`_request` 壳）', () => {
  it('会话列表也要带空的 _request（上游描述符要求每个方法有请求对象）', async () => {
    const fake = fakeClient()
    const relay = new Relay({
      knownHostIds: new Set(['host-a']),
      clients: { clientFor: async () => fake.client, invalidate: () => {}, closeAll: () => {} },
    })
    const { res } = recorder()
    await relay.handleSessions(
      { method: 'GET', url: '/threadharbor/relay/hosts/host-a/sessions', headers: {} } as never,
      res as never,
      new URL('http://x/threadharbor/relay/hosts/host-a/sessions'),
    )
    expect(fake.calls[0]?.args).toEqual({ _request: {} })
  })
})

describe('转发参数形状照抄宿主描述符（线上字段名 = 形参名）', () => {
  function relayFor(fake: { client: unknown }) {
    return new Relay({
      knownHostIds: new Set(['host-a']),
      clients: { clientFor: async () => fake.client as never, invalidate: () => {}, closeAll: () => {} },
    })
  }

  it('session/page：用 request 而不是 _request，body 是 address + throughSeq', async () => {
    const fake = fakeClient()
    const relay = relayFor(fake)
    const { res } = recorder()
    await relay.handleMessages(
      { method: 'GET', url: '/threadharbor/relay/hosts/host-a/sessions/s1/messages', headers: {} } as never,
      res as never,
      new URL('http://x/threadharbor/relay/hosts/host-a/sessions/s1/messages'),
    )
    expect(fake.calls[0]?.endpoint).toBe('session/page')
    expect(fake.calls[0]?.args).toEqual({ request: { address: { kind: 'session', sessionId: 's1' }, throughSeq: -1 } })
  })

  it('session/cancel：用 request，body 只带 sessionId', async () => {
    const fake = fakeClient()
    const relay = relayFor(fake)
    const { res } = recorder()
    await relay.handleCancel(
      { method: 'POST', url: '/threadharbor/relay/hosts/host-a/sessions/s1/cancel', headers: {} } as never,
      res as never,
      new URL('http://x/threadharbor/relay/hosts/host-a/sessions/s1/cancel'),
    )
    expect(fake.calls[0]?.endpoint).toBe('session/cancel')
    expect(fake.calls[0]?.args).toEqual({ request: { sessionId: 's1' } })
  })

  it('session/prompt：四项必填齐（requestId / sessionId / mode / content 分片）', async () => {
    const fake = fakeClient()
    const relay = relayFor(fake)
    const { res } = recorder()
    await relay.handlePrompt(
      req('/threadharbor/relay/hosts/host-a/sessions/s1/prompt', 'POST', { text: '发一句' }),
      res as never,
      new URL('http://x/threadharbor/relay/hosts/host-a/sessions/s1/prompt'),
    )
    const args = fake.calls[0]?.args as { request?: Record<string, unknown> }
    expect(fake.calls[0]?.endpoint).toBe('session/prompt')
    expect(Object.keys(args.request ?? {}).sort()).toEqual(['content', 'mode', 'requestId', 'sessionId'])
    expect(args.request?.['mode']).toBe('queue')
    expect(args.request?.['content']).toEqual([{ type: 'text', text: '发一句' }])
    expect(String(args.request?.['requestId'])).toMatch(/^th-[0-9a-f-]{36}$/)
  })

  it('两笔 prompt 的 requestId 不同（幂等键重了会被当成同一笔）', async () => {
    const fake = fakeClient()
    const relay = relayFor(fake)
    const prompt = async () => {
      const { res } = recorder()
      await relay.handlePrompt(
        req('/threadharbor/relay/hosts/host-a/sessions/s1/prompt', 'POST', { text: '同样一句' }),
        res as never,
        new URL('http://x/threadharbor/relay/hosts/host-a/sessions/s1/prompt'),
      )
    }
    await prompt()
    await prompt()
    const ids = fake.calls.map(call => (call.args as { request: { requestId: string } }).request.requestId)
    expect(new Set(ids).size).toBe(2)
  })
})

describe('历史分页参数要透传（写死游标 = 手机翻不动历史）', () => {
  async function pageArgsOf(query: string): Promise<unknown> {
    const fake = fakeClient()
    const relay = new Relay({
      knownHostIds: new Set(['host-a']),
      clients: { clientFor: async () => fake.client, invalidate: () => {}, closeAll: () => {} },
    })
    const path = `/threadharbor/relay/hosts/host-a/sessions/s1/messages${query}`
    const { res } = recorder()
    await relay.handleMessages(
      { method: 'GET', url: path, headers: {} } as never,
      res as never,
      new URL(`http://x${path}`),
    )
    return fake.calls[0]?.args
  }

  it('游标与每页条数原样进上游', async () => {
    expect(await pageArgsOf('?throughSeq=42&maxMessages=7')).toEqual({
      request: { address: { kind: 'session', sessionId: 's1' }, throughSeq: 42, maxMessages: 7 },
    })
  })

  it('只给游标：maxMessages 不出现（让上游用自己的默认值）', async () => {
    expect(await pageArgsOf('?throughSeq=0')).toEqual({
      request: { address: { kind: 'session', sessionId: 's1' }, throughSeq: 0 },
    })
  })

  it('都没有：throughSeq 取 -1（不按游标截断，取整段）', async () => {
    expect(await pageArgsOf('')).toEqual({
      request: { address: { kind: 'session', sessionId: 's1' }, throughSeq: -1 },
    })
  })

  it('坏值不透传（上游对游标有上限检查，手机看到的是读不懂的失败）', async () => {
    expect(await pageArgsOf('?throughSeq=abc&maxMessages=0')).toEqual({
      request: { address: { kind: 'session', sessionId: 's1' }, throughSeq: -1 },
    })
    expect(await pageArgsOf('?maxMessages=1.5')).toEqual({
      request: { address: { kind: 'session', sessionId: 's1' }, throughSeq: -1 },
    })
  })

  it('游标可以是负数（-1 是「不按游标截断」的意思，不是不合法）', async () => {
    expect(await pageArgsOf('?throughSeq=-5')).toEqual({
      request: { address: { kind: 'session', sessionId: 's1' }, throughSeq: -5 },
    })
  })
})

