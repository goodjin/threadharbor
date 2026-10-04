import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

/** A stdio ACP Agent backend double.
 *
 *  This replaced `fake-hold-worker.mjs` when the hold worker became an in-process
 *  bridge: hostd no longer spawns a worker per session, it spawns one Agent per
 *  backend kind and multiplexes sessions over it. So the double has to behave
 *  like an *Agent* — handshake, many sessions, streaming turns — rather than like
 *  a per-session worker.
 *
 *  argv[2] = backend name ('grok' | 'codex' | 'claude' | 'dsh')
 *  argv[3] = pid file, so a test can kill the backend to simulate a crash
 */

const backend = process.argv[2] ?? 'dsh'
const pidFile = process.argv[3]
/** When this file exists, reopening a session is refused, as a wiped Agent would. */
const rejectReopen = process.argv[4]
if (pidFile !== undefined) writeFileSync(pidFile, `${process.pid}\n`)

let sessionCounter = 0
const reopenLog = pidFile === undefined ? undefined : `${pidFile}.reopen`

const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)

const reader = createInterface({ input: process.stdin })
reader.on('line', (line) => {
  const frame = JSON.parse(line)
  const id = frame.id
  if (frame.method === 'initialize') {
    write({ jsonrpc: '2.0', id, result: { protocolVersion: 1, agentCapabilities: {} } })
    return
  }
  if (frame.method === 'session/load' || frame.method === 'session/resume') {
    if (rejectReopen !== undefined && existsSync(rejectReopen)) {
      // The marker file's content picks the refusal: empty is a wiped Agent,
      // `already-active` is dsh-acp's answer when the Agent still holds the
      // session the caller asked to reopen — the session is alive, it just
      // cannot be activated a second time.
      const refusal = readFileSync(rejectReopen, 'utf8').trim()
      if (refusal === 'already-active') {
        write({
          jsonrpc: '2.0', id,
          error: {
            code: -32602,
            message: `Invalid params: session is already active: ${String(frame.params?.sessionId ?? '')}`,
          },
        })
        return
      }
      write({ jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown session' } })
      return
    }
    // Like a real ACP agent: a reopen reply carries configuration state but no
    // sessionId, because the caller named the session it wanted reopened. The
    // Harness acp profile implements `session/resume`, not the standard
    // `session/load`.
    if (reopenLog !== undefined) appendFileSync(reopenLog, `${frame.method}\n`)
    write({ jsonrpc: '2.0', id, result: { models: { currentModelId: 'fake' }, reopenedWith: frame.method } })
    return
  }
  if (frame.method === 'session/new' || frame.method === 'session/fork') {
    sessionCounter += 1
    write({ jsonrpc: '2.0', id, result: { sessionId: `${backend}-native-${sessionCounter}` } })
    return
  }
  if (frame.method !== 'session/prompt') return
  const sessionId = frame.params?.sessionId
  // Record what this Agent was actually asked, so a test can assert on what the
  // model would see. The journal only holds what comes back, so it cannot show
  // a prompt hostd sent.
  if (process.env.FAKE_ACP_PROMPT_LOG !== undefined && process.env.FAKE_ACP_PROMPT_LOG !== '') {
    appendFileSync(process.env.FAKE_ACP_PROMPT_LOG,
      `${JSON.stringify(frame.params?.prompt ?? null)}\n`)
  }
  if (backend === 'codex') {
    write({
      jsonrpc: '2.0', id: 41, method: 'session/request_permission',
      params: { sessionId, title: 'Allow read?', options: [{ optionId: 'once', name: 'Allow once' }] },
    })
  }
  // Every backend, including the Harness acp profile, streams ACP updates and
  // ends the turn with a completion frame.
  write({
    jsonrpc: '2.0', method: 'session/update', params: {
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${backend} reply` } },
    },
  })
  write({
    jsonrpc: '2.0', id, result: { stopReason: 'end_turn' },
  })
})
