import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HoldRequest, HoldResponse, HoldWorkerConfig } from '../src/hold-protocol.ts'
import { HoldWorker } from '../src/hold-worker.ts'

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

  it.each(['grok', 'dsh'] as const)('waits for %s native turn completion before admitting the next prompt', async (backend) => {
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
      await vi.waitFor(async () => { expect(await readFile(output, 'utf8')).toBe('p1\n') })
      await writeFile(gate, 'go')
      await vi.waitFor(async () => { expect(await readFile(output, 'utf8')).toBe('p1\np2\n') })
      if (backend === 'grok') {
        const page = await send(socketPath, { operation: 'read', afterSeq: 0, generation: 'generation' })
        if (!page.ok) throw new Error(page.error)
        const frames = (page.result as { events: readonly { frame: unknown }[] }).events
          .map(event => event.frame)
          .filter((frame): frame is Record<PropertyKey, unknown> => frame !== null && typeof frame === 'object' && !Array.isArray(frame)
            && Reflect.get(frame, 'method') === '_x.ai/session/prompt_complete')
        expect(frames).toHaveLength(2)
        expect(frames.every((frame) => {
          const params = Reflect.get(frame, 'params')
          return params !== null && typeof params === 'object' && Reflect.get(params, 'source') === 'fake'
        })).toBe(true)
      }
    } finally {
      await worker.close()
    }
  })
})
