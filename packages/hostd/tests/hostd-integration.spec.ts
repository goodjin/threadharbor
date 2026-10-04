import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JsonValue, RemoteControlRequest, RemoteJournalPage } from '@threadharbor/protocol'
import { RemoteAgentHostd, type HostdOptions } from '../src/server.ts'

const roots: string[] = []
const servers: Server[] = []

function request(method: RemoteControlRequest['method'], params: Record<string, JsonValue>): RemoteControlRequest {
  return { id: `${method}-test`, method, params }
}

async function listenLoopback(): Promise<{ server: Server; port: number }> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fake Grok server did not bind')
  servers.push(server)
  return { server, port: address.port }
}

/** Resolve true once the pid is gone, false if it outlives the budget. */
async function waitForPidExit(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  return false
}

/**
 * Kill every fake Agent this root started, which is how a test simulates an
 * Agent crashing. Backends are no longer shut down through a control socket —
 * there is no per-session worker to talk to any more — so a pid file written by
 * the double is the honest way to reach a process the hostd object owns.
 */
/** Wait for a turn's response frame to land in the journal.
 *  With the Agent in-process the prompt send and the journal read are both local
 *  and fast, so a read issued straight after a prompt can legitimately win the
 *  race and see an empty turn. hostd has no `events.wait` — waiting for a turn is
 *  the gateway's job — so the test does what the gateway does and polls. */
async function waitForTurn(
  hostd: RemoteAgentHostd, sessionId: string, rpcId: string, timeoutMs = 10_000,
): Promise<RemoteJournalPage> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const page = await hostd.dispatch(request('events.read', {
      sessionId, afterSeq: 0, generation: (await generationOf(hostd, sessionId)),
    })) as unknown as RemoteJournalPage
    const answered = page.events.some(event => {
      const frame = event.frame as { id?: unknown; method?: unknown }
      return frame.id === rpcId && frame.method === undefined
    })
    if (answered) return page
    if (Date.now() > deadline) throw new Error(`turn ${rpcId} did not answer within ${timeoutMs}ms`)
    await new Promise(resolveWait => setTimeout(resolveWait, 20))
  }
}

async function generationOf(hostd: RemoteAgentHostd, sessionId: string): Promise<string> {
  const attached = await hostd.dispatch(request('session.attach', { sessionId })) as unknown as { generation: string }
  return attached.generation
}

async function killBackends(dataDir: string): Promise<void> {
  const entries = await readdir(dataDir).catch(() => [] as string[])
  for (const entry of entries) {
    if (!entry.endsWith('.pid')) continue
    const pid = Number.parseInt((await readFile(join(dataDir, entry), 'utf8')).trim(), 10)
    if (!Number.isInteger(pid)) continue
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    await waitForPidExit(pid)
  }
}

const fakeAgent = new URL('./fixtures/fake-acp-agent.mjs', import.meta.url).pathname

function pidFile(root: string, backend: string): string {
  return join(root, `${backend}.pid`)
}

/**
 * Every stdio backend is the fake Agent. The bridge picks the transport from
 * these commands, so this is what the test actually controls now that hostd
 * runs the Agent in-process.
 */
function hostdOptions(root: string, extra: Partial<HostdOptions> = {}): HostdOptions {
  return {
    host: '127.0.0.1', port: 0, dataDir: root,
    maxRequestBytes: 1024 * 1024, operationTimeoutMs: 1000, workerStartupTimeoutMs: 3000,
    maxJournalEvents: 100, maxJournalBytes: 100_000, maxDirectoryEntries: 100,
    authTimeoutMs: 1000, installTimeoutMs: 1000, promptTimeoutMs: 60_000, holdIdleTimeoutMs: 0,
    agentConfigHome: root, maxAgentConfigBytes: 4096,
    codexCliCommand: process.execPath,
    codexCommand: process.execPath, codexArgs: [fakeAgent, 'codex', pidFile(root, 'codex')],
    claudeCommand: '/missing/claude',
    claudeAcpCommand: process.execPath, claudeAcpArgs: [fakeAgent, 'claude', pidFile(root, 'claude')],
    dshCommand: process.execPath, dshArgs: [fakeAgent, 'dsh', pidFile(root, 'dsh')],
    grokCommand: process.execPath, grokServeHost: '127.0.0.1', grokServePort: 65_499, grokArgs: [],
    hostdHttpFallback: false,
    ...extra,
  }
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => { resolve() }))))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('RemoteAgentHostd session control', () => {
  it('runs all backend frame lanes and reattaches held sessions after hostd restarts', async () => {
    vi.stubEnv('GROK_AGENT_SECRET', 'host-only-grok-secret')
    vi.stubEnv('CODEX_API_KEY', 'host-only-codex-key')
    vi.stubEnv('DEEPSEEK_API_KEY', 'host-only-dsh-key')
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-hostd-integration-'))
    roots.push(root)
    const project = await mkdtemp(join(tmpdir(), 'threadharbor-hostd-project-'))
    roots.push(project)
    const grok = await listenLoopback()
    
    const first = new RemoteAgentHostd(hostdOptions(root))
    await first.start()
    const attachments = new Map<string, { generation: string; nativeSessionId?: string }>()
    try {
      for (const backend of ['codex', 'claude', 'dsh'] as const) {
        const sessionId = `${backend}-session`
        const attached = await first.dispatch(request('session.start', { sessionId, backend, cwd: project })) as unknown as {
          generation: string
          nativeSessionId?: string
        }
        attachments.set(sessionId, {
          generation: attached.generation,
          ...(attached.nativeSessionId === undefined ? {} : { nativeSessionId: attached.nativeSessionId }),
        })
        const nativeSessionId = attached.nativeSessionId ?? sessionId
        const frame = {
          jsonrpc: '2.0', id: `${backend}-prompt`, method: 'session/prompt',
          params: { sessionId: nativeSessionId, prompt: [{ type: 'text', text: 'hello' }] },
        }
        await first.dispatch(request('session.prompt', {
          sessionId,
          admission: { clientId: 'browser', requestId: `${backend}-prompt`, frame },
        }))
        const page = await waitForTurn(first, sessionId, `${backend}-prompt`, 10_000)
          .then(() => first.dispatch(request('events.read', {
            sessionId, afterSeq: 0, generation: attached.generation,
          })) as Promise<RemoteJournalPage>)
        expect(JSON.stringify(page.events)).toContain(`${backend} reply`)
        expect(JSON.stringify(page.events)).toContain('prompt_complete')
      }
    } finally {
      await first.close()
    }

    const restarted = new RemoteAgentHostd(hostdOptions(root))
    await restarted.start()
    try {
      for (const [sessionId, original] of attachments) {
        const attached = await restarted.dispatch(request('session.attach', { sessionId })) as unknown as {
          generation: string
          nativeSessionId?: string
        }
        expect(attached).toMatchObject(original)
      }
    } finally {
      await restarted.close()
      await killBackends(root)
    }
  })

  it('revives a dead backend on attach and keeps the session resumable', { timeout: 30_000 }, async () => {
    vi.stubEnv('GROK_AGENT_SECRET', 'host-only-grok-secret')
    vi.stubEnv('CODEX_API_KEY', 'host-only-codex-key')
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-hostd-revive-'))
    roots.push(root)
    const project = await mkdtemp(join(tmpdir(), 'threadharbor-hostd-project-'))
    roots.push(project)
    const grok = await listenLoopback()
    
    const hostd = new RemoteAgentHostd(hostdOptions(root))
    await hostd.start()
    try {
      const started = await hostd.dispatch(request('session.start', {
        sessionId: 'codex-revive', backend: 'codex', cwd: project,
      })) as unknown as { generation: string; nativeSessionId?: string; holdId: string }
      const holdsDir = join(root, 'holds')
      const holdId = (await readdir(holdsDir))[0]
      expect(holdId).toBeTypeOf('string')
      // A session is now a directory with its own transcript and state: no
      // socket, no config, because the connection is shared and lives in memory.
      expect((await readdir(join(holdsDir, holdId!))).sort()).toEqual(['journal.jsonl', 'state.json'])

      await killBackends(root)
      const attached = await hostd.dispatch(request('session.attach', { sessionId: 'codex-revive' })) as unknown as {
        generation: string
        nativeSessionId?: string
        reopened?: boolean
      }
      expect(attached.generation).toBe(started.generation)
      expect(attached.nativeSessionId).toBe(started.nativeSessionId)

      await hostd.dispatch(request('session.prompt', {
        sessionId: 'codex-revive',
        admission: {
          clientId: 'browser', requestId: 'after-revive',
          frame: {
            jsonrpc: '2.0', id: 'after-revive', method: 'session/prompt',
            params: { sessionId: attached.nativeSessionId ?? 'codex-revive', prompt: [{ type: 'text', text: 'hello' }] },
          },
        },
      }))
      await waitForTurn(hostd, 'codex-revive', 'after-revive')
      const page = await hostd.dispatch(request('events.read', {
        sessionId: 'codex-revive', afterSeq: 0, generation: attached.generation,
      })) as unknown as RemoteJournalPage
      expect(JSON.stringify(page.events)).toContain('codex reply')
      expect(JSON.stringify(page.events)).toContain('"reopenedWith":"session/load"')

      // The Harness acp profile deliberately implements no `session/load`, so a
      // revived hold must reopen the named session through `session/resume`.
      const dshStarted = await hostd.dispatch(request('session.start', {
        sessionId: 'dsh-revive', backend: 'dsh', cwd: project,
      })) as unknown as { generation: string; nativeSessionId?: string }
      expect(dshStarted.nativeSessionId).toBeTypeOf('string')
      await killBackends(root)
      const dshAttached = await hostd.dispatch(request('session.attach', { sessionId: 'dsh-revive' })) as unknown as {
        generation: string
        nativeSessionId?: string
      }
      expect(dshAttached.generation).toBe(dshStarted.generation)
      expect(dshAttached.nativeSessionId).toBe(dshStarted.nativeSessionId)
      const dshPage = await hostd.dispatch(request('events.read', {
        sessionId: 'dsh-revive', afterSeq: 0, generation: dshAttached.generation,
      })) as unknown as RemoteJournalPage
      expect(JSON.stringify(dshPage.events)).toContain('"reopenedWith":"session/resume"')
      expect(JSON.stringify(dshPage.events)).not.toContain('"reopenedWith":"session/load"')
    } finally {
      await hostd.close()
      await killBackends(root)
    }
  })

  it('reports session.start sub-stages through the dispatch progress sink', async () => {
    vi.stubEnv('GROK_AGENT_SECRET', 'host-only-grok-secret')
    vi.stubEnv('CODEX_API_KEY', 'host-only-codex-key')
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-hostd-stages-'))
    roots.push(root)
    const project = await mkdtemp(join(tmpdir(), 'threadharbor-hostd-project-'))
    roots.push(project)
    const grok = await listenLoopback()
    
    const hostd = new RemoteAgentHostd(hostdOptions(root))
    await hostd.start()
    try {
      const stages: Array<{ stage: string; sessionId: string }> = []
      await hostd.dispatch(
        request('session.start', { sessionId: 'stage-session', backend: 'codex', cwd: project }),
        (stage, sessionId) => { stages.push({ stage, sessionId }) },
      )
      expect(stages.map(entry => entry.stage)).toEqual(['spawn-hold', 'initialize-agent', 'bind-session'])
      expect(stages.every(entry => entry.sessionId === 'stage-session')).toBe(true)
    } finally {
      await hostd.close()
      await killBackends(root)
    }
  })

  it('force-restarts a hold on confirmed session.restart and refuses without confirm', async () => {
    vi.stubEnv('GROK_AGENT_SECRET', 'host-only-grok-secret')
    vi.stubEnv('CODEX_API_KEY', 'host-only-codex-key')
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-hostd-force-'))
    roots.push(root)
    const project = await mkdtemp(join(tmpdir(), 'threadharbor-hostd-force-cwd-'))
    roots.push(project)
    
    const hostd = new RemoteAgentHostd(hostdOptions(root))
    await hostd.start()
    try {
      const started = await hostd.dispatch(request('session.start', {
        sessionId: 'force-session', backend: 'codex', cwd: project,
      })) as unknown as { generation: string }
      // The destructive kill must be user-confirmed.
      await expect(hostd.dispatch(request('session.restart', { sessionId: 'force-session' })))
        .rejects.toThrow(/confirm: true/)
      const restarted = await hostd.dispatch(request('session.restart', {
        sessionId: 'force-session', confirm: true,
      })) as unknown as { generation: string; holdId: string; nativeSessionId?: string }
      expect(restarted.generation).toBe(started.generation)
      // The session keeps one unbroken transcript across the restart.
      const page = await hostd.dispatch(request('events.read', {
        sessionId: 'force-session', afterSeq: 0, generation: restarted.generation,
      })) as unknown as RemoteJournalPage
      expect(page.gap).toBe(false)
    } finally {
      await hostd.close()
      await killBackends(root)
    }
  })

  it('releases a hold on session.release: worker stops, directory and record go away', async () => {
    vi.stubEnv('GROK_AGENT_SECRET', 'host-only-grok-secret')
    vi.stubEnv('CODEX_API_KEY', 'host-only-codex-key')
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-hostd-release-'))
    roots.push(root)
    const project = await mkdtemp(join(tmpdir(), 'threadharbor-hostd-release-cwd-'))
    roots.push(project)
    
    const hostd = new RemoteAgentHostd(hostdOptions(root))
    await hostd.start()
    try {
      const started = await hostd.dispatch(request('session.start', {
        sessionId: 'release-session', backend: 'codex', cwd: project,
      })) as unknown as { holdId: string; generation: string }
      const holdDir = join(root, 'holds', started.holdId)
      // The Agent really ran, so the session has a live transcript on disk.
      expect(await readdir(holdDir)).toContain('journal.jsonl')
      const backendPid = Number.parseInt((await readFile(pidFile(root, 'codex'), 'utf8')).trim(), 10)
      expect(await waitForPidExit(backendPid, 1)).toBe(false)

      const released = await hostd.dispatch(
        request('session.release', { sessionId: 'release-session' }),
      ) as unknown as { released: boolean; holdId: string; hadSlot: boolean }
      expect(released).toMatchObject({ released: true, holdId: started.holdId, hadSlot: true })

      // It was the only session on that Agent, so the shared connection goes
      // with it and its process is really gone, not merely forgotten.
      await expect(waitForPidExit(backendPid)).resolves.toBe(true)
      // Runtime files and the persisted record are gone too, so a restart of
      // hostd cannot resurrect the hold.
      await expect(readdir(holdDir)).rejects.toThrow()
      const sessions = JSON.parse(await readFile(join(root, 'sessions.json'), 'utf8')) as {
        sessions: { sessionId: string }[]
      }
      expect(sessions.sessions.map(entry => entry.sessionId)).not.toContain('release-session')
      // And attaching again reports the session as unknown (the gateway then
      // recreates it on demand instead of silently reusing a released worker).
      await expect(hostd.dispatch(request('session.attach', { sessionId: 'release-session' })))
        .rejects.toThrow()
      // Release is idempotent: a retry is a clean "unknown session", not a crash.
      await expect(hostd.dispatch(request('session.release', { sessionId: 'release-session' })))
        .rejects.toThrow()
    } finally {
      await hostd.close()
      await killBackends(root)
    }
  })

  it('reaps a session that has been idle past the budget and keeps a subscribed one', async () => {
    vi.stubEnv('GROK_AGENT_SECRET', 'host-only-grok-secret')
    vi.stubEnv('CODEX_API_KEY', 'host-only-codex-key')
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-hostd-reap-'))
    roots.push(root)
    const project = await mkdtemp(join(tmpdir(), 'threadharbor-hostd-reap-cwd-'))
    roots.push(project)

    // A real idle budget, so a freshly started session is not already reaped.
    const hostd = new RemoteAgentHostd(hostdOptions(root, { holdIdleTimeoutMs: 100 }))
    await hostd.start()
    try {
      const started = await hostd.dispatch(request('session.start', {
        sessionId: 'reap-session', backend: 'codex', cwd: project,
      })) as unknown as { holdId: string }
      // Freshly attached: the first pass must leave it alone.
      await hostd.reapIdleHoldsForTesting()
      expect(await readdir(join(root, 'holds', started.holdId))).toContain('journal.jsonl')

      await new Promise(resolveWait => setTimeout(resolveWait, 120))
      await hostd.reapIdleHoldsForTesting()
      await expect(readdir(join(root, 'holds', started.holdId))).rejects.toThrow()
    } finally {
      await hostd.close()
      await killBackends(root)
    }
  })

  it('adopts a second hostd session onto the same Agent session, each with its own transcript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-hostd-adopt-'))
    roots.push(root)
    const project = await mkdtemp(join(tmpdir(), 'threadharbor-hostd-adopt-cwd-'))
    roots.push(project)
    const hostd = new RemoteAgentHostd(hostdOptions(root))
    await hostd.start()
    try {
      const parent = await hostd.dispatch(request('session.start', {
        sessionId: 'adopt-parent', backend: 'codex', cwd: project,
      })) as unknown as { holdId: string; generation: string; nativeSessionId: string }
      const child = await hostd.dispatch(request('session.adopt', {
        parentSessionId: 'adopt-parent',
        childSessionId: 'adopt-child',
        nativeSessionId: parent.nativeSessionId,
      })) as unknown as { holdId: string; generation: string; nativeSessionId: string }

      // The child is a session, not a second view through the parent's journal:
      // its own slot, its own sequence space, its own directory.
      expect(child.holdId).not.toBe(parent.holdId)
      expect(child.nativeSessionId).toBe(parent.nativeSessionId)
      const holds = await readdir(join(root, 'holds'))
      expect(holds.sort()).toEqual([parent.holdId, child.holdId].sort())

      // One Agent session, one connection: the child's prompt is answered by the
      // same backend, and both journals see the answer because both are bound
      // to that Agent session.
      await hostd.dispatch(request('session.prompt', {
        sessionId: 'adopt-child',
        admission: {
          clientId: 'browser', requestId: 'adopt-prompt',
          frame: {
            jsonrpc: '2.0', id: 'adopt-prompt', method: 'session/prompt',
            params: { sessionId: parent.nativeSessionId, prompt: [{ type: 'text', text: 'hi' }] },
          },
        },
      }))
      await waitForTurn(hostd, 'adopt-child', 'adopt-prompt')
      // Streamed chunks are coalesced before they are journaled, so give the
      // flush window a moment before reading either transcript.
      await new Promise(resolveWait => setTimeout(resolveWait, 300))
      for (const sessionId of ['adopt-parent', 'adopt-child']) {
        const page = await hostd.dispatch(request('events.read', {
          sessionId, afterSeq: 0, generation: (await generationOf(hostd, sessionId)),
        })) as unknown as RemoteJournalPage
        expect(JSON.stringify(page.events), sessionId).toContain('codex reply')
      }

      // Releasing the child leaves the parent's session and the shared Agent alone.
      await hostd.dispatch(request('session.release', { sessionId: 'adopt-child' }))
      expect(await readdir(join(root, 'holds'))).toContain(parent.holdId)
      const stillThere = await hostd.dispatch(
        request('session.attach', { sessionId: 'adopt-parent' }),
      ) as unknown as { nativeSessionId: string }
      expect(stillThere.nativeSessionId).toBe(parent.nativeSessionId)
    } finally {
      await hostd.close()
      await killBackends(root)
    }
  })

  it('rebuilds the context from the conversation when the Agent cannot reopen its session', { timeout: 30_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-hostd-seed-'))
    roots.push(root)
    const project = await mkdtemp(join(tmpdir(), 'threadharbor-hostd-seed-cwd-'))
    roots.push(project)
    const reject = join(root, 'reject-reopen')
    const promptLog = join(root, 'prompts.jsonl')
    // The fake Agent inherits hostd's environment, so this is how the test learns
    // what the model was actually handed.
    const previousPromptLog = process.env['FAKE_ACP_PROMPT_LOG']
    process.env['FAKE_ACP_PROMPT_LOG'] = promptLog
    const hostd = new RemoteAgentHostd(hostdOptions(root, {
      codexArgs: [fakeAgent, 'codex', pidFile(root, 'codex'), reject],
    }))
    await hostd.start()
    try {
      await hostd.dispatch(request('session.start', {
        sessionId: 'seed-session', backend: 'codex', cwd: project,
      }))
      // The Agent comes back with no memory of that session.
      await killBackends(root)
      await writeFile(reject, '')

      // Without context text there is nothing honest to do but fail.
      await expect(hostd.dispatch(request('session.attach', { sessionId: 'seed-session' })))
        .rejects.toThrow(/could not reopen session/)

      // With it, the conversation is handed over instead of lost.
      const attached = await hostd.dispatch(request('session.attach', {
        sessionId: 'seed-session',
        context: { transcript: '用户：项目结构是什么样的？\n\n助手：这是多智能体协作项目。' },
      })) as unknown as { contextSource: string; nativeSessionId: string; holdId: string }
      expect(attached.contextSource).toBe('reconstructed')

      // And the model really received it: what the Agent was asked is in its
      // own prompt log, not the journal (the journal only holds what comes back).
      await new Promise(resolveWait => setTimeout(resolveWait, 400))
      const asked = readFileSync(promptLog, 'utf8')
      expect(asked).toContain('重开')
      expect(asked).toContain('项目结构是什么样的')
    } finally {
      await hostd.close()
      await killBackends(root)
      if (previousPromptLog === undefined) delete process.env['FAKE_ACP_PROMPT_LOG']
      else process.env['FAKE_ACP_PROMPT_LOG'] = previousPromptLog
    }
  })

  it('fails an attach loudly when the Agent cannot reopen its session, instead of quietly starting blank', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-hostd-reopen-'))
    roots.push(root)
    const project = await mkdtemp(join(tmpdir(), 'threadharbor-hostd-reopen-cwd-'))
    roots.push(project)
    const hostd = new RemoteAgentHostd(hostdOptions(root))
    await hostd.start()
    try {
      const started = await hostd.dispatch(request('session.start', {
        sessionId: 'reopen-session', backend: 'codex', cwd: project,
      })) as unknown as { generation: string; nativeSessionId: string }
      // The Agent comes back with no memory of that session, which is what a
      // wiped or never-persisted Agent looks like.
      await killBackends(root)
      await writeFile(join(root, 'reject-reopen'), '')
      const revived = new RemoteAgentHostd(hostdOptions(root, {
        codexArgs: [fakeAgent, 'codex', pidFile(root, 'codex'), join(root, 'reject-reopen')],
      }))
      await revived.start()
      try {
        // Silently opening a fresh session would show the user their full history
        // next to replies from an agent that has forgotten all of it.
        await expect(revived.dispatch(request('session.attach', { sessionId: 'reopen-session' })))
          .rejects.toThrow(/could not reopen session/)
        expect(started.nativeSessionId).toBeTypeOf('string')
      } finally {
        await revived.close()
      }
    } finally {
      await hostd.close()
      await killBackends(root)
    }
  })

  it('keeps a session bound across a session-named frame like a model switch', { timeout: 30_000 }, async () => {
    // A config switch is just an outbound frame naming the session. Recording
    // that name must not make hostd forget the slot is already bound: the next
    // prompt would otherwise try to reopen a session the Agent still holds.
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-hostd-config-'))
    roots.push(root)
    const project = await mkdtemp(join(tmpdir(), 'threadharbor-hostd-config-cwd-'))
    roots.push(project)
    const hostd = new RemoteAgentHostd(hostdOptions(root))
    await hostd.start()
    try {
      const started = await hostd.dispatch(request('session.start', {
        sessionId: 'config-session', backend: 'dsh', cwd: project,
      })) as unknown as { nativeSessionId: string }
      await hostd.dispatch(request('session.native', {
        sessionId: 'config-session',
        frame: {
          jsonrpc: '2.0', id: 'config-switch', method: 'session/set_model',
          params: { sessionId: started.nativeSessionId, modelId: 'GLM-5.3' },
        },
      }))
      const rpcId = 'after-config-turn'
      await hostd.dispatch(request('session.prompt', {
        sessionId: 'config-session',
        admission: {
          clientId: 'browser', requestId: rpcId,
          frame: {
            jsonrpc: '2.0', id: rpcId, method: 'session/prompt',
            params: { sessionId: started.nativeSessionId, prompt: [{ type: 'text', text: 'hello' }] },
          },
        },
      }))
      await waitForTurn(hostd, 'config-session', rpcId)
      // The Agent never lost the session, so nothing may have tried to reopen it.
      const reopens = await readFile(`${pidFile(root, 'dsh')}.reopen`, 'utf8').catch(() => '')
      expect(reopens).toBe('')
    } finally {
      await hostd.close()
      await killBackends(root)
    }
  })

  it('treats an already-active session as live instead of failing the next turn', { timeout: 30_000 }, async () => {
    // dsh-acp refuses to activate a session it already holds ("session is
    // already active"). That is proof the session is alive, not a dead end:
    // the turn must go through and the binding must be kept, never rebuilt.
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-hostd-active-'))
    roots.push(root)
    const project = await mkdtemp(join(tmpdir(), 'threadharbor-hostd-active-cwd-'))
    roots.push(project)
    const reject = join(root, 'reject-reopen')
    const hostd = new RemoteAgentHostd(hostdOptions(root, {
      dshArgs: [fakeAgent, 'dsh', pidFile(root, 'dsh'), reject],
    }))
    await hostd.start()
    try {
      const started = await hostd.dispatch(request('session.start', {
        sessionId: 'active-session', backend: 'dsh', cwd: project,
      })) as unknown as { nativeSessionId: string }
      // A restart drops the in-process binding (the prompt path will want to
      // re-establish it) while the Agent goes on holding the session.
      await hostd.dispatch(request('session.restart', { sessionId: 'active-session', confirm: true }))
      await writeFile(reject, 'already-active')
      const rpcId = 'already-active-turn'
      await hostd.dispatch(request('session.prompt', {
        sessionId: 'active-session',
        admission: {
          clientId: 'browser', requestId: rpcId,
          frame: {
            jsonrpc: '2.0', id: rpcId, method: 'session/prompt',
            params: { sessionId: started.nativeSessionId, prompt: [{ type: 'text', text: 'hello' }] },
          },
        },
      }))
      const page = await waitForTurn(hostd, 'active-session', rpcId)
      const response = page.events.find(event => {
        const frame = event.frame as { id?: unknown }
        return frame.id === rpcId
      })?.frame as { error?: { message?: string } } | undefined
      expect(response?.error?.message ?? '').not.toContain('could not reopen session')
      // The session was never lost, so its identity survives the turn.
      const attached = await hostd.dispatch(request('session.attach', {
        sessionId: 'active-session',
      })) as unknown as { nativeSessionId?: string }
      expect(attached.nativeSessionId).toBe(started.nativeSessionId)
    } finally {
      await hostd.close()
      await killBackends(root)
    }
  })

  it('binds a session from the prompt itself when nothing ever attached it', { timeout: 30_000 }, async () => {
    // The gateway can still believe a session is open after hostd restarts, so
    // a prompt can arrive for a session this process has never bound. Forwarding
    // it anyway meant the Agent rejected it on arrival: the user saw a failed
    // turn and a file on disk said the session was perfectly intact.
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-hostd-promptbind-'))
    roots.push(root)
    const project = await mkdtemp(join(tmpdir(), 'threadharbor-hostd-promptbind-cwd-'))
    roots.push(project)
    for (const sessionId of ['warmup', 'never-attached']) {
      const opening = new RemoteAgentHostd(hostdOptions(root))
      await opening.start()
      try {
        await opening.dispatch(request('session.start', { sessionId, backend: 'codex', cwd: project }))
      } finally {
        await opening.close()
      }
    }
    // Somebody else opens a session on the same backend, which is what revives
    // the shared connection and leaves this one holding a slot it never filled.
    const hostd = new RemoteAgentHostd(hostdOptions(root))
    await hostd.start()
    try {
      await hostd.dispatch(request('session.attach', { sessionId: 'warmup' }))
      const rpcId = 'never-attached-turn'
      // No attach for this session at all: the prompt has to bind it.
      await hostd.dispatch(request('session.prompt', {
        sessionId: 'never-attached',
        admission: {
          clientId: 'browser', requestId: rpcId,
          frame: {
            jsonrpc: '2.0', id: rpcId, method: 'session/prompt',
            params: { sessionId: 'codex-native-2', prompt: [{ type: 'text', text: 'hello' }] },
          },
        },
      }))
      const page = await waitForTurn(hostd, 'never-attached', rpcId)
      const response = page.events.find(event => {
        const frame = event.frame as { id?: unknown }
        return frame.id === rpcId
      })?.frame as { error?: { message?: string } } | undefined
      expect(response?.error?.message ?? '').not.toContain('unknown session')
    } finally {
      await hostd.close()
      await killBackends(root)
    }
  })

  it('binds a sibling session left behind by a revive, not just the one being opened', { timeout: 30_000 }, async () => {
    // The bug this pins: one connection serves every session of a backend, so
    // reviving it opens a slot for each — but only the session being attached
    // was ever named to the Agent. The sibling looked alive, accepted prompts,
    // and had them rejected on arrival while the UI reported a turn in progress.
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-hostd-sibling-'))
    roots.push(root)
    const project = await mkdtemp(join(tmpdir(), 'threadharbor-hostd-sibling-cwd-'))
    roots.push(project)
    for (const sessionId of ['sibling-first', 'sibling-second']) {
      const opening = new RemoteAgentHostd(hostdOptions(root))
      await opening.start()
      try {
        await opening.dispatch(request('session.start', { sessionId, backend: 'codex', cwd: project }))
      } finally {
        await opening.close()
      }
    }
    // Both records exist; nothing is alive, and no pid file is lying about it.
    const hostd = new RemoteAgentHostd(hostdOptions(root))
    await hostd.start()
    try {
      // Opening the first is what revives the connection, and with it a slot
      // for the second.
      await hostd.dispatch(request('session.attach', { sessionId: 'sibling-first' }))
      const attached = await hostd.dispatch(request('session.attach', { sessionId: 'sibling-second' })) as unknown as {
        contextSource?: string; nativeSessionId?: string
      }
      expect(attached.contextSource).toBe('resumed')
      const rpcId = 'sibling-turn'
      await hostd.dispatch(request('session.prompt', {
        sessionId: 'sibling-second',
        admission: {
          clientId: 'browser', requestId: rpcId,
          frame: {
            jsonrpc: '2.0', id: rpcId, method: 'session/prompt',
            params: {
              sessionId: attached.nativeSessionId ?? 'sibling-second',
              prompt: [{ type: 'text', text: 'hello' }],
            },
          },
        },
      }))
      const page = await waitForTurn(hostd, 'sibling-second', rpcId)
      const response = page.events.find(event => {
        const frame = event.frame as { id?: unknown }
        return frame.id === rpcId
      })?.frame as { error?: { message?: string } } | undefined
      expect(response?.error?.message ?? '').not.toContain('unknown session')
    } finally {
      await hostd.close()
      await killBackends(root)
    }
  })

  it('leaves no Agent running after close, so a later run can still reopen its sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-hostd-shutdown-'))
    roots.push(root)
    const project = await mkdtemp(join(tmpdir(), 'threadharbor-hostd-shutdown-cwd-'))
    roots.push(project)
    const hostd = new RemoteAgentHostd(hostdOptions(root))
    await hostd.start()
    await hostd.dispatch(request('session.start', {
      sessionId: 'shutdown-session', backend: 'codex', cwd: project,
    }))
    const backendPid = Number.parseInt((await readFile(pidFile(root, 'codex'), 'utf8')).trim(), 10)
    expect(await waitForPidExit(backendPid, 1)).toBe(false)

    await hostd.close()
    // An Agent that outlives hostd keeps a write handle on its session store,
    // and every later hostd is then refused when it tries to reopen one. The
    // port freeing is not proof of a clean stop: the listener closes long before
    // the agents do.
    expect(await waitForPidExit(backendPid)).toBe(true)
  })
})
