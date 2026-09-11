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
      promptTimeoutMs: 60_000,
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

  it('dumps verbatim native frames when THREADHARBOR_FRAME_LOG is enabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-hold-frame-log-'))
    roots.push(root)
    const previousLog = process.env['THREADHARBOR_FRAME_LOG']
    const previousLogMax = process.env['THREADHARBOR_FRAME_LOG_MAX']
    process.env['THREADHARBOR_FRAME_LOG'] = '1'
    process.env['THREADHARBOR_FRAME_LOG_MAX'] = '4096'
    const lines: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      if (text.includes('frame-in') || text.includes('frame-out')) lines.push(text)
      return true
    }) as typeof process.stderr.write)
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
      promptTimeoutMs: 60_000,
      transport: {
        kind: 'stdio', command: process.execPath,
        args: [new URL('./fixtures/fake-acp-thoughts.mjs', import.meta.url).pathname],
      },
    }
    const worker = new HoldWorker(config)
    await worker.start()
    try {
      expect(await send(socketPath, admission('probe'))).toMatchObject({ ok: true, result: { duplicate: false } })
      await vi.waitFor(() => {
        expect(lines.some(line => line.includes('frame-out') && line.includes('method=session/prompt'))).toBe(true)
      })
      await vi.waitFor(() => {
        expect(lines.some(line => line.includes('frame-in') && line.includes('agent_thought_chunk'))).toBe(true)
      })
      // Verbatim pre-coalesce dump: every streamed delta keeps its own text.
      expect(lines.some(line => line.includes('frame-in') && line.includes('The '))).toBe(true)
    } finally {
      await worker.close()
      spy.mockRestore()
      if (previousLog === undefined) delete process.env['THREADHARBOR_FRAME_LOG']
      else process.env['THREADHARBOR_FRAME_LOG'] = previousLog
      if (previousLogMax === undefined) delete process.env['THREADHARBOR_FRAME_LOG_MAX']
      else process.env['THREADHARBOR_FRAME_LOG_MAX'] = previousLogMax
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
      promptTimeoutMs: 60_000,
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
      promptTimeoutMs: 60_000,
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
      promptTimeoutMs: 60_000,
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
      promptTimeoutMs: 60_000,
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
      promptTimeoutMs: 60_000,
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

  it('synthesizes an error turn-completion from a JSON-RPC error response so the turn never strands on running', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-hold-error-'))
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
      promptTimeoutMs: 60_000,
      transport: {
        kind: 'stdio', command: process.execPath,
        args: [new URL('./fixtures/fake-acp.mjs', import.meta.url).pathname, output, gate, 'error'],
      },
    }
    const worker = new HoldWorker(config)
    await worker.start()
    try {
      await send(socketPath, admission('p1'))
      await send(socketPath, admission('p2'))
      // The backend replies to p1 with a JSON-RPC error (e.g. Codex usage limit).
      // The hold worker must still synthesize a completion frame so the turn ends
      // and the queued p2 admission is admitted — without it the browser hangs on
      // "创建中 / running" forever.
      await writeFile(gate, 'go')
      await vi.waitFor(async () => { expect(await readFile(output, 'utf8')).toBe('p1\np2\n') })
      const page = await send(socketPath, { operation: 'read', afterSeq: 0, generation: 'generation' })
      if (!page.ok) throw new Error(page.error)
      const frames = (page.result as { events: readonly { frame: unknown }[] }).events
        .map(event => event.frame)
        .filter((frame): frame is Record<PropertyKey, unknown> => frame !== null && typeof frame === 'object' && !Array.isArray(frame))
      const completions = frames.filter(frame =>
        Reflect.get(frame, 'method') === '_x.ai/session/prompt_complete'
        && Reflect.get(Reflect.get(frame, 'params') as object, 'stopReason') === 'error')
      // One completion per prompt (p1 error + p2 error), both marked stopReason error.
      expect(completions).toHaveLength(2)
      // The backend's error text must ride along so the UI can show *why* the
      // turn failed instead of a bare "远程轮次失败".
      expect(Reflect.get(Reflect.get(completions[0]!, 'params') as object, 'message'))
        .toBe("You've hit your usage limit.")
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
      promptTimeoutMs: 60_000,
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

  it('synthesizes a timeout completion when an Agent never responds so the queue drains', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-hold-prompt-timeout-'))
    roots.push(root)
    const socketPath = join(root, 'control.sock')
    const output = join(root, 'requests.txt')
    const config: HoldWorkerConfig = {
      version: 1,
      holdId: 'hold',
      generation: 'generation',
      backend: 'codex',
      cwd: root,
      socketPath,
      journalPath: join(root, 'journal.jsonl'),
      statePath: join(root, 'state.json'),
      maxJournalEvents: 50,
      maxJournalBytes: 100_000,
      promptTimeoutMs: 100,
      transport: {
        kind: 'stdio', command: process.execPath,
        args: [new URL('./fixtures/fake-acp-hung.mjs', import.meta.url).pathname, output],
      },
    }
    const worker = new HoldWorker(config)
    await worker.start()
    try {
      expect(await send(socketPath, admission('p1'))).toMatchObject({ ok: true, result: { duplicate: false } })
      await vi.waitFor(async () => { expect(await readFile(output, 'utf8')).toBe('p1\n') })
      // The hung fixture never writes a response; within ~100ms the worker must
      // synthesize the timeout completion and free the queue.
      await vi.waitFor(async () => {
        const page = await send(socketPath, { operation: 'read', afterSeq: 0, generation: 'generation' })
        if (!page.ok) throw new Error(page.error)
        const events = (page.result as { events: readonly { frame: unknown }[] }).events
        const frames = events.map(event => event.frame).filter(frame => frame !== null && typeof frame === 'object')
        const timeoutError = frames.find(frame => !Array.isArray(frame) && Reflect.get(frame, 'error')
          && JSON.stringify(Reflect.get(frame, 'error')).includes('timed out'))
        const completion = frames.find(frame => !Array.isArray(frame) && Reflect.get(frame, 'method') === '_x.ai/session/prompt_complete')
        expect(timeoutError).toBeDefined()
        expect(completion).toBeDefined()
      }, { timeout: 1000, interval: 10 })
      // After the timeout the next admission must be forwarded to the backend.
      expect(await send(socketPath, admission('p2'))).toMatchObject({ ok: true, result: { duplicate: false } })
      await vi.waitFor(async () => { expect(await readFile(output, 'utf8')).toBe('p1\np2\n') })
    } finally {
      await worker.close()
    }
  })

  async function pacedWorker(mode: 'stream' | 'permission' | 'late'): Promise<{ socketPath: string; worker: HoldWorker }> {
    const root = await mkdtemp(join(tmpdir(), `dsh-hold-paced-${mode}-`))
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
      maxJournalEvents: 50,
      maxJournalBytes: 100_000,
      promptTimeoutMs: 100,
      transport: {
        kind: 'stdio', command: process.execPath,
        args: [new URL('./fixtures/fake-acp-paced.mjs', import.meta.url).pathname, join(root, 'requests.txt'), mode],
      },
    }
    const worker = new HoldWorker(config)
    await worker.start()
    return { socketPath, worker }
  }

  async function journalFrames(socketPath: string): Promise<Record<string, unknown>[]> {
    const page = await send(socketPath, { operation: 'read', afterSeq: 0, generation: 'generation' })
    if (!page.ok) throw new Error(page.error)
    const events = (page.result as { events: readonly { frame: unknown }[] }).events
    return events.map(event => event.frame).filter((frame): frame is Record<string, unknown> =>
      frame !== null && typeof frame === 'object' && !Array.isArray(frame))
  }
  const isTimeoutError = (frame: Record<string, unknown>): boolean =>
    frame['error'] !== undefined && JSON.stringify(frame['error']).includes('timed out')
  const completions = (frames: Record<string, unknown>[]): Record<string, unknown>[] =>
    frames.filter(frame => frame['method'] === '_x.ai/session/prompt_complete')

  it('measures prompt silence, not turn length: a streaming turn far longer than the guard never times out', async () => {
    const { socketPath, worker } = await pacedWorker('stream')
    try {
      expect(await send(socketPath, admission('p1'))).toMatchObject({ ok: true, result: { duplicate: false } })
      // 8 chunks × 40ms ≈ 320ms of activity against a 100ms guard.
      await vi.waitFor(async () => {
        expect(completions(await journalFrames(socketPath))).toHaveLength(1)
      }, { timeout: 2000, interval: 10 })
      const frames = await journalFrames(socketPath)
      expect(frames.some(isTimeoutError)).toBe(false)
      expect(completions(frames)[0]?.['params']).toMatchObject({ stopReason: 'end_turn' })
    } finally {
      await worker.close()
    }
  })

  it('pauses the idle guard while a permission request waits on the user', async () => {
    const { socketPath, worker } = await pacedWorker('permission')
    try {
      expect(await send(socketPath, admission('p1'))).toMatchObject({ ok: true, result: { duplicate: false } })
      await vi.waitFor(async () => {
        expect((await journalFrames(socketPath)).some(frame => frame['method'] === 'session/request_permission')).toBe(true)
      }, { timeout: 2000, interval: 10 })
      // The user takes 3× the guard to answer; the agent is not stalled.
      await new Promise(resolve => setTimeout(resolve, 300))
      expect((await journalFrames(socketPath)).some(isTimeoutError)).toBe(false)
      expect(await send(socketPath, {
        operation: 'send-frame',
        frame: { jsonrpc: '2.0', id: 'perm-1', result: { outcome: { outcome: 'selected', optionId: 'allow' } } },
      })).toMatchObject({ ok: true })
      await vi.waitFor(async () => {
        expect(completions(await journalFrames(socketPath))).toHaveLength(1)
      }, { timeout: 2000, interval: 10 })
      expect((await journalFrames(socketPath)).some(isTimeoutError)).toBe(false)
    } finally {
      await worker.close()
    }
  })

  it('journals the real completion when a response arrives after the guard already gave up', async () => {
    const { socketPath, worker } = await pacedWorker('late')
    try {
      expect(await send(socketPath, admission('p1'))).toMatchObject({ ok: true, result: { duplicate: false } })
      await vi.waitFor(async () => {
        expect((await journalFrames(socketPath)).some(isTimeoutError)).toBe(true)
      }, { timeout: 2000, interval: 10 })
      // 300ms later the agent answers for real: a second, successful completion.
      await vi.waitFor(async () => {
        expect(completions(await journalFrames(socketPath))).toHaveLength(2)
      }, { timeout: 2000, interval: 10 })
      const [timedOut, real] = completions(await journalFrames(socketPath))
      expect(timedOut?.['params']).toMatchObject({ stopReason: 'error' })
      expect(real?.['params']).toMatchObject({ stopReason: 'end_turn' })
    } finally {
      await worker.close()
    }
  })

  it('synthesizes a DSH turn/end timeout frame when the DSH Agent stalls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-hold-dsh-timeout-'))
    roots.push(root)
    const socketPath = join(root, 'control.sock')
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
      maxJournalEvents: 50,
      maxJournalBytes: 100_000,
      promptTimeoutMs: 80,
      transport: {
        kind: 'stdio', command: process.execPath,
        args: [new URL('./fixtures/fake-acp-hung.mjs', import.meta.url).pathname, output],
      },
    }
    const worker = new HoldWorker(config)
    await worker.start()
    try {
      expect(await send(socketPath, admission('p1'))).toMatchObject({ ok: true, result: { duplicate: false } })
      await vi.waitFor(async () => { expect(await readFile(output, 'utf8')).toBe('p1\n') })
      await vi.waitFor(async () => {
        const page = await send(socketPath, { operation: 'read', afterSeq: 0, generation: 'generation' })
        if (!page.ok) throw new Error(page.error)
        const events = (page.result as { events: readonly { frame: unknown }[] }).events
        const turnEnd = events.find(event => {
          const f = event.frame
          if (f === null || typeof f !== 'object' || Array.isArray(f)) return false
          if (Reflect.get(f, 'method') !== 'session.event') return false
          const params = Reflect.get(f, 'params')
          if (params === null || typeof params !== 'object' || Array.isArray(params)) return false
          const ev = Reflect.get(params, 'event')
          return ev !== null && typeof ev === 'object' && !Array.isArray(ev) && Reflect.get(ev, 'type') === 'turn/end'
        })
        expect(turnEnd).toBeDefined()
      }, { timeout: 1000, interval: 10 })
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
      promptTimeoutMs: 60_000,
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
      promptTimeoutMs: 60_000,
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
      promptTimeoutMs: 60_000,
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
      promptTimeoutMs: 60_000,
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
      promptTimeoutMs: 60_000,
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
      promptTimeoutMs: 60_000,
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
      promptTimeoutMs: 60_000,
      sessionRoot: join(root, 'dsh-sessions'),
      transport: { kind: 'stdio', command: 'echo', args: [] },
    }))
    const parsed = parseConfig(configPath)
    expect(parsed.sessionRoot).toBe(join(root, 'dsh-sessions'))
  })

  it('rejects promptTimeoutMs that is not a positive integer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-hold-parse-bad-prompt-timeout-'))
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
      promptTimeoutMs: 0,
      transport: { kind: 'stdio', command: 'echo', args: [] },
    }))
    expect(() => parseConfig(configPath)).toThrow(/promptTimeoutMs/)
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
      promptTimeoutMs: 60_000,
      transport: { kind: 'stdio', command: 'echo', args: [] },
    }))
    const parsed = parseConfig(configPath)
    expect(parsed.sessionRoot).toBeUndefined()
  })
})
