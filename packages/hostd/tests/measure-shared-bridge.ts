/** Live check: N real sessions on ONE real DSH backend, through the real hostd.
 *
 *  This is the measurement that justified moving the Agent in-process: it counts
 *  the processes and the memory the same N sessions cost now, so the numbers can
 *  be compared with the one-per-session hold worker they replaced.
 *
 *  Run with:
 *    node --import tsx/esm packages/hostd/tests/measure-shared-bridge.ts 5
 */
import { execFileSync } from 'node:child_process'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteAgentHostd, type HostdOptions } from '../src/server.ts'

const SESSIONS = Number(process.argv[2] ?? 5)
const DSH = '/Users/good/.local/share/node-v24.18.1-darwin-arm64/bin/dsh'

const root = await mkdtemp(join(tmpdir(), 'th-measure-'))
const project = await mkdtemp(join(tmpdir(), 'th-measure-cwd-'))

const options: HostdOptions = {
  host: '127.0.0.1', port: 0, dataDir: root,
  maxRequestBytes: 1024 * 1024, operationTimeoutMs: 30_000, workerStartupTimeoutMs: 30_000,
  maxJournalEvents: 2_000, maxJournalBytes: 8_000_000, maxDirectoryEntries: 100,
  authTimeoutMs: 1_000, installTimeoutMs: 1_000, promptTimeoutMs: 600_000, holdIdleTimeoutMs: 0,
  agentConfigHome: root, maxAgentConfigBytes: 4096,
  codexCliCommand: 'codex',
  codexCommand: 'codex-acp', codexArgs: [],
  claudeCommand: 'claude', claudeAcpCommand: 'claude-agent-acp', claudeAcpArgs: [],
  dshCommand: DSH, dshArgs: ['--profile', 'acp'],
  grokCommand: 'grok', grokServeHost: '127.0.0.1', grokServePort: 65_499, grokArgs: [],
  hostdHttpFallback: false,
}

const hostd = new RemoteAgentHostd(options)
await hostd.start()

function rssMb(pid: number): number {
  const bytes = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)]).toString().trim())
  return Math.round(bytes / 1024)
}

/** Every dsh process on this machine, which is the whole point of the change. */
function backendPids(): number[] {
  const out = execFileSync('pgrep', ['-f', 'profile acp']).toString()
  return out.split('\n').map(line => line.trim()).filter(line => line !== '').map(Number)
}

console.log(`opening ${SESSIONS} sessions on one shared DSH connection`)
const startedAt = Date.now()
for (let index = 0; index < SESSIONS; index += 1) {
  const sessionId = `measure-${index}`
  const began = Date.now()
  const attached = await hostd.dispatch({
    id: `start-${index}`, method: 'session.start',
    params: { sessionId, backend: 'dsh', cwd: project },
  }) as unknown as { holdId: string; nativeSessionId?: string }
  console.log(`  ${sessionId} ready in ${Date.now() - began}ms (native ${attached.nativeSessionId ?? '-'})`)
}
console.log(`all ${SESSIONS} sessions ready in ${Date.now() - startedAt}ms`)

const pids = backendPids()
const total = pids.reduce((sum, pid) => sum + rssMb(pid), 0)
console.log(`\ndsh processes: ${pids.length} (${pids.join(', ')})`)
console.log(`dsh resident memory: ${total} MB total`)
console.log(`hold directories: ${(await readdir(join(root, 'holds'))).length}`)

/** The Agent session id hostd bound for one measured session. */
async function nativeOf(index: number): Promise<string> {
  const attached = await hostd.dispatch({
    id: `attach-${index}`, method: 'session.attach', params: { sessionId: `measure-${index}` },
  }) as unknown as { nativeSessionId?: string }
  return attached.nativeSessionId ?? `measure-${index}`
}

const nativeIds: string[] = []
for (let index = 0; index < SESSIONS; index += 1) nativeIds.push(await nativeOf(index))
console.log(`\nAgent sessions: ${nativeIds.join(', ')}`)

console.log('\nprompting every session at once')
const prompted = Date.now()
await Promise.all(nativeIds.map((nativeSessionId, index) => hostd.dispatch({
  id: `prompt-${index}`, method: 'session.prompt',
  params: {
    sessionId: `measure-${index}`,
    admission: {
      clientId: 'measure',
      requestId: `p${index}`,
      frame: {
        jsonrpc: '2.0', id: `p${index}`, method: 'session/prompt',
        params: {
          sessionId: nativeSessionId,
          prompt: [{ type: 'text', text: 'reply with the word ok' }],
        },
      },
    },
  },
})))
console.log(`all ${SESSIONS} prompts admitted in ${Date.now() - prompted}ms`)

// Watch each session's journal until its own turn completes.
const deadline = Date.now() + 240_000
let answered = 0
while (answered < SESSIONS && Date.now() < deadline) {
  answered = 0
  for (let index = 0; index < SESSIONS; index += 1) {
    const page = await hostd.dispatch({
      id: `read-${index}`, method: 'events.read',
      params: { sessionId: `measure-${index}`, afterSeq: 0 },
    }) as unknown as { events: Array<{ frame: { method?: string } }> }
    if (page.events.some(event => event.frame.method === '_x.ai/session/prompt_complete')) answered += 1
  }
  if (answered < SESSIONS) await new Promise(resolve => setTimeout(resolve, 500))
}
console.log(`turns completed: ${answered}/${SESSIONS}`)

const after = backendPids()
const afterTotal = after.reduce((sum, pid) => sum + rssMb(pid), 0)
console.log(`\nafter ${SESSIONS} turns: ${after.length} dsh process(es), ${afterTotal} MB`)
console.log(`per-session marginal cost: ${Math.round((afterTotal - total) / SESSIONS)} MB`)

await hostd.close()
process.exit(0)
