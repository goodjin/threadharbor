/**
 * The adapter's contract, against a scripted fake app-server.
 *
 * Drives `ZcodeAcpAgent` through its stdio streams with the fake from
 * `tests/fixtures/fake-app-server.mjs` standing in for the real one, and
 * asserts what DSH's client consumes: the handshake reply, the model list,
 * the projected tool and message frames, the prompt reply's stopReason and
 * usage, the permission round-trip, and cancellation.
 */

import { createCipheriv } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ZcodeAcpAgent } from '../src/acp-agent.ts'
import { decryptCredential, deriveKey } from '../src/credential.ts'
import type { ZcodePaths } from '../src/paths.ts'

const API_KEY = 'fake-api-key-0123456789abcdef'

type Frame = Record<string, unknown>

/** In-process stdio: frames out of the adapter land here as they are written. */
class Harness {
  readonly frames: Frame[] = []
  private readonly watchers = new Set<(frame: Frame) => void>()
  private readonly input = new PassThrough()
  private seq = 0

  constructor(paths: ZcodePaths, startupWaitMs: number) {
    const output = new PassThrough()
    output.setEncoding('utf8')
    let buffer = ''
    output.on('data', (chunk: string) => {
      buffer += chunk
      let index: number
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line.trim() === '') continue
        this.push(JSON.parse(line) as Frame)
      }
    })
    new ZcodeAcpAgent({ input: this.input, output, paths, startupWaitMs }).start()
  }

  private push(frame: Frame): void {
    this.frames.push(frame)
    for (const watch of [...this.watchers]) watch(frame)
  }

  send(frame: Frame): void {
    this.input.write(`${JSON.stringify(frame)}\n`)
  }

  request(method: string, params: Frame, timeoutMs = 15_000): Promise<Frame> {
    const id = ++this.seq
    this.send({ jsonrpc: '2.0', id, method, params })
    return this.waitFor(frame => frame['id'] === id && frame['method'] === undefined, timeoutMs, `${method} reply`)
  }

  notify(method: string, params: Frame): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  waitFor(test: (frame: Frame) => boolean, timeoutMs: number, what: string): Promise<Frame> {
    const already = this.frames.find(test)
    if (already !== undefined) return Promise.resolve(already)
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.watchers.delete(check)
        reject(new Error(`timed out waiting for ${what}`))
      }, timeoutMs)
      const check = (frame: Frame) => {
        if (!test(frame)) return
        this.watchers.delete(check)
        clearTimeout(timer)
        resolve(frame)
      }
      this.watchers.add(check)
    })
  }
}

let home: string | undefined

/** A temp ZCode world: encrypted credential, builtin tree, empty log. */
function makeHome(): string {
  const dir = join(tmpdir(), `zcode-acp-test-${String(process.pid)}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'log'), { recursive: true })
  // The encrypted credential, produced with the same derivation the adapter
  // uses — proving the decrypt path with a real AES-256-GCM round trip.
  const iv = Buffer.alloc(12, 7)
  const cipher = createCipheriv('aes-256-gcm', deriveKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(API_KEY, 'utf8'), cipher.final()])
  const enc = `enc:v1:${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`
  expect(decryptCredential(enc)).toBe(API_KEY)
  writeFileSync(join(dir, 'credentials.json'), JSON.stringify({
    'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:42:api-key': enc,
  }))
  const endpoint = join(dir, 'builtin', '3.14.4', 'endpoint-abc123')
  mkdirSync(endpoint, { recursive: true })
  writeFileSync(join(endpoint, 'zcode-builtin.json'), '{}')
  writeFileSync(join(dir, 'provider_config.json'), '{}')
  return dir
}

function pathsFor(dir: string): ZcodePaths {
  return {
    credentialsFile: join(dir, 'credentials.json'),
    builtinBase: join(dir, 'builtin'),
    personalConfig: join(dir, 'provider_config.json'),
    logDir: join(dir, 'log'),
    serverScript: join(import.meta.dirname, 'fixtures/fake-app-server.mjs'),
    nodeBin: process.execPath,
  }
}

async function withEnv<T>(over: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {}
  for (const [name, value] of Object.entries(over)) {
    saved[name] = process.env[name]
    process.env[name] = value
  }
  try {
    return await run()
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

/** One opened adapter session, handshake already done. */
async function openSession(env: Record<string, string> = {}): Promise<Harness> {
  const dir = home ?? makeHome()
  home = dir
  // ZCODE_ACP_LOG_DIR is what the fake app-server keys its registry log on —
  // the real one always writes ~/.zcode/cli/log, so this override is test-only.
  return withEnv({ ZCODE_ACP_LOG_DIR: join(dir, 'log'), ...env }, async () => {
    const harness = new Harness(pathsFor(dir), 50)
    const reply = await harness.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
    expect(reply['result']).toMatchObject({ protocolVersion: 1, agentInfo: { name: 'zcode-acp' } })
    const created = await harness.request('session/new', { cwd: dir, mcpServers: [] })
    expect((created['result'] as Frame)['sessionId']).toBe('sess_fake_1')
    return harness
  })
}

function updateOf(frame: Frame): Frame | undefined {
  return (frame['params'] as Frame | undefined)?.['update'] as Frame | undefined
}

beforeAll(() => { home = makeHome() })
afterAll(() => { if (home !== undefined) rmSync(home, { recursive: true, force: true }) })

describe('zcode-acp adapter', { timeout: 25_000 }, () => {
  it('declares the GLM model list on session/new', async () => {
    const harness = await openSession()
    const created = harness.frames.find(frame => {
      const result = frame['result'] as Frame | undefined
      return result?.['sessionId'] === 'sess_fake_1'
    })
    expect((created!['result'] as Frame)['models']).toMatchObject({
      availableModels: [
        { modelId: 'GLM-5.3' },
        { modelId: 'GLM-5.3-Flash' },
        { modelId: 'GLM-5.2' },
      ],
    })
    expect((created!['result'] as Frame)['modes']).toMatchObject({
      currentModeId: 'build',
      availableModes: [
        { id: 'build' }, { id: 'plan' }, { id: 'edit' }, { id: 'guarded' }, { id: 'yolo' },
      ],
    })
  })

  it('projects a turn: tool card, message text, usage, end_turn', async () => {
    const status = join(home!, 'status-basic.json')
    const harness = await openSession({ FAKE_STATUS: status, FAKE_EXPECTED_KEY: API_KEY })
    const reply = await harness.request('session/prompt', {
      sessionId: 'sess_fake_1',
      prompt: [{ type: 'text', text: 'do it' }],
    }, 20_000)
    expect(reply['result']).toEqual({
      stopReason: 'end_turn',
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    })
    const toolOpen = harness.frames.find(frame => updateOf(frame)?.['sessionUpdate'] === 'tool_call')
    expect(updateOf(toolOpen!)).toMatchObject({
      toolCallId: 'call_w1',
      title: 'Write',
      kind: 'edit',
      status: 'pending',
    })
    const toolDone = harness.frames.filter(frame => updateOf(frame)?.['sessionUpdate'] === 'tool_call_update').at(-1)
    expect(updateOf(toolDone!)).toMatchObject({ toolCallId: 'call_w1', status: 'completed' })
    const message = harness.frames
      .filter(frame => updateOf(frame)?.['sessionUpdate'] === 'agent_message_chunk')
      .map(frame => updateOf(frame)!['content']).at(-1)
    expect(message).toMatchObject({ type: 'text', text: 'fake reply' })
    // the decrypted key reached the model-request injection point
    expect(JSON.parse(readFileSync(status, 'utf8'))).toMatchObject({ apiKeyOk: true, sawRuntimePrefs: true })
  })

  it('forwards a permission request and maps the choice onto ZCode\'s own template', async () => {
    const status = join(home!, 'status-perm.json')
    const harness = await openSession({
      FAKE_STATUS: status,
      FAKE_EXPECTED_KEY: API_KEY,
      FAKE_PERMISSION: '1',
    })
    const pending = harness.waitFor(frame => frame['method'] === 'session/request_permission', 20_000, 'permission request')
    const settled = harness.waitFor(frame => (frame['result'] as Frame | undefined)?.['stopReason'] === 'end_turn', 20_000, 'prompt reply')
    harness.request('session/prompt', {
      sessionId: 'sess_fake_1',
      prompt: [{ type: 'text', text: 'write it' }],
    }, 20_000).catch(() => undefined)
    const request = await pending
    expect((request['params'] as Frame)['toolCall']).toMatchObject({ name: 'Write', kind: 'edit' })
    const options = (request['params'] as Frame)['options'] as Frame[]
    expect(options.map(option => option['optionId'])).toEqual(['allow_once', 'allow_project', 'deny'])
    harness.send({ jsonrpc: '2.0', id: request['id'], result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } })
    await settled
    expect(JSON.parse(readFileSync(status, 'utf8'))).toMatchObject({
      permissionResponse: { decision: 'allow', reason: 'Approved once' },
    })
  })

  it('cancels a hanging turn with stopReason cancelled', async () => {
    const harness = await openSession({ FAKE_HANG: '1' })
    const settled = harness.waitFor(frame => (frame['result'] as Frame | undefined)?.['stopReason'] === 'cancelled', 20_000, 'cancelled reply')
    harness.request('session/prompt', {
      sessionId: 'sess_fake_1',
      prompt: [{ type: 'text', text: 'hang' }],
    }, 20_000).catch(() => undefined)
    // let the turn start, then cancel it
    await new Promise(resolve => setTimeout(resolve, 400))
    harness.notify('session/cancel', { sessionId: 'sess_fake_1' })
    expect(await settled).toMatchObject({ result: { stopReason: 'cancelled' } })
  })
})
