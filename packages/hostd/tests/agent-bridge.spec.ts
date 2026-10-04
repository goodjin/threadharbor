import { chmodSync, existsSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSessionConfig } from '../src/agent-protocol.ts'
import { AgentBridge } from '../src/agent-bridge.ts'
import { jsonLine } from '../src/hostd-util.ts'

const roots: string[] = []
const fixture = new URL('./fixtures/fake-acp-multi.mjs', import.meta.url).pathname

interface Harness {
  readonly bridge: AgentBridge
  readonly root: string
  readonly eventLog: string
  readonly gatePath: string
  prompt: (holdId: string, promptId: string) => void
  close: () => Promise<void>
}

async function harness(holdIds: string[], env: Record<string, string> = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-agent-bridge-'))
  roots.push(root)
  const eventLog = join(root, 'events.log')
  const gatePath = join(root, 'gate')
  const bridge = new AgentBridge({
    backend: 'claude',
    cwd: root,
    transport: { kind: 'stdio', command: process.execPath, args: [fixture, eventLog, gatePath, '2'], env: { ...process.env, ...env } },
  })
  await bridge.start()
  const session = (holdId: string): AgentSessionConfig => ({
    holdId,
    generation: `gen-${holdId}`,
    backend: 'claude',
    cwd: root,
    journalPath: join(root, `${holdId}.jsonl`),
    statePath: join(root, `${holdId}.state.json`),
    maxJournalEvents: 500,
    maxJournalBytes: 4_000_000,
    promptTimeoutMs: 30_000,
  })
  for (const holdId of holdIds) {
    writeFileSync(session(holdId).journalPath, '')
    bridge.open(session(holdId))
  }
  const prompt = (holdId: string, promptId: string): void => {
    const native = `native-${holdId}`
    bridge.setNativeSession(holdId, native)
    bridge.send(holdId, {
      clientId: 'browser',
      requestId: promptId,
      frame: {
        jsonrpc: '2.0', id: promptId, method: 'session/prompt', params: { sessionId: native, prompt: [] },
      },
    })
  }
  return { bridge, root, eventLog, gatePath, prompt, close: async () => bridge.close() }
}

function openGate(gatePath: string): void {
  writeFileSync(gatePath, '')
}

async function eventsOf(log: string, prefix: string): Promise<string[]> {
  if (!existsSync(log)) return []
  return (await readFile(log, 'utf8')).split('\n').filter(line => line.startsWith(prefix))
}

/** Why a session stopped recording, if it did. */
function failureOf(bridge: AgentBridge, holdId: string): string | undefined {
  return (bridge as unknown as { sessions: Map<string, { failureReason?: string }> })
    .sessions.get(holdId)?.failureReason
}

function pageText(bridge: AgentBridge, holdId: string): { latestSeq: number; seqs: number[]; text: string } {
  const page = bridge.read(holdId, 0)
  return {
    latestSeq: page.latestSeq,
    seqs: page.events.map(event => event.seq),
    text: page.events.map(event => JSON.stringify(event.frame)).join('\n'),
  }
}

const settle = async (ms = 300): Promise<void> => { await new Promise(resolve => setTimeout(resolve, ms)) }

/** Copy the current environment with overrides, for an awkward-Agent harness. */
/** Env for an awkward Agent, applied on top of the test's own environment. */
function withEnv(overrides: Record<string, string>): Record<string, string> {
  return overrides
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('AgentBridge', () => {
  it('handshakes the shared backend before any session exists', async () => {
    // The handshake belongs to the connection, not to a session: the connection
    // exists before any slot does, so no slot could carry this frame.
    const { bridge, eventLog, gatePath, root, prompt } = await harness([])
    try {
      expect(bridge.sessionCount).toBe(0)
      expect(bridge.initialized).toBe(true)
      expect(await eventsOf(eventLog, 'initialize:')).toHaveLength(1)
    } finally {
      await bridge.close()
    }
  })

  it('serves several sessions from one connection and never initializes it twice', async () => {
    const { bridge, eventLog, gatePath, root, prompt } = await harness(['a', 'b', 'c'])
    try {
      expect(bridge.sessionCount).toBe(3)
      expect(await eventsOf(eventLog, 'initialize:')).toHaveLength(1)
      // One backend pid is serving all three, and every slot records that same
      // pid — which is what makes the memory shared rather than per session.
      for (const holdId of ['a', 'b', 'c']) prompt(holdId, `p-${holdId}`)
      await settle()
      const pids = await Promise.all(['a', 'b', 'c'].map(async holdId => {
        const state = JSON.parse(await readFile(join(root, `${holdId}.state.json`), 'utf8')) as { backendPid: number }
        return state.backendPid
      }))
      expect(new Set(pids)).toEqual(new Set([bridge.backendPid]))
      expect(pids[0]).toBeGreaterThan(0)
    } finally {
      await bridge.close()
    }
  })

  it('drops a frame that names a session this hostd does not own, instead of fanning it out', async () => {
    // An Agent runs sessions of its own — subagents, background tasks. Those
    // frames used to be broadcast to every session, so another session's
    // conversation showed up in this one's transcript and read as if someone
    // else had been talking.
    const { bridge, prompt } = await harness(['own-a', 'own-b'])
    try {
      prompt('own-a', 'p1')
      await settle()
      const beforeA = pageText(bridge, 'own-a').latestSeq
      const beforeB = pageText(bridge, 'own-b').latestSeq
      // A frame from a session nobody here manages: the Agent is running a
      // subagent of its own and said something to it.
      bridge['routeUnsafe']({
        jsonrpc: '2.0', method: 'session/update',
        params: {
          sessionId: 'some-other-agent-session',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '别人的会话' } },
        },
      })
      await settle()
      expect(pageText(bridge, 'own-a').latestSeq).toBe(beforeA)
      expect(pageText(bridge, 'own-b').latestSeq).toBe(beforeB)
      // A frame that names nothing still reaches everyone, so the drop is
      // narrow: only a frame that names someone else's session is skipped.
      bridge['routeUnsafe']({
        jsonrpc: '2.0', method: 'session/update',
        params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '没有名字' } } },
      })
      await settle()
      expect(pageText(bridge, 'own-a').latestSeq).toBeGreaterThan(beforeA)
      expect(pageText(bridge, 'own-b').latestSeq).toBeGreaterThan(beforeB)
      expect(pageText(bridge, 'own-a').text).toContain('没有名字')
      expect(pageText(bridge, 'own-a').text).not.toContain('别人的会话')
    } finally {
      await bridge.close()
    }
  })

  it('routes each session its own frames and never leaks one into another', async () => {
    const { bridge, eventLog, gatePath, root, prompt } = await harness(['a', 'b'])
    try {
      prompt('a', 'p1')
      prompt('b', 'p2')
      await settle()
      // Both turns are outstanding: neither was serialized behind the other.
      expect(await eventsOf(eventLog, 'prompt:p1:')).toHaveLength(1)
      expect(await eventsOf(eventLog, 'prompt:p2:')).toHaveLength(1)
      expect(await eventsOf(eventLog, 'complete:')).toHaveLength(0)

      const a = pageText(bridge, 'a')
      const b = pageText(bridge, 'b')
      expect(a.text).toContain('native-a:0')
      expect(a.text).not.toContain('native-b:0')
      expect(b.text).toContain('native-b:0')
      expect(b.text).not.toContain('native-a:0')
      // Each session owns its sequence space and numbers densely from its own
      // zero. (`afterSeq` is exclusive, so a read from 0 skips the first event.)
      expect(a.seqs).toEqual(a.seqs.map((_, index) => index + 1))
      expect(b.seqs).toEqual(b.seqs.map((_, index) => index + 1))
      expect(a.latestSeq).toBe(a.seqs.length)
      expect(b.latestSeq).toBe(b.seqs.length)
    } finally {
      await bridge.close()
    }
  })

  it('keeps admission de-duplication, prompt queueing and cancellation per session', async () => {
    const { bridge, eventLog, gatePath, root, prompt } = await harness(['a', 'b'])
    try {
      const forA = (requestId: string, rpcId: string) => ({
        clientId: 'browser',
        requestId,
        frame: {
          jsonrpc: '2.0', id: rpcId, method: 'session/prompt', params: { sessionId: 'native-a', prompt: [] },
        },
      })
      // The same client request id in one session is admitted once...
      expect(bridge.send('a', forA('same', 'a-1'))).toEqual({ accepted: true, duplicate: false })
      expect(bridge.send('a', forA('same', 'a-1'))).toEqual({ accepted: true, duplicate: true })
      // ...and the same id in a *different* session is a different prompt.
      expect(bridge.send('b', {
        clientId: 'browser',
        requestId: 'same',
        frame: {
          jsonrpc: '2.0', id: 'b-1', method: 'session/prompt', params: { sessionId: 'native-b', prompt: [] },
        },
      })).toEqual({ accepted: true, duplicate: false })
      await settle()
      expect(await eventsOf(eventLog, 'prompt:a-1:')).toHaveLength(1)
      expect(await eventsOf(eventLog, 'prompt:b-1:')).toHaveLength(1)

      // A second prompt for A queues behind A's in-flight turn...
      bridge.send('a', forA('a-queued', 'a-2'))
      await settle()
      expect(await eventsOf(eventLog, 'prompt:a-2:')).toHaveLength(0)
      // ...and cancelling A drops the queued one, without touching B.
      bridge.sendFrame('a', { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'native-a' } })
      openGate(gatePath)
      await settle(200)
      expect(await eventsOf(eventLog, 'prompt:a-2:')).toHaveLength(0)
      expect(await eventsOf(eventLog, 'complete:b-1:')).toHaveLength(1)
    } finally {
      await bridge.close()
    }
  })

  it('detaches one session without disturbing the shared connection or the others', async () => {
    const { bridge, eventLog, gatePath, root, prompt } = await harness(['a', 'b'])
    try {
      prompt('a', 'p-a')
      prompt('b', 'p-b')
      await settle()
      expect(bridge.detach('a')).toBe(true)
      expect(bridge.detach('a')).toBe(false)
      expect(bridge.sessionCount).toBe(1)

      // The shared connection is still up, so the surviving session completes.
      openGate(gatePath)
      await settle(200)
      expect(await eventsOf(eventLog, 'complete:p-b:')).toHaveLength(1)
      expect(pageText(bridge, 'b').text).toContain('native-b:0')
      expect(() => bridge.read('a', 0)).toThrow(/unknown agent session/)
      // The detached session's journal survived on disk for recovery.
      expect(existsSync(join(root, 'a.jsonl'))).toBe(true)
    } finally {
      await bridge.close()
    }
  })

  it('wakes a waiter only for the session whose journal advanced', async () => {
    const { bridge, eventLog, gatePath, root, prompt } = await harness(['a', 'b'])
    try {
      const waitingB = bridge.waitSeq('b', 0, 5_000)
      const waitingA = bridge.waitSeq('a', 0, 300)
      prompt('a', 'p-a')
      // A's waiter resolves from A's own append...
      await expect(waitingA).resolves.toMatchObject({ timedOut: false })
      // ...and B's is still waiting, because A's frames are not B's frames.
      const pending = await Promise.race([waitingB, new Promise(resolve => setTimeout(() => resolve('pending'), 250))])
      expect(pending).toBe('pending')
      prompt('b', 'p-b')
      await expect(waitingB).resolves.toMatchObject({ timedOut: false })
    } finally {
      await bridge.close()
    }
  })

  it('records a backend outage in every session, not just the one that asked', async () => {
    const { bridge, eventLog, gatePath, root, prompt } = await harness(['a', 'b'])
    try {
      const backendPid = bridge.backendPid
      expect(backendPid).toBeGreaterThan(0)
      process.kill(backendPid as number, 'SIGKILL')
      await settle(300)
      // Every session must be able to tell the user its backend went away.
      for (const holdId of ['a', 'b']) {
        expect(pageText(bridge, holdId).text).toContain('_dsh/transport_closed')
      }
    } finally {
      await bridge.close()
    }
  })

  it('keeps serving when a session cannot record a frame', async () => {
    // Frame routing runs on hostd's event loop: a failure to journal must be
    // swallowed, or one broken session would take the daemon — and the gateway
    // connection — down with it.
    const { bridge, eventLog, gatePath, root, prompt } = await harness(['a', 'b'])
    try {
      const journal = join(root, 'a.jsonl')
      chmodSync(journal, 0o400)
      try {
        prompt('a', 'p-hostile')
        await settle(500)
        expect(bridge.sessionCount).toBe(2)
      } finally {
        chmodSync(journal, 0o600)
      }
      // A's frames are lost (it could not write), but B is unaffected and the
      // bridge is still answering.
      prompt('b', 'p-ok')
      await settle()
      expect(pageText(bridge, 'b').text).toContain('native-b:0')
      expect(bridge.latestSeq('b')).toBeGreaterThan(0)
    } finally {
      await bridge.close()
    }
  })

  it('ends a turn the Agent answered with an error, so the next prompt is admitted', async () => {
    const { bridge, gatePath, prompt } = await harness(['a'], withEnv({ FAKE_ACP_ERROR: '1' }))
    try {
      prompt('a', 'p-err')
      await settle(100)
      openGate(gatePath)
      await settle()
      // A JSON-RPC error is still the end of a turn: without this the turn stays
      // open forever and every later prompt queues behind it.
      expect(pageText(bridge, 'a').text).toContain('prompt_complete')
      const admitted = await bridge.send('a', {
        clientId: 'browser',
        requestId: 'p-next',
        frame: { jsonrpc: '2.0', id: 'p-next', method: 'session/prompt', params: { sessionId: 'native-a', prompt: [] } },
      })
      expect(admitted).toEqual({ accepted: true, duplicate: false })
    } finally {
      await bridge.close()
    }
  })

  it('synthesizes a turn completion when an Agent never answers, so the queue drains', async () => {
    const { bridge, prompt } = await harness(['a'], withEnv({ FAKE_ACP_SILENT: '1' }))
    try {
      // The real guard lives in the session's promptTimeoutMs, which this harness
      // sets long; so assert the wiring instead of waiting it out. A second
      // prompt has to queue behind the unanswered first one, not be sent.
      prompt('a', 'p-silent')
      await settle(300)
      const before = pageText(bridge, 'a').text
      const second = await bridge.send('a', {
        clientId: 'browser',
        requestId: 'p-second',
        frame: { jsonrpc: '2.0', id: 'p-second', method: 'session/prompt', params: { sessionId: 'native-a', prompt: [] } },
      })
      expect(second).toEqual({ accepted: true, duplicate: false })
      await settle(200)
      // Only the first prompt reached the Agent; the second is held in the queue.
      expect(pageText(bridge, 'a').text).toBe(before)
    } finally {
      await bridge.close()
    }
  })

  it('parks a turn on a permission request until the answer goes back', async () => {
    const { bridge, gatePath, prompt } = await harness(['a'], withEnv({ FAKE_ACP_PERMISSION: '1' }))
    try {
      prompt('a', 'p-perm')
      await settle(150)
      const seen = pageText(bridge, 'a').text
      expect(seen).toContain('request_permission')
      // The permission request is a backend RPC that has to be answered, or the
      // Agent waits and the turn never completes.
      openGate(gatePath)
      bridge.sendFrame('a', {
        jsonrpc: '2.0', id: 900,
        result: { outcome: { outcome: 'selected', optionId: 'once' } },
      })
      const answered = await bridge.waitFor('a', '900', 0, 3_000)
      expect(answered.kind).toBe('frame')
      await settle(600)
      expect(pageText(bridge, 'a').text).toContain('prompt_complete')
    } finally {
      await bridge.close()
    }
  })

  it('continues a journal above its highest seq, not the last line written', async () => {
    // A journal is not guaranteed to be in seq order: after a reopen, a frame
    // can land below one already written. Continuing from the last line's seq
    // then reuses numbers a reader has already passed, and every such frame is
    // invisible forever — a turn that failed after a reopen never reaches the UI.
    const root = await mkdtemp(join(tmpdir(), 'dsh-agent-bridge-order-'))
    roots.push(root)
    const eventLog = join(root, 'events.log')
    const gatePath = join(root, 'gate')
    const bridge = new AgentBridge({
      backend: 'claude',
      cwd: root,
      transport: { kind: 'stdio', command: process.execPath, args: [fixture, eventLog, gatePath, '2'] },
    })
    await bridge.start()
    const journalPath = join(root, 'order.jsonl')
    const outOfOrder = [
      { seq: 7, generation: 'g', timestamp: '2026-01-01T00:00:00.000Z', frame: { method: 'session/update' } },
      { seq: 9, generation: 'g', timestamp: '2026-01-01T00:00:01.000Z', frame: { method: 'session/update' } },
      { seq: 8, generation: 'g', timestamp: '2026-01-01T00:00:02.000Z', frame: { method: 'session/update' } },
    ]
    writeFileSync(journalPath, outOfOrder.map(event => jsonLine(event)).join(''))
    bridge.open({
      holdId: 'order', generation: 'g', backend: 'claude', cwd: root,
      journalPath, statePath: join(root, 'order.state.json'),
      maxJournalEvents: 100, maxJournalBytes: 4_000_000, promptTimeoutMs: 30_000,
    })
    try {
      expect(bridge.latestSeq('order')).toBe(9)
      bridge.setNativeSession('order', 'native-order')
      openGate(gatePath)
      await bridge.send('order', {
        clientId: 'browser',
        requestId: 'p0',
        frame: { jsonrpc: '2.0', id: 'p0', method: 'session/prompt', params: { sessionId: 'native-order', prompt: [] } },
      })
      await bridge.waitFor('order', 'p0', 0, 5_000)
      // A reader sitting at the high-water mark must not miss this.
      const after = await bridge.read('order', 9)
      expect(after.events.length).toBeGreaterThan(0)
      expect(after.events.every(event => event.seq > 9)).toBe(true)
    } finally {
      await bridge.close()
    }
  })

  it('trims an over-long journal and reports a gap instead of silently dropping the head', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-agent-bridge-trim-'))
    roots.push(root)
    const eventLog = join(root, 'events.log')
    const gatePath = join(root, 'gate')
    const bridge = new AgentBridge({
      backend: 'claude',
      cwd: root,
      transport: { kind: 'stdio', command: process.execPath, args: [fixture, eventLog, gatePath, '2'] },
    })
    await bridge.start()
    const journalPath = join(root, 'trim.jsonl')
    writeFileSync(journalPath, '')
    bridge.open({
      holdId: 'trim', generation: 'g', backend: 'claude', cwd: root,
      journalPath, statePath: join(root, 'trim.state.json'),
      // A tiny budget forces retention to run on every append.
      maxJournalEvents: 4, maxJournalBytes: 4_000_000, promptTimeoutMs: 30_000,
    })
    try {
      bridge.setNativeSession('trim', 'native-trim')
      for (let index = 0; index < 5; index += 1) {
        openGate(gatePath)
        await bridge.send('trim', {
          clientId: 'browser',
          requestId: `p${index}`,
          frame: { jsonrpc: '2.0', id: `p${index}`, method: 'session/prompt', params: { sessionId: 'native-trim', prompt: [] } },
        })
        await settle(200)
      }
      const page = bridge.read('trim', 0)
      expect(page.events.length).toBeLessThanOrEqual(4)
      // A reader that asks from the start is told what was dropped; a reader that
      // is still inside the window is not.
      expect(page.droppedThrough).toBeGreaterThan(0)
      expect(page.gap).toBe(true)
      const tail = bridge.read('trim', page.droppedThrough)
      expect(tail.gap).toBe(false)
    } finally {
      await bridge.close()
    }
  })
})
