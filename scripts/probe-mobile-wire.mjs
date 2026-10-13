#!/usr/bin/env node
/**
 * Live wire-protocol probe for the ThreadHarbor mobile entry (Task 6).
 *
 * Pins, against a running `dsh web` instance, the exact endpoints, request/
 * response envelopes, WebSocket mux framing, and approval-event semantics the
 * mobile page will speak. Every constant in
 * packages/dsh-mobile-entry/src/wire.ts must trace to this script's output or
 * to a cited reference-source line — never to a guess.
 *
 * Usage:
 *   node scripts/probe-mobile-wire.mjs <token>
 *   DSH_PROBE_TOKEN=... node scripts/probe-mobile-wire.mjs          # same
 *   DSH_PROBE_BASE=http://127.0.0.1:3091 …                          # override base URL
 *
 * The token is the process token from the `dsh web:` line of the instance's
 * web.log. The script exchanges it for the browser-session cookie exactly the
 * way the page bootstrap does (GET /?token=… → 303 + Set-Cookie), then speaks
 * the same wire the browser speaks: POST /api/<endpoint> RPC envelopes and a
 * /api/remote.mux WebSocket multiplexer with `$events` subscriptions.
 *
 * Output: one compact JSON line per exchange, tagged by phase. Repeatable:
 * each run creates its own probe sessions and closes its own sockets; the
 * sessions it created stay on the instance (they are ordinary durable
 * sessions, listed by later session/list calls).
 */

const BASE = process.env.DSH_PROBE_BASE ?? 'http://127.0.0.1:3091'
const TOKEN = process.argv.slice(2).find(arg => !arg.startsWith('--')) ?? process.env.DSH_PROBE_TOKEN

if (!TOKEN) {
  console.error('usage: node scripts/probe-mobile-wire.mjs <token>  (or DSH_PROBE_TOKEN=…)')
  process.exit(2)
}

/** One compact JSON line per observation. */
function emit(tag, data) {
  console.log(JSON.stringify({ tag, ...data }))
}

const rpcId = () => crypto.randomUUID()
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/** Exchange the process launch token for the signed session cookie. */
async function exchangeToken() {
  const response = await fetch(`${BASE}/?token=${encodeURIComponent(TOKEN)}`, { redirect: 'manual' })
  const cookies = response.headers.getSetCookie()
  const pairs = cookies.map(cookie => cookie.split(';', 1)[0])
  emit('auth.exchange', {
    status: response.status,
    location: response.headers.get('location'),
    cookieNames: pairs.map(pair => pair.slice(0, pair.indexOf('='))),
  })
  if (response.status !== 303 || pairs.length === 0) {
    throw new Error(`token exchange failed: HTTP ${response.status}`)
  }
  return pairs.join('; ')
}

/**
 * One Connection RPC call: POST /api/<endpoint> with the exact envelope the
 * browser carrier sends (client/rpc.ts). `args` is the named-arguments object;
 * on a `missing "wire"` arguments error the call is retried once with the
 * server-named wire field, and the adaptation is reported.
 */
async function rpc(cookie, endpoint, args = {}, { quiet = false } = {}) {
  const send = async (payload) => {
    const id = rpcId()
    const response = await fetch(`${BASE}/api/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ type: 'client-request', rpcId: id, method: endpoint, payload }),
    })
    const body = await response.json()
    return { status: response.status, body, id }
  }
  let attempt = await send({ args })
  if (!quiet) {
    emit('rpc', { endpoint, request: { method: endpoint, payload: { args } }, status: attempt.status, response: trim(attempt.body) })
  }
  const message = attempt.body?.result?.error?.message
  const missing = attempt.body?.result?.error?.code === 'gateway/arguments-invalid'
    ? /missing "([^"]+)"/.exec(message ?? '')?.[1]
    : undefined
  if (missing !== undefined) {
    attempt = await send({ [missing]: args })
    emit('rpc.adapt', { endpoint, wireField: missing, request: { payload: { [missing]: args } }, status: attempt.status, response: trim(attempt.body) })
  }
  return attempt.body?.result
}

/** Depth-limited view so samples stay one-line readable. */
function trim(value, depth = 0) {
  if (depth >= 4) return '…'
  if (Array.isArray(value)) {
    const items = value.slice(0, 3).map(item => trim(item, depth + 1))
    return value.length > 3 ? [...items, `…+${value.length - 3}`] : items
  }
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = trim(item, depth + 1)
    return out
  }
  if (typeof value === 'string' && value.length > 220) return `${value.slice(0, 220)}…`
  return value
}

/**
 * One mux WebSocket connection. Frames are logged verbatim (server side
 * trimmed) into `frames` while listeners can wait for specific shapes.
 */
class Mux {
  static async connect(cookie, label) {
    const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/api/remote.mux`, { headers: { cookie } })
    const mux = new Mux(ws, label)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', () => reject(new Error(`${label}: upgrade failed`)), { once: true })
    })
    emit('mux.open', { connection: label })
    return mux
  }

  constructor(ws, label) {
    this.ws = ws
    this.label = label
    this.frames = [] // downlink mux frames: {type:'item'|'end'|'error', streamId, ...}
    this.waiters = new Set()
    this.closed = new Promise(resolve => ws.addEventListener('close', resolve, { once: true }))
    ws.addEventListener('message', (event) => {
      let frame
      try { frame = JSON.parse(String(event.data)) } catch { return }
      this.frames.push(frame)
      emit('mux.frame', { connection: this.label, frame: trim(frame) })
      for (const waiter of [...this.waiters]) {
        if (waiter.match(frame)) { this.waiters.delete(waiter); waiter.resolve(frame) }
      }
    })
  }

  /** Open one logical stream and resolve with its first downlink frame. */
  open(endpoint, payload) {
    const streamId = crypto.randomUUID()
    this.ws.send(JSON.stringify({ type: 'open', streamId, endpoint, payload }))
    return { streamId, first: this.waitFor(frame => frame.streamId === streamId) }
  }

  waitFor(match) {
    const existing = this.frames.find(match)
    if (existing !== undefined) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve, done: false }
      this.waiters.add(waiter)
      setTimeout(() => {
        if (!waiter.done) {
          waiter.done = true
          this.waiters.delete(waiter)
          reject(new Error(`${this.label}: wait timeout`))
        }
      }, 180_000)
    })
  }

  /** Downlink event frames of one stream, unwrapped from their item carrier. */
  eventFrames(streamId) {
    return this.frames
      .filter(frame => frame.type === 'item' && frame.streamId === streamId)
      .map(frame => frame.value)
  }

  async close() {
    this.ws.close()
    await this.closed
    emit('mux.close', { connection: this.label })
  }
}

/** Poll collected frames across connections until one matches, or time out. */
async function anyEventByPolling(connections, match, timeoutMs, pollMs = 100) {
  const deadline = Date.now() + timeoutMs
  let seen = 0
  while (Date.now() < deadline) {
    for (const connection of connections) {
      const frames = connection.frames.slice(seen)
      for (const frame of frames) {
        const value = frame.type === 'item' && frame.value && typeof frame.value === 'object' ? frame.value : undefined
        if (value !== undefined && match(value)) return { connection, frame: value }
      }
    }
    seen = Math.max(...connections.map(connection => connection.frames.length), seen)
    await sleep(pollMs)
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

const cookie = await exchangeToken()

// (a) session list -----------------------------------------------------------
const list = await rpc(cookie, 'session/list', { _request: {} })
const firstItem = list?.ok === true ? list.value.items[0] : undefined
emit('summary', { endpoint: 'session/list', itemFieldNames: firstItem === undefined ? [] : Object.keys(firstItem), itemCount: list?.ok === true ? list.value.items.length : undefined })

// (b/d) two mux connections, each with its own $events subscription ----------
const connA = await Mux.connect(cookie, 'A')
const connB = await Mux.connect(cookie, 'B')
const openA = connA.open('$events', { args: {} })
const readyA = (await openA.first).value
const openB = connB.open('$events', { args: {} })
const readyB = (await openB.first).value
emit('events.ready', {
  A: readyA, B: readyB,
  distinctClientIds: readyA?.clientId !== readyB?.clientId,
})

// (a) session create ---------------------------------------------------------
const created = await rpc(cookie, 'session/create', { request: {} })
const sessionId = created?.ok === true ? created.value.sessionId : undefined

// (b) follow stream: opening snapshot = the journal's first window -----------
const followA = sessionId === undefined ? undefined : connA.open('session/follow', {
  args: { request: { address: { kind: 'session', sessionId }, assistantStream: true } },
})
const snapshotFrame = followA === undefined ? undefined : (await followA.first).value
emit('journal.snapshot', {
  endpoint: 'session/follow',
  frame: snapshotFrame === undefined ? undefined : {
    type: snapshotFrame.type,
    header: snapshotFrame.header,
    cursor: snapshotFrame.cursor,
    hasMore: snapshotFrame.hasMore,
    recordCount: snapshotFrame.records?.length,
    firstRecord: snapshotFrame.records?.[0],
    projections: snapshotFrame.projections,
    assistantStream: snapshotFrame.assistantStream,
  },
})

// (a) prompt send + live emit/journal observation -----------------------------
const promptText = '请只回复一个词：ok'
const prompt = sessionId === undefined ? undefined : await rpc(cookie, 'session/prompt', {
  request: {
    requestId: rpcId(),
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: promptText }],
    clientTimeZone: 'Asia/Shanghai',
  },
})
// Give the host a moment to run the turn; journal items and api-session emits
// accumulate on both connections during this window.
await sleep(6000)

// (a) cancel ------------------------------------------------------------------
const cancel = sessionId === undefined ? undefined : await rpc(cookie, 'session/cancel', { request: { sessionId } })
await sleep(1500)

// (b/d) frame inventory across both connections ------------------------------
for (const connection of [connA, connB]) {
  const eventsStreamId = connection === connA ? openA.streamId : openB.streamId
  const events = connection.eventFrames(eventsStreamId)
  emit('events.inventory', {
    connection: connection.label,
    emitEvents: events.filter(value => value?.type === 'emit').map(value => value.event),
    waterfallEvents: events.filter(value => value?.type === 'waterfall').map(value => ({ event: value.event, eventId: value.eventId })),
  })
}
if (followA !== undefined) {
  const journalItems = connA.frames.filter(frame => frame.type === 'item' && frame.streamId === followA.streamId)
  emit('journal.items', {
    connection: 'A',
    count: journalItems.length,
    kinds: [...new Set(journalItems.map(frame => frame.value?.type))],
    firstLiveEntry: journalItems.find(frame => frame.value?.type === 'event')?.value,
  })
}

// (a) history page read (加载更早) --------------------------------------------
const oldestSeq = snapshotFrame?.records?.[0]?.event?.seq
const cursor = snapshotFrame?.cursor
const throughSeq = oldestSeq === undefined ? cursor : oldestSeq - 1
const page = sessionId === undefined ? undefined : await rpc(cookie, 'session/page', {
  request: { address: { kind: 'session', sessionId }, throughSeq, maxMessages: 10 },
}, { quiet: false })
if (sessionId !== undefined && page?.ok === true) {
  const pageOldest = page.value.records[0]?.event?.seq
  emit('page.chain', {
    endpoint: 'session/page',
    throughSeq,
    returnedOldestSeq: pageOldest,
    hasMore: page.value.hasMore,
    note: 'throughSeq is the inclusive cut below the currently-oldest loaded record; next page repeats with throughSeq=returnedOldestSeq-1',
  })
}

// (c/d) approval/request over the mux, answered once, dual-connection fanout --
// Real approvals need an operation the workspace-write preset does not
// auto-allow, so the candidates escalate; if the session's turn ends without a
// waterfall the next candidate is tried. A pending waterfall is answered from
// whichever connection received it first, the losing connection is observed to
// receive the cancellation frame, and the session journal is tailed for the
// approval/asked + approval/decided audit pair.
const escalationPrompts = [
  // Best-effort ask triggers: an outside-workspace write and a network access.
  // Whether the agent's own gate asks the host varies by deployment (see the
  // research note §5.3); the probe records either outcome.
  `请用 shell 工具运行命令：echo approval-probe > ${process.env.DSH_PROBE_ESCALATE_PATH ?? `${process.env.HOME ?? '~'}/approval-probe.txt`} && cat ${process.env.DSH_PROBE_ESCALATE_PATH ?? `${process.env.HOME ?? '~'}/approval-probe.txt`}，并告诉我输出。`,
  '请用 shell 工具运行命令：curl -m 5 -s https://example.com -o /dev/null; echo exit=$?，并告诉我输出。',
]
const eventsStreamOf = (connection) => connection === connA ? openA.streamId : openB.streamId
const clientIdOf = (connection) => connection === connA ? readyA.clientId : readyB.clientId

/**
 * Wait for one waterfall of the given event from `mark` onward (a per-connection
 * frame-index watermark taken when the prompt was sent, so status frames of
 * earlier turns cannot fake an early turn-end); give up early when the turn ends.
 */
async function waitWaterfall(event, sessionToWatch, timeoutMs, mark) {
  const deadline = Date.now() + timeoutMs
  const unwrap = (frame) => frame.type === 'item' && frame.value && typeof frame.value === 'object' ? frame.value : undefined
  const fresh = (connection) => connection.frames.slice(mark.get(connection) ?? 0)
  while (Date.now() < deadline) {
    for (const connection of [connA, connB]) {
      for (const frame of fresh(connection)) {
        const value = unwrap(frame)
        if (value?.type === 'waterfall' && value.event === event) return { connection, frame: value }
      }
    }
    const ended = [connA, connB].some(connection => fresh(connection).some(frame => {
      const value = unwrap(frame)
      return value?.type === 'emit' && value.event === 'api-session/status'
        && value.args?.[0] === sessionToWatch && value.args?.[1] === false
    }))
    if (ended) return undefined
    await sleep(300)
  }
  return undefined
}

/** Frame-count watermark per connection, taken just before a prompt is sent. */
function watermark() {
  return new Map([[connA, connA.frames.length], [connB, connB.frames.length]])
}

/** One full waterfall round-trip: record fanout, answer from the first connection, watch the loser. */
async function roundTrip(arrival, answerOutcome) {
  const { connection: firstConnection, frame: waterfall } = arrival
  const eventId = waterfall.eventId
  await sleep(2000) // let the host deliver the same waterfall to every connected client
  const seenOn = [connA, connB].map(connection => ({
    connection: connection.label,
    saw: connection.eventFrames(eventsStreamOf(connection))
      .some(value => value?.type === 'waterfall' && value.eventId === eventId),
  }))
  emit('waterfall.delivered', {
    event: waterfall.event,
    eventId,
    agentId: waterfall.agentId,
    requestFields: Object.keys(waterfall.request ?? {}),
    request: trim(waterfall.request),
    arrivedOn: seenOn,
    answeredFrom: firstConnection.label,
  })
  const answer = await rpc(cookie, '$events/result', {
    clientId: clientIdOf(firstConnection),
    eventId,
    outcome: answerOutcome,
  })
  emit('waterfall.answer', { outcome: answerOutcome, rpcOk: answer?.ok === true, response: trim(answer) })
  const cancelFrame = await anyEventByPolling(
    [connA, connB].filter(connection => connection !== firstConnection),
    value => value.type === 'cancel' && value.eventId === eventId,
    15_000,
    200,
  )
  emit('waterfall.fanout', {
    loserGotCancel: cancelFrame !== undefined,
    cancelFrame: cancelFrame === undefined ? undefined : cancelFrame.frame,
    semantics: 'waterfall delivered to every connected $events client under one shared eventId; the first client answer settles it; every other client then receives a cancel frame for that eventId',
  })
  return cancelFrame !== undefined
}

const approvalPhase = { triggered: false, fallbackEvent: undefined }
const approvalSession = await rpc(cookie, 'session/create', { request: { agentPreset: 'acp-claude' } })
const approvalSessionId = approvalSession?.ok === true ? approvalSession.value.sessionId : undefined
if (approvalSessionId !== undefined) {
  let answered = false
  for (const promptText of escalationPrompts) {
    if (answered) break
    const sent = await rpc(cookie, 'session/prompt', {
      request: {
        requestId: rpcId(),
        sessionId: approvalSessionId,
        mode: 'queue',
        content: [{ type: 'text', text: promptText }],
        clientTimeZone: 'Asia/Shanghai',
      },
    }, { quiet: true })
    emit('approval.promptSent', { sessionId: approvalSessionId, accepted: sent?.ok === true, text: promptText })
    const arrival = await waitWaterfall('approval/request', approvalSessionId, 90_000, watermark())
    if (arrival === undefined) {
      emit('approval.candidateMissed', { note: 'turn ended without an approval/request waterfall; trying next escalation candidate' })
      continue
    }
    approvalPhase.triggered = true
    await roundTrip(arrival, { kind: 'result', value: 'allowed-once' })
    answered = true
  }
  if (approvalPhase.triggered) {
    // Tail the session journal for the approval audit pair (approval/asked + approval/decided).
    // throughSeq must not exceed the live cursor; learn the cursor from the
    // server's own "past cursor N" bad-request when the guess overshoots.
    let tail = await rpc(cookie, 'session/page', {
      request: { address: { kind: 'session', sessionId: approvalSessionId }, throughSeq: 999_999, maxMessages: 60 },
    }, { quiet: true })
    const cursorHint = /past cursor (\d+)/.exec(tail?.error?.message ?? '')?.[1]
    if (cursorHint !== undefined) {
      tail = await rpc(cookie, 'session/page', {
        request: { address: { kind: 'session', sessionId: approvalSessionId }, throughSeq: Number(cursorHint), maxMessages: 60 },
      }, { quiet: true })
    }
    const audit = tail?.ok === true
      ? tail.value.records.filter(record => record.event.type.startsWith('approval/')).map(record => trim(record.event))
      : `page failed: ${JSON.stringify(trim(tail))}`
    emit('approval.auditEvents', { events: audit })
  } else {
    // Fallback: the sibling forwarded waterfall (user-questions/request) runs on
    // the identical transport; pinning its live round-trip pins the mux
    // waterfall mechanics even when this deployment's approval path stays quiet.
    // Fresh session so the question prompt owns a whole turn.
    const fallbackSession = await rpc(cookie, 'session/create', { request: { agentPreset: 'acp-claude' } })
    const fallbackSessionId = fallbackSession?.ok === true ? fallbackSession.value.sessionId : undefined
    if (fallbackSessionId !== undefined) {
      const fallbackPrompt = '在继续任何工作之前，请先用你的提问工具问我：要不要继续？给我两个选项：继续 / 停止。不要先做别的事情。'
      const sent = await rpc(cookie, 'session/prompt', {
        request: {
          requestId: rpcId(),
          sessionId: fallbackSessionId,
          mode: 'queue',
          content: [{ type: 'text', text: fallbackPrompt }],
          clientTimeZone: 'Asia/Shanghai',
        },
      }, { quiet: true })
      emit('approval.fallbackPromptSent', { sessionId: fallbackSessionId, accepted: sent?.ok === true })
      const arrival = await waitWaterfall('user-questions/request', fallbackSessionId, 120_000, watermark())
      if (arrival === undefined) {
        emit('approval.fallbackMissed', { note: 'no user-questions/request either; waterfall round-trip stays source-verified only' })
      } else {
        approvalPhase.fallbackEvent = arrival.frame.event
        await roundTrip(arrival, { kind: 'rejected', error: { name: 'Error', message: 'probe fallback rejection' } })
      }
      await rpc(cookie, 'session/cancel', { request: { sessionId: fallbackSessionId } }, { quiet: true })
    }
  }
  await rpc(cookie, 'session/cancel', { request: { sessionId: approvalSessionId } }, { quiet: true })
}

// (c) $events/result validation shape (independent of a live waterfall) -------
const bogus = await rpc(cookie, '$events/result', {
  clientId: 'probe-bogus',
  eventId: 'probe-bogus',
  outcome: { kind: 'next' },
})
emit('events.result.validation', {
  endpoint: '$events/result',
  unknownIdsResponse: trim(bogus),
  note: 'well-formed result naming no active delivery errors (no event stream for the clientId) — the endpoint validates {clientId,eventId,outcome} and never answers silently',
})

emit('done', { approvalTriggered: approvalPhase.triggered, fallbackWaterfall: approvalPhase.fallbackEvent })
await connA.close()
await connB.close()
process.exit(0)
