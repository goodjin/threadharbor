/**
 * How configuration becomes a reachable agent.
 *
 * Scope note, deliberately narrow: this covers the decisions the factory makes
 * — which dialect an agent speaks, and what happens when a preset does not
 * exist. Actually connecting is the transport's own business and already has
 * its own tests; duplicating it here would only test `WebSocket` and `spawn`.
 */

import { describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeDialect, codexDialect, grokDialect } from '@threadharbor/dsh-acp-agent'
import { makeSessionFactory } from '../src/factory.ts'
import { Config as EntryConfig } from '../src/entry.ts'
import type { AcpTransport } from '@threadharbor/dsh-acp-agent'
import type { PresetConfig } from '../src/registry.ts'

const CONFIG: PresetConfig = {
  presets: {
    'acp-grok': { agent: 'grok', url: 'ws://127.0.0.1:2419', model: 'grok-4.7' },
    'acp-claude': { agent: 'claude', command: 'claude-agent-acp', mode: 'default' },
    'acp-codex': { agent: 'codex', command: 'codex-acp' },
  },
}

const deps = { answerPermission: async () => ({ outcome: 'reject' as const }) }

describe('makeSessionFactory', () => {
  it('gives each agent its own dialect', () => {
    const factory = makeSessionFactory(CONFIG, deps)
    expect(factory.dialectFor('acp-grok', CONFIG.presets['acp-grok']!)).toBe(grokDialect)
    expect(factory.dialectFor('acp-claude', CONFIG.presets['acp-claude']!)).toBe(claudeDialect)
    expect(factory.dialectFor('acp-codex', CONFIG.presets['acp-codex']!)).toBe(codexDialect)
  })

  it('does not open zcode as an ACP process', async () => {
    const factory = makeSessionFactory({
      presets: { 'acp-zcode': { agent: 'zcode', models: [{ id: 'GLM-5.3', name: 'GLM 5.3' }] } },
    }, deps)
    expect(factory.dialectFor('acp-zcode', { agent: 'zcode' })).toBeUndefined()
    await expect(factory.open('acp-zcode', { cwd: '/tmp' })).rejects.toThrow(/native loop/)
  })

  it('refuses an agent it does not drive, rather than guessing a dialect', () => {
    // Guessing here would parse a native session's frames as ACP and write
    // whatever came out into its log.
    const factory = makeSessionFactory(CONFIG, deps)
    expect(factory.dialectFor('dsh', { agent: 'native' })).toBeUndefined()
    expect(factory.dialectFor('dsh', {})).toBeUndefined()
  })

  it('reports a preset that is not configured instead of opening nothing', async () => {
    // Opening nothing would leave the session running with no agent, which
    // looks exactly like an agent that is merely slow.
    const factory = makeSessionFactory(CONFIG, deps)
    await expect(factory.open('acp-missing', { cwd: '/tmp' })).rejects.toThrow(/no preset named/)
  })

  it('hands the session/new model list to the catalog as the opening preset’s report', async () => {
    // The picker serves what the agent reported; the factory knows which preset
    // opened, so it is the seam that keys the report by preset.
    const transport = recordingTransport()
    const reports: { presetId: string; models: unknown }[] = []
    const factory = makeSessionFactory(
      { presets: { 'acp-grok': { agent: 'grok', url: 'ws://127.0.0.1:2419' } } },
      { ...deps, transport: () => transport, onRuntimeModels: (presetId, models) => { reports.push({ presetId, models }) } },
    )
    const session = await factory.open('acp-grok', { cwd: '/tmp' })
    void session.run(
      { kind: 'enter', messages: [] },
      { sessionId: 's1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 },
    )
    // Answer the handshake in order: initialize, then session/new with the
    // grok-shaped model list.
    for (const frame of transport.sent) {
      const request = JSON.parse(frame) as { id?: number; method?: string }
      if (request.id === undefined) continue
      const result = request.method === 'session/new'
        ? { sessionId: 's1', models: { availableModels: [{ modelId: 'm1', name: 'M1' }] } }
        : {}
      transport.receive(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
      await flush()
    }
    expect(reports).toEqual([{ presetId: 'acp-grok', models: [{ id: 'm1', name: 'M1' }] }])
  })
})

/** A transport a test can kill, holding one death slot like the real ones do. */
function killableTransport(): AcpTransport & { die(reason: string): void } {
  let line: (line: string) => void = () => {}
  let death: (reason: string) => void = () => {}
  return {
    send: () => {},
    onLine: handler => { line = handler },
    onDeath: handler => { death = handler },
    lastFrameAt: () => 0,
    lastDiagnosticAt: () => 0,
    stderrTail: () => [],
    close: () => {},
    die: reason => { death(reason) },
    /** Exposed so a test can drive frames the way a live agent would. */
    receive: (frame: string) => { line(frame) },
  } as AcpTransport & { die(reason: string): void; receive(frame: string): void }
}

describe('连接死亡的转播', () => {
  it('传输死亡同时到达 AcpClient 的在途请求和会话的观察者', async () => {
    // Both listeners matter: the client's rejection is what fails a hung turn
    // loudly, and the session-level callback is what lets the registry drop
    // the dead connection. The real transports hold one death slot, so the
    // factory has to fan the event out — registering the observer directly on
    // the transport would silently steal the client's slot.
    const transport = killableTransport()
    const factory = makeSessionFactory(
      { presets: { 'acp-grok': { agent: 'grok', url: 'ws://127.0.0.1:2419' } } },
      { ...deps, transport: () => transport },
    )
    const session = await factory.open('acp-grok', { cwd: '/tmp' })
    const seenBySession: string[] = []
    session.onDead(reason => { seenBySession.push(reason) })

    // One request in flight: its classified failure proves the client kept its
    // listener (the transport's death reason names the row's reconnect hint).
    // The reason text is the real stdio transport's exit line — `acp `-prefixed,
    // which is what keeps it in the connection bucket.
    const pending = session.run(
      { kind: 'enter', messages: [] },
      { sessionId: 's1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 },
    )
    transport.die('acp agent grok-4.7 exited (code=1 signal=none)')
    const result = await pending
    expect(result.end).toMatchObject({ kind: 'error', error: { code: 'ACP_CONNECTION' } })
    expect(seenBySession).toEqual(['acp agent grok-4.7 exited (code=1 signal=none)'])
  })

  it('会话自己关掉时不再报告死亡', async () => {
    const transport = killableTransport()
    const factory = makeSessionFactory(
      { presets: { 'acp-grok': { agent: 'grok', url: 'ws://127.0.0.1:2419' } } },
      { ...deps, transport: () => transport },
    )
    const session = await factory.open('acp-grok', { cwd: '/tmp' })
    const deaths: string[] = []
    session.onDead(reason => { deaths.push(reason) })
    session.close()
    expect(deaths).toEqual([])
  })
})

/** A transport that records what the client wrote, and can push frames in. */
function recordingTransport(): AcpTransport & { readonly sent: string[]; receive: (frame: string) => void } {
  const sent: string[] = []
  let line: (frame: string) => void = () => {}
  return {
    sent,
    send: (frame: string) => { sent.push(frame) },
    onLine: (handler: (frame: string) => void) => { line = handler },
    onDeath: () => {},
    lastFrameAt: () => 0,
    lastDiagnosticAt: () => 0,
    stderrTail: () => [],
    close: () => {},
    receive: (frame: string) => { line(frame) },
  } as AcpTransport & { readonly sent: string[]; receive: (frame: string) => void }
}

/** Let queued microtasks run, so the async answer path has settled. */
async function flush(): Promise<void> {
  for (let tick = 0; tick < 12; tick++) await Promise.resolve()
}

const CURSOR_ASK = JSON.stringify({
  jsonrpc: '2.0',
  id: 0,
  method: 'cursor/ask_question',
  params: {
    questions: [{ id: 'q1', prompt: 'Which mode?', options: [{ id: 'plan', label: 'Plan' }] }],
  },
})

/**
 * A real executable that writes down the argv it was spawned with, then exits.
 *
 * The stdio transport spawns in its constructor and takes no injection seam, so
 * the only honest way to see what a preset actually launches is to launch
 * something. A stand-in binary answers that without needing a live agent — and
 * without it, "the agent never answered" is indistinguishable from "we passed
 * the wrong arguments", which is exactly the failure this guards.
 */
function recordingBinary(): { command: string; argv: () => readonly string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'threadharbor-argv-'))
  const argvFile = join(dir, 'argv.json')
  const script = join(dir, 'agent')
  writeFileSync(script, [
    '#!/usr/bin/env node',
    'const { writeFileSync } = require("node:fs")',
    `writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)))`,
    'process.exit(0)',
    '',
  ].join('\n'))
  chmodSync(script, 0o755)
  return { command: script, argv: () => JSON.parse(readFileSync(argvFile, 'utf8')) as readonly string[] }
}

/** Open one preset, let the stand-in binary exit, and report how it was launched. */
async function spawnArgvOf(config: PresetConfig, presetId: string): Promise<readonly string[]> {
  const binary = recordingBinary()
  const factory = makeSessionFactory(
    { presets: { [presetId]: { command: binary.command, ...config.presets[presetId]! } } },
    deps,
  )
  const session = await factory.open(presetId, { cwd: '/tmp' })
  const dead = new Promise<void>(resolve => { session.onDead(() => { resolve() }) })
  await session
    .run(
      { kind: 'enter', messages: [] },
      { sessionId: 's1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 },
    )
    .catch(() => {})
  // The binary wrote its argv before exiting, so its death is the write's
  // completion — no polling, no sleep.
  await dead
  return binary.argv()
}


/** A stand-in binary that records the directory it was started in. */
function recordingCwd(): { command: string; cwd: () => string } {
  const dir = mkdtempSync(join(tmpdir(), 'threadharbor-cwd-'))
  const cwdFile = join(dir, 'cwd.txt')
  const script = join(dir, 'agent')
  writeFileSync(script, [
    '#!/usr/bin/env node',
    'const { writeFileSync } = require("node:fs")',
    `writeFileSync(${JSON.stringify(cwdFile)}, process.cwd())`,
    'process.exit(0)',
    '',
  ].join('\n'))
  chmodSync(script, 0o755)
  return { command: script, cwd: () => readFileSync(cwdFile, 'utf8') }
}

describe('看门狗时限经过宿主配置校验', () => {
  it('stallMs / totalMs / warnMs / graceMs 不再被配置校验丢掉', () => {
    // 2026-10-27：行上写了 stallMs: 300000，schema 没列这个字段，校验后
    // 静默消失，网关退回默认的 120000——「超时时间不准」的根源。列了字段
    // 还不够，值必须一路留到建预设的地方。
    const preset = EntryConfig({
      presetId: 'acp-codex',
      agent: 'codex',
      stallMs: 300_000,
      totalMs: 3_600_000,
      warnMs: 60_000,
      graceMs: 5_000,
    })
    expect(preset).toMatchObject({
      stallMs: 300_000,
      totalMs: 3_600_000,
      warnMs: 60_000,
      graceMs: 5_000,
    })
  })

  it('旧行里的 answerTimeoutMs 别名同样保留', () => {
    const preset = EntryConfig({ presetId: 'acp-codex', agent: 'codex', answerTimeoutMs: 600_000 })
    expect(preset.answerTimeoutMs).toBe(600_000)
  })
})

describe('拉起外部 agent 时补齐 ACP 所需的参数', () => {
  it('经过宿主配置校验后，省略参数仍使用 Cursor 的 ACP 默认参数', async () => {
    const preset = EntryConfig({ presetId: 'acp-cursor', agent: 'cursor' })
    expect(await spawnArgvOf({ presets: { 'acp-cursor': preset } }, 'acp-cursor'))
      .toEqual(['acp', '--trust'])
  })

  it.each([{ args: [] }, { args: ['acp', '--trust'] }])('配置校验保留显式参数 $args', async ({ args }) => {
    const preset = EntryConfig({ presetId: 'acp-cursor', agent: 'cursor', args })
    expect(await spawnArgvOf({ presets: { 'acp-cursor': preset } }, 'acp-cursor')).toEqual(args)
  })

  it('cursor 带上 acp 子命令：裸 agent 是交互式 CLI，不会应答 JSON-RPC', async () => {
    // Cursor 的官方文档：`agent acp` 才是 stdio 上的 ACP 服务。少了这个子
    // 命令，进程活着却一个字节不回，握手只能等超时——而超时说的是「没应答」，
    // 没人看得出是参数漏了。
    expect(await spawnArgvOf({ presets: { 'acp-cursor': { agent: 'cursor' } } }, 'acp-cursor'))
      .toEqual(['acp', '--trust'])
  })

  it('claude 与 codex 的二进制本身就是 ACP 服务，不加参数', async () => {
    // claude-agent-acp / codex-acp 启动即服务；给它们加参数反而会启动错的东西。
    expect(await spawnArgvOf({ presets: { 'acp-claude': { agent: 'claude' } } }, 'acp-claude')).toEqual([])
    expect(await spawnArgvOf({ presets: { 'acp-codex': { agent: 'codex' } } }, 'acp-codex')).toEqual([])
  })

  it('子进程开在这次给出的项目目录，预设上写死的目录不另算', async () => {
    // 预设上的目录曾经盖过会话自己的项目：子进程和 session/new 各看各的，
    // 新会话就开到了写死的那一处。两边都必须用同一次打开给出的目录。
    const binary = recordingCwd()
    const project = mkdtempSync(join(tmpdir(), 'threadharbor-project-'))
    const factory = makeSessionFactory(
      { presets: { 'acp-codex': { agent: 'codex', command: binary.command, cwd: '/Users/good/Documents/deepseek-harness' } } },
      deps,
    )
    const session = await factory.open('acp-codex', { cwd: project })
    const dead = new Promise<void>(resolve => { session.onDead(() => { resolve() }) })
    await session.run(
      { kind: 'enter', messages: [] },
      { sessionId: 's1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 },
    ).catch(() => {})
    await dead
    expect(realpathSync(binary.cwd())).toBe(realpathSync(project))
  })

  it('没有给出项目目录就拒绝打开，不会落到本进程的目录', async () => {
    const factory = makeSessionFactory(
      { presets: { 'acp-codex': { agent: 'codex', command: 'codex-acp' } } },
      deps,
    )
    await expect(factory.open('acp-codex', { cwd: '' })).rejects.toThrow(/没有工作区/)
  })

  it('配置显式写了参数时以配置为准，不再补默认值', async () => {
    // 换版本、换端点或换认证方式时，运维要能完全接管命令行。
    expect(await spawnArgvOf(
      { presets: { 'acp-cursor': { agent: 'cursor', args: ['--api-key', 'k', 'acp'] } } },
      'acp-cursor',
    )).toEqual(['--api-key', 'k', 'acp'])
  })
})

describe('把 agent 的提问接到 host 的提问服务', () => {
  it('host 可提问时，提问走 host 钩子并带上会话，答案按 cursor 形状回传', async () => {
    // The hook answered on the host's behalf, and the reply is the answered
    // envelope — not the auto-answer's skip.
    const transport = recordingTransport()
    const seen: unknown[] = []
    const factory = makeSessionFactory(
      { presets: { 'acp-cursor': { agent: 'cursor', url: 'ws://127.0.0.1:2419' } } },
      {
        ...deps,
        transport: () => transport,
        answerAskQuestion: async request => { seen.push(request); return { answer: 'Plan' } },
      },
    )
    // The opener knows the DSH session; the hook's request names it, so the
    // host-side bridge can resolve the live agent the card belongs to.
    await factory.open('acp-cursor', { cwd: '/tmp', dshSessionId: 's1' })
    transport.receive(CURSOR_ASK)
    await flush()

    expect(seen[0]).toMatchObject({ sessionId: 's1', questions: [{ id: 'q1', prompt: 'Which mode?' }] })
    expect(transport.sent).toHaveLength(1)
    const reply = JSON.parse(transport.sent[0]!) as { id: number; result: { outcome: { outcome: string } } }
    expect(reply.id).toBe(0)
    expect(reply.result).toEqual({
      outcome: { outcome: 'answered', answers: [{ questionId: 'q1', selectedOptionIds: ['plan'] }] },
    })
  })

  it('文档写成通知的三个扩展方法按请求到达时回空结果，agent 不会停等', async () => {
    // 2026-10-21 实测：cursor 2026.10.01 给 update_todos / task /
    // generate_image 都带 JSON-RPC id，按请求发来；不回会让回合停住。
    const transport = recordingTransport()
    const factory = makeSessionFactory(
      { presets: { 'acp-cursor': { agent: 'cursor', url: 'ws://127.0.0.1:2419' } } },
      { ...deps, transport: () => transport },
    )
    await factory.open('acp-cursor', { cwd: '/tmp' })
    const frames = [
      { jsonrpc: '2.0', id: 41, method: 'cursor/update_todos', params: { toolCallId: 'c', todos: [], merge: true } },
      { jsonrpc: '2.0', id: 42, method: 'cursor/task', params: { toolCallId: 'c', description: 'Explore', prompt: 'Find auth', subagentType: 'explore' } },
      { jsonrpc: '2.0', id: 43, method: 'cursor/generate_image', params: { toolCallId: 'c', description: 'Icon' } },
    ]
    for (const frame of frames) transport.receive(JSON.stringify(frame))
    await flush()

    const replies = transport.sent.map(line => JSON.parse(line) as { id: number; result: unknown })
    expect(replies.map(reply => reply.id)).toEqual([41, 42, 43])
    expect(replies.map(reply => reply.result)).toEqual([{}, {}, {}])
  })

  it('host 接不到时维持现状：扩展钩子的自动应答照旧生效', async () => {
    // No-regression pin: without a host ask bridge, cursor's question gets the
    // benign skip it has always gotten, and the turn proceeds.
    const transport = recordingTransport()
    const factory = makeSessionFactory(
      { presets: { 'acp-cursor': { agent: 'cursor', url: 'ws://127.0.0.1:2419' } } },
      { ...deps, transport: () => transport },
    )
    await factory.open('acp-cursor', { cwd: '/tmp' })
    transport.receive(CURSOR_ASK)
    await flush()

    const reply = JSON.parse(transport.sent[0]!) as { id: number; result: { outcome: { outcome: string } } }
    expect(reply.id).toBe(0)
    expect(reply.result.outcome.outcome).toBe('skipped')
  })
})

/** A transport whose beacon stamps the test moves by hand. */
function beaconTransport() {
  let stamps = { frameAt: 0, diagnosticAt: 0, tail: [] as string[] }
  const base = recordingTransport()
  return {
    ...base,
    lastFrameAt: () => stamps.frameAt,
    lastDiagnosticAt: () => stamps.diagnosticAt,
    stderrTail: () => stamps.tail,
    advance(next: { frameAt: number; diagnosticAt: number; tail: string[] }): void {
      stamps = next
    },
  }
}

describe('makeSessionFactory 诊断信标', () => {
  it('打开的会话透传传输层活动信标', async () => {
    const transport = beaconTransport()
    const factory = makeSessionFactory(
      { presets: { 'acp-grok': { agent: 'grok', url: 'ws://127.0.0.1:2419' } } },
      { ...deps, transport: () => transport },
    )
    const session = await factory.open('acp-grok', { cwd: '/tmp' })
    expect(session.diagnostics().stderrTail).toEqual([])
    transport.advance({ frameAt: 111, diagnosticAt: 222, tail: ['tls handshake eof'] })
    const diagnostics = session.diagnostics()
    expect(diagnostics.lastFrameAt).toBe(111)
    expect(diagnostics.lastDiagnosticAt).toBe(222)
    expect(diagnostics.stderrTail).toEqual(['tls handshake eof'])
  })
})
