/**
 * 对手机暴露的转发接口与跨机事件汇流。
 *
 * 手机不再直连某一台机器，而是连中转；中转把请求按路径里的 hostId 转发到对应
 * 那台机器的 DSH，并把各机的实时事件汇成一条流推给手机。三条硬纪律：
 *
 * - **归属**：每条事件带上它来自哪台机器，每条审批应答只发给发起它的那台。
 *   两台机器同时有待批请求时，发错机器不会报错、只会批错事——比崩掉更糟。
 * - **白名单**：路径里的 hostId 必须在配置登记内，sid 必须形如
 *   `^[\w.:-]{1,128}$`。这两个值要拼进上游 URL，不校验就是把手机给的任意
 *   路径原样送到上游去。
 * - **有界的错误**：上游原文可能含内部细节（路径、栈、机器上的用户名），
 *   一律映射成固定的几句话，不转发原文。
 *
 * 手机断线只摘它自己那一条连接；上游（各机客户端）的生命周期与手机无关。
 */

import {
  EVENT_RESULT_ENDPOINT,
  SESSION_CANCEL_ENDPOINT,
  SESSION_HISTORY_ENDPOINT,
  SESSION_LIST_ENDPOINT,
  SESSION_PROMPT_ENDPOINT,
} from './wire.ts'
import type { EventOutcome, MachineClient, RpcResult } from './machine-client.ts'

/** 会话类接口的 prefix（hostId 与 sid 都在路径里，故只能 prefix 注册）。 */
export const RELAY_SESSIONS_PATH = '/threadharbor/relay/hosts/'
/** 手机的事件流（WebSocket）。 */
export const RELAY_EVENTS_PATH = '/threadharbor/relay/events'
/** 审批应答（POST）。 */
export const RELAY_ANSWER_PATH = '/threadharbor/relay/answer'

/**
 * 路径段下标（以 `<prefix>/<hostId>/…` 计，前缀本身占 2 段）：
 * `/threadharbor/relay/hosts/<hostId>/sessions/<sid>/<action>` 里
 * hostId 是第 3 段、sid 是第 5 段。下标写错一个就是「恒 404」——
 * 每台机器都在 404，而症状看上去完全像「中转没接上」。
 */
const HOST_SEGMENT = 3
const SID_SEGMENT = 5

/** 会话类接口的动作段（与上游 endpoint 同名）。 */
type ActionName = 'sessions' | 'messages' | 'prompt' | 'cancel'

/** 会话 id 的白名单形状：字母数字、下划线、点、冒号、连字符，长度有界。 */
const SID_PATTERN = /^[\w.:-]{1,128}$/

/** 手机侧连接（WebSocket 的最小面：能发帧、能关）。 */
export interface PhoneSocket {
  send(data: string): void
  close(): void
  on?(event: string, handler: () => void): void
}

/**
 * 客户端池（装配层持有）：按 hostId 给出该机的客户端。池子负责懒建与复用，
 * 这里只当目录用——这样本模块的用例可以用假客户端，不碰真隧道与真网络。
 */
export interface ClientPool {
  /** 该机的客户端；第一次要它时会开隧道（origin 到那时才定）。 */
  clientFor(hostId: string): Promise<MachineClient>
  /** 上游 401 时通知上层把该机凭据标脏（下一拍自愈一次）。 */
  invalidate(hostId: string): void
  closeAll(): void
}

export interface RelayDeps {
  /** 配置里登记过的 hostId 全集；不在其中的路径一律 404。 */
  knownHostIds: ReadonlySet<string>
  clients: ClientPool
  /** 装配层提供的凭据自愈钩子（测试可覆盖）。 */
  onCredentialStale?: (hostId: string) => void
}

/** 转发结果 → 手机看到的应答体。 */
type RelayBody = { ok: true; value: unknown } | { error: string }

export class Relay {
  private readonly deps: RelayDeps
  private readonly phones = new Set<PhoneSocket>()
  /** 已挂事件订阅的上游客户端：停机时按它退订，避免闭包把已关的连接留住。 */
  private attached: { client: MachineClient; detach: () => void }[] = []

  constructor(deps: RelayDeps) {
    this.deps = deps
  }

  /** 上游 401 时通知上层标脏该机凭据（测试用它观察是否被调用）。 */
  onStale: (hostId: string) => void = (hostId) => this.deps.onCredentialStale?.(hostId)

  /** 把各机客户端的事件挂上汇流：每帧加上 hostId 后广播给所有已连手机。 */
  async attachClients(): Promise<void> {
    await Promise.all([...this.deps.knownHostIds].map(hostId => this.attachOne(hostId)))
  }

  /** 单机挂订阅；开不出隧道就跳过——该机这一轮没有事件，等下一轮清单再试。 */
  private async attachOne(hostId: string): Promise<void> {
    try {
      const client = await this.deps.clients.clientFor(hostId)
      const detach = client.onEvent('*', (value) => this.broadcast(hostId, value))
      this.attached.push({ client, detach })
    } catch {
      /* 这台机现在用不了：不开连接，也不影响其余机器的汇流 */
    }
  }

  /** 手机接上事件流。 */
  registerPhone(socket: PhoneSocket): void {
    this.phones.add(socket)
    socket.on?.('close', () => this.dropPhone(socket))
  }

  /** 手机断开：只摘它自己。 */
  dropPhone(socket: PhoneSocket): void {
    this.phones.delete(socket)
  }

  /** 广播一帧：加上 hostId 让手机知道这是哪台机器的事。 */
  private broadcast(hostId: string, value: unknown): void {
    const frame = JSON.stringify({ type: 'item', hostId, value })
    for (const phone of this.phones) {
      try {
        phone.send(frame)
      } catch {
        // 写不进去（手机刚断、缓冲满）就摘掉它，不让一条坏连接挡住其余手机。
        this.phones.delete(phone)
      }
    }
  }

  /** 事件流升级（WebSocket）：手机连上来先给一帧 ready，让它知道汇流已就绪。 */
  connectEvents(socket: PhoneSocket): void {
    this.registerPhone(socket)
    try {
      socket.send(JSON.stringify({ type: 'ready' }))
    } catch {
      this.phones.delete(socket)
    }
  }

  /** 停机：退订上游、关掉所有手机连接、上游客户端由池子统一关。 */
  stop(): void {
    for (const { detach } of this.attached) detach()
    this.attached = []
    for (const phone of [...this.phones]) {
      try {
        phone.close()
      } catch {
        /* 已经断了就算了 */
      }
    }
    this.phones.clear()
    this.deps.clients.closeAll()
  }

  // ── HTTP 转发 ────────────────────────────────────────────────────────────

  /** `<prefix>/<hostId>/sessions` → 该机的会话清单。 */
  async handleSessions(req: IncomingMessageLike, res: ResponseLike, url: URL): Promise<void> {
    const parts = this.parse(url, 'sessions')
    if (parts === undefined) return notFound(res)
    await this.forward(req, res, parts.hostId, SESSION_LIST_ENDPOINT, {})
  }

  /** `<prefix>/<hostId>/sessions/<sid>/messages` → 该会话的历史消息。 */
  async handleMessages(req: IncomingMessageLike, res: ResponseLike, url: URL): Promise<void> {
    const parts = this.parse(url, 'messages')
    if (parts === undefined) return notFound(res)
    await this.forward(req, res, parts.hostId, SESSION_HISTORY_ENDPOINT, { _request: { sessionId: parts.sid } })
  }

  /** `POST <prefix>/<hostId>/sessions/<sid>/prompt` → 发消息。 */
  async handlePrompt(req: IncomingMessageLike, res: ResponseLike, url: URL): Promise<void> {
    const parts = this.parse(url, 'prompt')
    if (parts === undefined) return notFound(res)
    const body = await readJsonBody(req)
    if (body === undefined) return badRequest(res)
    const text = typeof body['text'] === 'string' ? body['text'] : undefined
    if (text === undefined) return badRequest(res)
    await this.forward(req, res, parts.hostId, SESSION_PROMPT_ENDPOINT, { request: { sessionId: parts.sid, text } })
  }

  /** `POST <prefix>/<hostId>/sessions/<sid>/cancel` → 中断。 */
  async handleCancel(req: IncomingMessageLike, res: ResponseLike, url: URL): Promise<void> {
    const parts = this.parse(url, 'cancel')
    if (parts === undefined) return notFound(res)
    await this.forward(req, res, parts.hostId, SESSION_CANCEL_ENDPOINT, { _request: { sessionId: parts.sid } })
  }

  /**
   * 审批应答：`POST /threadharbor/relay/answer`，体 `{hostId, eventId, outcome}`。
   *
   * **归属是这里唯一的重点**：应答必须落到发起该请求的那台机器的连接上。
   * 事件帧里带了 hostId，手机回信时原样带回来，中转据此选客户端——不靠
   * 「哪台先连上」或「哪台最近有活动」这类猜测。
   */
  async handleAnswer(req: IncomingMessageLike, res: ResponseLike): Promise<void> {
    const body = await readJsonBody(req)
    if (body === undefined) return badRequest(res)
    const hostId = typeof body['hostId'] === 'string' ? body['hostId'] : undefined
    const eventId = typeof body['eventId'] === 'string' ? body['eventId'] : undefined
    const outcome = body['outcome']
    if (hostId === undefined || eventId === undefined || !isOutcome(outcome)) return badRequest(res)
    if (!this.deps.knownHostIds.has(hostId)) return notFound(res)
    if (!SID_PATTERN.test(eventId)) return notFound(res)

    const result = await (await this.deps.clients.clientFor(hostId)).answer(eventId, outcome)
    respondJson(res, 200, JSON.stringify(result.ok ? { ok: true } : { error: 'answer-failed', message: result.message ?? '' }))
  }

  /** 一次转发的共同外壳：取客户端、发 RPC、把结果映射成手机看得懂的形状。 */
  private async forward(
    req: IncomingMessageLike,
    res: ResponseLike,
    hostId: string,
    endpoint: string,
    args: Record<string, unknown>,
  ): Promise<void> {
    let result: RpcResult
    try {
      // 取客户端也在预算内：它内部会开隧道（首次约 0.35s 判成功窗）。
      // 开不出来就算这一机现在用不了，不该把整个转发请求拖成 500。
      const client = await this.deps.clients.clientFor(hostId)
      result = await client.call(endpoint, args)
    } catch (error) {
      respondJson(res, 200, JSON.stringify({ error: 'machine-error', message: messageOf(error) }))
      return
    }
    if (result.ok) {
      respondJson(res, 200, JSON.stringify({ ok: true, value: result.value }))
      return
    }
    if (result.kind === 'unauthorized') {
      // 上游说凭据不对：标脏 + 通知上层自愈，下一拍请求就会带新 cookie 重试。
      this.deps.clients.invalidate(hostId)
      this.onStale(hostId)
      respondJson(res, 200, JSON.stringify({ error: 'credential-stale' }))
      return
    }
    // rpc-error / transport 一律压成固定文案：上游原文可能含内部细节。
    respondJson(res, 200, JSON.stringify({ error: 'machine-error' }))
  }

  /**
   * 按形状解路径：`<prefix>/<hostId>/sessions` 或 `<prefix>/<hostId>/sessions/<sid>/<action>`。
   *
   * 四道关一起过才放行：段数正好、hostId 在配置登记内、sid 过白名单、动作段对上。
   * 只校验其中一两道的后果很具体——段数不对而放行，会拿一条没有 sid 的路径去
   * 上游要数据（上游要么报错、要么按「最近会话」回答）；而症状看上去完全像
   * 「某台机器坏了」。
   */
  private parse(url: URL, action: ActionName): { hostId: string; sid?: string } | undefined {
    const segments = segmentsOf(url)
    const withSid = action !== 'sessions'
    if (segments.length !== (withSid ? 7 : 5)) return undefined
    if (segments[0] !== 'threadharbor' || segments[1] !== 'relay' || segments[2] !== 'hosts') return undefined
    const hostId = segments[HOST_SEGMENT]
    if (hostId === undefined || !this.deps.knownHostIds.has(hostId)) return undefined
    if (!withSid) {
      return segments[4] === 'sessions' ? { hostId } : undefined
    }
    if (segments[4] !== 'sessions' || segments[6] !== action) return undefined
    const sid = segments[SID_SEGMENT]
    if (sid === undefined || !SID_PATTERN.test(sid)) return undefined
    return { hostId, sid }
  }
}

// ── 小工具 ────────────────────────────────────────────────────────────────

/**
 * 请求的最小面。宿主给的是真 IncomingMessage，而这里只用到 method/url/headers
 * 与那个读流接口——写成结构类型（而不是直接依赖 node:http 的类型）是为了让
 * 插件在宿主以 strip-only 模式装载时不必牵进 Node 内建类型。
 */
export type IncomingMessageLike = {
  method?: string | undefined
  url?: string | undefined
  headers?: Record<string, string | string[] | undefined> | undefined
}
type ResponseLike = {
  writeHead(status: number, headers?: Record<string, string | number | string[]>): void
  end(chunk?: string): void
}

function segmentsOf(url: URL): string[] {
  return url.pathname.split('/').filter(segment => segment !== '')
}

function respondJson(res: ResponseLike, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function notFound(res: ResponseLike): void {
  respondJson(res, 404, JSON.stringify({ error: 'not-found' }))
}

function badRequest(res: ResponseLike): void {
  respondJson(res, 400, JSON.stringify({ error: 'bad-request' }))
}

/** 读请求体（限长 64 KiB，手机发的是小 JSON）。 */
async function readJsonBody(req: IncomingMessageLike): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  const stream = (req as unknown as { on?: (event: string, fn: (chunk: Buffer) => void) => void }).on
  if (typeof stream !== 'function') return undefined
  const done = new Promise<void>(resolve => {
    stream.call(req, 'data', (chunk: Buffer) => {
      size += chunk.length
      if (size <= 64 * 1024) chunks.push(chunk)
    })
    stream.call(req, 'end', () => resolve())
    stream.call(req, 'error', () => resolve())
  })
  await done
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** outcome 只放三种形状；别的（可执行代码、非对象）一律拒。 */
function isOutcome(value: unknown): value is EventOutcome {
  if (typeof value !== 'object' || value === null) return false
  const kind = (value as { kind?: unknown }).kind
  if (kind === 'next') return true
  if (kind === 'rejected') return typeof (value as { error?: unknown }).error === 'string'
  if (kind === 'result') return true
  return false
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 供装配层复用：把各机客户端按 hostId 挂上汇流。 */
export function attachAllClients(relay: Relay): void {
  relay.attachClients()
}

/** 事件结果端点（供接线自检用；这里再导出一次是给装配层拼路径校验时用）。 */
export { EVENT_RESULT_ENDPOINT }
