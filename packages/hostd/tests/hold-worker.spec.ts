import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HoldRequest, HoldResponse, HoldWorkerConfig } from '../src/hold-protocol.ts'
import { HoldWorker, parseConfig } from '../src/hold-worker.ts'

const roots: string[] = []

function admission(requestId: string): HoldRequest {
  return {
    operation: 'send', admission: {
      clientId: 'browser', requestId,
      frame: { jsonrpc: '2.0', id: requestId, method: 'session/prompt', params: { sessionId: 'native', prompt: [] } },
    },
  }
}

async function send(path: string, request: HoldRequest): Promise<HoldResponse> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(path)
    let text = ''
    socket.setEncoding('utf8')
    socket.once('connect', () => { socket.write(`${JSON.stringify(request)}\n`) })
    socket.on('data', (chunk: string) => { text += chunk })
    socket.once('error', reject)
    socket.once('end', () => { resolve(JSON.parse(text) as HoldResponse) })
  })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('HoldWorker', () => {
  it('deduplicates admissions and serializes ACP prompts within one hold', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-hold-worker-'))
    roots.push(root)
    const socketPath = join(root, 'control.sock')
    const output = join(root, 'requests.txt')
    const gate = join(root, 'gate')
    const config: HoldWorkerConfig = {
      version: 1,
      holdId: 'hold',
      generation: 'generation',
      backend: 'codex',
      cwd: root,
      socketPath,
      journalPath: join(root, 'journal.jsonl'),
      statePath: join(root, 'state.json'),
      maxJournalEvents: 20,
      maxJournalBytes: 100_000,
      transport: {
        kind: 'stdio', command: process.execPath,
        args: [new URL('./fixtures/fake-acp.mjs', import.meta.url).pathname, output, gate],
      },
    }
    const worker = new HoldWorker(config)
    await worker.start()
    try {
      expect(await send(socketPath, admission('p1'))).toMatchObject({ ok: true, result: { duplicate: false } })
      expect(await send(socketPath, admission('p1'))).toMatchObject({ ok: true, result: { duplicate: true } })
      expect(await send(socketPath, admission('p2'))).toMatchObject({ ok: true, result: { duplicate: false } })
      await vi.waitFor(async () => { expect(await readFile(output, 'utf8')).toBe('p1\n') })
      await writeFile(gate, 'go')
      await vi.waitFor(async () => { expect(await readFile(output, 'utf8')).toBe('p1\np2\n') })
      const page = await send(socketPath, { operation: 'read', afterSeq: 0, generation: 'generation' })
      if (!page.ok) throw new Error(page.error)
      const result = page.result as { events: readonly { frame: unknown }[] }
      expect(result.events.filter(event => event.frame !== null && typeof event.frame === 'object'
        && !Array.isArray(event.frame) && Reflect.get(event.frame, 'method') === '_x.ai/session/prompt_complete'))
        .toHaveLength(2)
    } finally {
      await worker.close()
    }
  })

  it('wakes wait-seq as soon as a new journal event is flushed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-hold-wait-seq-'))
    roots.push(root)
    const socketPath = join(root, 'control.sock')
    const config: HoldWorkerConfig = {
      version: 1,
      holdId: 'hold',
      generation: 'generation',
      backend: 'codex',
      cwd: root,
      socketPath,
      journalPath: join(root, 'journal.jsonl'),
      statePath: join(root, 'state.json'),
      maxJournalEvents: 20,
      maxJournalBytes: 100_000,
      transport: {
        kind: 'stdio', command: process.execPath,
        args: [new URL('./fixtures/fake-acp.mjs', import.meta.url).pathname, join(root, 'requests.txt'), join(root, 'gate')],
      },
    }
    const worker = new HoldWorker(config)
    await worker.start()
    try {
      await writeFile(join(root, 'gate'), 'go')
      const waiting = send(socketPath, { operation: 'wait-seq', afterSeq: 0, timeoutMs: 2000 })
      await send(socketPath, admission('wake'))
      const woken = await waiting
      expect(woken).toMatchObject({ ok: true, result: { timedOut: false } })
    } finally {
      await worker.close()
    }
  })

  it('does not rewind the journal when afterSeq is ahead of the latest seq', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-hold-ahead-seq-'))
    roots.push(root)
    const socketPath = join(root, 'control.sock')
    const gate = join(root, 'gate')
    const config: HoldWorkerConfig = {
      version: 1,
      holdId: 'hold',
      generation: 'generation',
      backend: 'codex',
      cwd: root,
      socketPath,
      journalPath: join(root, 'journal.jsonl'),
      statePath: join(root, 'state.json'),
      maxJournalEvents: 20,
      maxJournalBytes: 100_000,
      transport: {
        kind: 'stdio', command: process.execPath,
        args: [new URL('./fixtures/fake-acp.mjs', import.meta.url).pathname, join(root, 'requests.txt'), gate],
      },
    }
    const worker = new HoldWorker(config)
    await worker.start()
    try {
      await writeFile(gate, 'go')
      expect(await send(socketPath, admission('ahead'))).toMatchObject({ ok: true, result: { duplicate: false } })
      await vi.waitFor(async () => {
        const page = await send(socketPath, { operation: 'read', afterSeq: 0, generation: 'generation' })
        if (!page.ok) throw new Error(page.error)
        expect((page.result as { latestSeq: number }).latestSeq).toBeGreaterThan(0)
      })
      const ahead = await send(socketPath, { operation: 'read', afterSeq: 999_999, generation: 'generation' })
      expect(ahead).toMatchObject({ ok: true, result: { gap: false, events: [] } })
    } finally {
      await worker.close()
    }
  })

  it('returns a journal page as soon as wait-page observes a new event', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-hold-wait-page-'))
    roots.push(root)
    const socketPath = join(root, 'control.sock')
    const config: HoldWorkerConfig = {
      version: 1,
      holdId: 'hold',
      generation: 'generation',
      backend: 'codex',
      cwd: root,
      socketPath,
      journalPath: join(root, 'journal.jsonl'),
      statePath: join(root, 'state.json'),
      maxJournalEvents: 20,
      maxJournalBytes: 100_000,
      transport: {
        kind: 'stdio', command: process.execPath,
        args: [new URL('./fixtures/fake-acp.mjs', import.meta.url).pathname, join(root, 'requests.txt'), join(root, 'gate')],
      },
    }
    const worker = new HoldWorker(config)
    await worker.start()
    try {
      await writeFile(join(root, 'gate'), 'go')
      const waiting = send(socketPath, {
        operation: 'wait-page',
        afterSeq: 0,
        generation: 'generation',
        timeoutMs: 2000,
      })
      await send(socketPath, admission('wake'))
      const woken = await waiting
      expect(woken.ok).toBe(true)
      if (!woken.ok) throw new Error(woken.error)
      const page = woken.result as { events: readonly unknown[] }
      expect(page.events.length).toBeGreaterThan(0)
    } finally {
      await worker.close()
    }
  })

  it('appends journal lines and compacts the file after retention trims old events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-hold-compact-'))
    roots.push(root)
    const socketPath = join(root, 'control.sock')
    const journalPath = join(root, 'journal.jsonl')
    const gate = join(root, 'gate')
    await writeFile(gate, 'go')
    const config: HoldWorkerConfig = {
      version: 1,
      holdId: 'hold',
      generation: 'generation',
      backend: 'codex',
      cwd: root,
      socketPath,
      journalPath,
      statePath: join(root, 'state.json'),
      maxJournalEvents: 3,
      maxJournalBytes: 100_000,
      transport: {
        kind: 'stdio', command: process.execPath,
        args: [new URL('./fixtures/fake-acp.mjs', import.meta.url).pathname, join(root, 'requests.txt'), gate],
      },
    }
    const worker = new HoldWorker(config)
    await worker.start()
    try {
      await send(socketPath, admission('p1'))
      await send(socketPath, admission('p2'))
      await send(socketPath, admission('p3'))
      await vi.waitFor(async () => {
        const page = await send(socketPath, { operation: 'read', afterSeq: 0, generation: 'generation' })
        if (!page.ok) throw new Error(page.error)
        expect((page.result as { latestSeq: number }).latestSeq).toBeGreaterThanOrEqual(6)
      })
      const events = (await readFile(journalPath, 'utf8'))
        .split('\n')
        .filter(line => line !== '')
        .map(line => JSON.parse(line) as { seq: number })
      expect(events.map(event => event.seq)).toHaveLength(3)
      expect(events[0]?.seq).toBeGreaterThan(3)
    } finally {
      await worker.close()
    }
  })

  it.each(['grok', 'dsh'] as const)('synthesizes a turn-completion frame from the %s JSON-RPC response so the next prompt is admitted', async (backend) => {
    const root = await mkdtemp(join(tmpdir(), `dsh-hold-${backend}-`))
    roots.push(root)
    const socketPath = join(root, 'control.sock')
    const output = join(root, 'requests.txt')
    const gate = join(root, 'gate')
    const config: HoldWorkerConfig = {
      version: 1,
      holdId: 'hold',
      generation: 'generation',
      backend,
      cwd: root,
      socketPath,
      journalPath: join(root, 'journal.jsonl'),
      statePath: join(root, 'state.json'),
      maxJournalEvents: 20,
      maxJournalBytes: 100_000,
      transport: {
        kind: 'stdio', command: process.execPath,
        args: [new URL('./fixtures/fake-acp.mjs', import.meta.url).pathname, output, gate, backend],
      },
    }
    const worker = new HoldWorker(config)
    await worker.start()
    try {
      await send(socketPath, admission('p1'))
      await send(socketPath, admission('p2'))
      // The fake ACP backend returns the JSON-RPC response immediately; once the
      // hold worker sees the response, it synthesizes a completion frame and the
      // queued p2 admission runs without waiting for the native notification.
      await vi.waitFor(async () => { expect(await readFile(output, 'utf8')).toBe('p1\np2\n') })
      await writeFile(gate, 'go')
      const page = await send(socketPath, { operation: 'read', afterSeq: 0, generation: 'generation' })
      if (!page.ok) throw new Error(page.error)
      const frames = (page.result as { events: readonly { frame: unknown }[] }).events
        .map(event => event.frame)
        .filter((frame): frame is Record<PropertyKey, unknown> => frame !== null && typeof frame === 'object' && !Array.isArray(frame))
      const completion = backend === 'grok'
        ? frames.filter(frame => Reflect.get(frame, 'method') === '_x.ai/session/prompt_complete')
        : frames.filter(frame => {
            const method = Reflect.get(frame, 'method')
            if (method !== 'session.event') return false
            const params = Reflect.get(frame, 'params')
            if (params === null || typeof params !== 'object') return false
            const event = Reflect.get(params, 'event')
            return event !== null && typeof event === 'object' && Reflect.get(event, 'type') === 'turn/end'
          })
      expect(completion).toHaveLength(2)
    } finally {
      await worker.close()
    }
  })

  it('session/cancel drops a queued prompt so the next admission can run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-hold-cancel-queue-'))
    roots.push(root)
    const socketPath = join(root, 'control.sock')
    const output = join(root, 'requests.txt')
    const gate = join(root, 'gate')
    const config: HoldWorkerConfig = {
      version: 1,
      holdId: 'hold',
      generation: 'generation',
      backend: 'claude',
      cwd: root,
      socketPath,
      journalPath: join(root, 'journal.jsonl'),
      statePath: join(root, 'state.json'),
      maxJournalEvents: 20,
      maxJournalBytes: 100_000,
      transport: {
        kind: 'stdio', command: process.execPath,
        args: [new URL('./fixtures/fake-acp.mjs', import.meta.url).pathname, output, gate],
      },
    }
    const worker = new HoldWorker(config)
    await worker.start()
    try {
      expect(await send(socketPath, admission('p1'))).toMatchObject({ ok: true, result: { duplicate: false } })
      await vi.waitFor(async () => { expect(await readFile(output, 'utf8')).toBe('p1\n') })
      expect(await send(socketPath, admission('p2'))).toMatchObject({ ok: true, result: { duplicate: false } })
      expect(await readFile(output, 'utf8')).toBe('p1\n')
      expect(await send(socketPath, {
        operation: 'send-frame',
        frame: { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'native' } },
      })).toMatchObject({ ok: true })
      expect(await send(socketPath, admission('p3'))).toMatchObject({ ok: true, result: { duplicate: false } })
      await vi.waitFor(async () => { expect(await readFile(output, 'utf8')).toBe('p1\np3\n') })
    } finally {
      await worker.close()
    }
  })

  it('restarts a DSH stdio backend on session/cancel because the SDK wire has no cancel', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-hold-dsh-cancel-'))
    roots.push(root)
    const socketPath = join(root, 'control.sock')
    const pidFile = join(root, 'pid')
    const output = join(root, 'requests.txt')
    const config: HoldWorkerConfig = {
      version: 1,
      holdId: 'hold',
      generation: 'generation',
      backend: 'dsh',
      cwd: root,
      socketPath,
      journalPath: join(root, 'journal.jsonl'),
      statePath: join(root, 'state.json'),
      maxJournalEvents: 20,
      maxJournalBytes: 100_000,
      transport: {
        kind: 'stdio', command: process.execPath,
        args: [new URL('./fixtures/fake-dsh.mjs', import.meta.url).pathname, pidFile, output],
      },
    }
    const worker = new HoldWorker(config)
    await worker.start()
    try {
      expect(await send(socketPath, {
        operation: 'send-frame',
        frame: {
          jsonrpc: '2.0', id: 'init-1', method: 'initialize',
          params: { cwd: root, provider: 'deepseek-official', model: 'deepseek-official' },
        },
      })).toMatchObject({ ok: true })
      expect(await send(socketPath, {
        operation: 'wait', rpcId: 'init-1', afterSeq: 0, timeoutMs: 2_000,
      })).toMatchObject({ ok: true })
      await vi.waitFor(async () => { expect((await readFile(pidFile, 'utf8')).trim()).toMatch(/^\d+$/) })
      const firstPid = (await readFile(pidFile, 'utf8')).trim()
      expect(await send(socketPath, admission('p1'))).toMatchObject({ ok: true, result: { duplicate: false } })
      await vi.waitFor(async () => {
        expect(await readFile(output, 'utf8')).toContain(`prompt:p1:${firstPid}`)
      })
      expect(await send(socketPath, {
        operation: 'send-frame',
        frame: { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'native' } },
      })).toMatchObject({ ok: true })
      await vi.waitFor(async () => {
        expect((await readFile(pidFile, 'utf8')).trim()).not.toBe(firstPid)
      })
      const secondPid = (await readFile(pidFile, 'utf8')).trim()
      expect(await send(socketPath, admission('p2'))).toMatchObject({ ok: true, result: { duplicate: false } })
      await vi.waitFor(async () => {
        expect(await readFile(output, 'utf8')).toContain(`prompt:p2:${secondPid}`)
      })
      expect(await readFile(output, 'utf8')).not.toContain(`cancel-ignored:${firstPid}`)
    } finally {
      await worker.close()
    }
  })

  it('synthesizes prompt_complete for Claude ACP prompt results', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-hold-claude-complete-'))
    roots.push(root)
    const socketPath = join(root, 'control.sock')
    const output = join(root, 'requests.txt')
    const gate = join(root, 'gate')
    const config: HoldWorkerConfig = {
      version: 1,
      holdId: 'hold',
      generation: 'generation',
      backend: 'claude',
      cwd: root,
      socketPath,
      journalPath: join(root, 'journal.jsonl'),
      statePath: join(root, 'state.json'),
      maxJournalEvents: 20,
      maxJournalBytes: 100_000,
      transport: {
        kind: 'stdio', command: process.execPath,
        args: [new URL('./fixtures/fake-acp.mjs', import.meta.url).pathname, output, gate],
      },
    }
    const worker = new HoldWorker(config)
    await worker.start()
    try {
      await writeFile(gate, 'go')
      expect(await send(socketPath, admission('claude-1'))).toMatchObject({ ok: true, result: { duplicate: false } })
      await vi.waitFor(async () => {
        const page = await send(socketPath, { operation: 'read', afterSeq: 0, generation: 'generation' })
        if (!page.ok) throw new Error(page.error)
        const complete = (page.result as { events: readonly { frame: Record<string, unknown> }[] }).events
          .filter(event => event.frame !== null && typeof event.frame === 'object'
            && Reflect.get(event.frame, 'method') === '_x.ai/session/prompt_complete')
        expect(complete).toHaveLength(1)
      })
    } finally {
      await worker.close()
    }
  })

  it('merges consecutive thought chunks across the idle flush window', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-hold-coalesce-'))
    roots.push(root)
    const socketPath = join(root, 'control.sock')
    const config: HoldWorkerConfig = {
      version: 1,
      holdId: 'hold',
      generation: 'generation',
      backend: 'claude',
      cwd: root,
      socketPath,
      journalPath: join(root, 'journal.jsonl'),
      statePath: join(root, 'state.json'),
      maxJournalEvents: 20,
      maxJournalBytes: 100_000,
      transport: {
        kind: 'stdio', command: process.execPath,
        args: [new URL('./fixtures/fake-acp-thoughts.mjs', import.meta.url).pathname],
      },
    }
    const worker = new HoldWorker(config)
    await worker.start()
    try {
      expect(await send(socketPath, admission('think'))).toMatchObject({ ok: true, result: { duplicate: false } })
      await vi.waitFor(async () => {
        const page = await send(socketPath, { operation: 'read', afterSeq: 0, generation: 'generation' })
        if (!page.ok) throw new Error(page.error)
        const thoughts = (page.result as { events: readonly { frame: Record<string, unknown> }[] }).events.filter((event) => {
          const frame = event.frame
          if (frame === null || typeof frame !== 'object') return false
          const params = Reflect.get(frame, 'params')
          if (params === null || typeof params !== 'object') return false
          const update = Reflect.get(params, 'update')
          if (update === null || typeof update !== 'object') return false
          return Reflect.get(update, 'sessionUpdate') === 'agent_thought_chunk'
        })
        expect(thoughts).toHaveLength(1)
        const update = Reflect.get(Reflect.get(thoughts[0]!.frame, 'params') as object, 'update') as { content: { text: string } }
        expect(update.content.text).toBe('The user wants to add outline')
      }, { timeout: 1000, interval: 20 })
    } finally {
      await worker.close()
    }
  })

  it('exports DSH_SESSION_ROOT into the stdio child env when sessionRoot is configured', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-hold-session-root-'))
    roots.push(root)
    const socketPath = join(root, 'control.sock')
    const snapshot = join(root, 'env.txt')
    const sessionRoot = join(root, 'dsh-sessions')
    const config: HoldWorkerConfig = {
      version: 1,
      holdId: 'hold',
      generation: 'generation',
      backend: 'dsh',
      cwd: root,
      socketPath,
      journalPath: join(root, 'journal.jsonl'),
      statePath: join(root, 'state.json'),
      maxJournalEvents: 20,
      maxJournalBytes: 100_000,
      sessionRoot,
      transport: {
        kind: 'stdio', command: process.execPath,
        args: [new URL('./fixtures/fake-env-snapshot.mjs', import.meta.url).pathname, snapshot],
      },
    }
    const worker = new HoldWorker(config)
    await worker.start()
    try {
      await vi.waitFor(async () => { expect((await readFile(snapshot, 'utf8')).trim()).toBe(sessionRoot) })
    } finally {
      await worker.close()
    }
  })

  it('leaves DSH_SESSION_ROOT unset when the config does not provide one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-hold-no-session-root-'))
    roots.push(root)
    const socketPath = join(root, 'control.sock')
    const snapshot = join(root, 'env.txt')
    const config: HoldWorkerConfig = {
      version: 1,
      holdId: 'hold',
      generation: 'generation',
      backend: 'codex',
      cwd: root,
      socketPath,
      journalPath: join(root, 'journal.jsonl'),
      statePath: join(root, 'state.json'),
      maxJournalEvents: 20,
      maxJournalBytes: 100_000,
      transport: {
        kind: 'stdio', command: process.execPath,
        args: [new URL('./fixtures/fake-env-snapshot.mjs', import.meta.url).pathname, snapshot],
      },
    }
    const worker = new HoldWorker(config)
    await worker.start()
    try {
      await vi.waitFor(async () => { expect((await readFile(snapshot, 'utf8')).trim()).toBe('') })
    } finally {
      await worker.close()
    }
  })
})

describe('parseConfig', () => {
  it('preserves the websocket secret written by hostd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-hold-parse-'))
    roots.push(root)
    const configPath = join(root, 'config.json')
    await writeFile(configPath, JSON.stringify({
      version: 1,
      holdId: 'hold',
      generation: 'gen',
      backend: 'grok',
      cwd: root,
      socketPath: join(root, 'control.sock'),
      journalPath: join(root, 'journal.jsonl'),
      statePath: join(root, 'state.json'),
      maxJournalEvents: 10,
      maxJournalBytes: 1024,
      transport: {
        kind: 'websocket',
        url: 'ws://127.0.0.1:1/ws',
        secret: 'grok-secret-from-config',
      },
    }))
    const parsed = parseConfig(configPath)
    if (parsed.transport.kind !== 'websocket') throw new Error('expected websocket transport')
    expect(parsed.transport.secret).toBe('grok-secret-from-config')
    expect(parsed.transport.url).toBe('ws://127.0.0.1:1/ws')
  })

  it('omits the websocket secret when hostd did not write one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-hold-parse-'))
    roots.push(root)
    const configPath = join(root, 'config.json')
    await writeFile(configPath, JSON.stringify({
      version: 1,
      holdId: 'hold',
      generation: 'gen',
      backend: 'grok',
      cwd: root,
      socketPath: join(root, 'control.sock'),
      journalPath: join(root, 'journal.jsonl'),
      statePath: join(root, 'state.json'),
      maxJournalEvents: 10,
      maxJournalBytes: 1024,
      transport: { kind: 'websocket', url: 'ws://127.0.0.1:1/ws' },
    }))
    const parsed = parseConfig(configPath)
    if (parsed.transport.kind !== 'websocket') throw new Error('expected websocket transport')
    expect(parsed.transport.secret).toBeUndefined()
  })

  it('preserves an explicit sessionRoot for stdio dsh backends', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-hold-parse-session-root-'))
    roots.push(root)
    const configPath = join(root, 'config.json')
    await writeFile(configPath, JSON.stringify({
      version: 1,
      holdId: 'hold',
      generation: 'gen',
      backend: 'dsh',
      cwd: root,
      socketPath: join(root, 'control.sock'),
      journalPath: join(root, 'journal.jsonl'),
      statePath: join(root, 'state.json'),
      maxJournalEvents: 10,
      maxJournalBytes: 1024,
      sessionRoot: join(root, 'dsh-sessions'),
      transport: { kind: 'stdio', command: 'echo', args: [] },
    }))
    const parsed = parseConfig(configPath)
    expect(parsed.sessionRoot).toBe(join(root, 'dsh-sessions'))
  })

  it('omits sessionRoot when the field is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-hold-parse-no-session-root-'))
    roots.push(root)
    const configPath = join(root, 'config.json')
    await writeFile(configPath, JSON.stringify({
      version: 1,
      holdId: 'hold',
      generation: 'gen',
      backend: 'codex',
      cwd: root,
      socketPath: join(root, 'control.sock'),
      journalPath: join(root, 'journal.jsonl'),
      statePath: join(root, 'state.json'),
      maxJournalEvents: 10,
      maxJournalBytes: 1024,
      transport: { kind: 'stdio', command: 'echo', args: [] },
    }))
    const parsed = parseConfig(configPath)
    expect(parsed.sessionRoot).toBeUndefined()
  })
})
