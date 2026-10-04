import { appendFileSync, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'

/** A multi-session ACP agent double.
 *
 *  Unlike `fake-acp.mjs`, this one can multiplex: each `session/new` mints its
 *  own native id and every notification it emits is tagged with that id, so a
 *  bridge that shares one backend across sessions can be held to the promise
 *  that frames reach the right session and only that session. Prompt *responses*
 *  are gated (argv[3]) so a test can keep several turns outstanding at once and
 *  observe that they interleave instead of serializing.
 *
 *  argv[2] = event log path, argv[3] = gate path, argv[4] = chunks per prompt
 *
 *  Env switches let a test drive the awkward Agents:
 *    FAKE_ACP_ERROR      answer the prompt with a JSON-RPC error instead of a result
 *    FAKE_ACP_PERMISSION raise a permission request and hold the turn until it is answered
 *    FAKE_ACP_SILENT     never answer the prompt at all
 */

const output = process.argv[2]
const gate = process.argv[3]
const chunkCount = Number(process.argv[4] ?? 2)
if (output === undefined || gate === undefined) throw new Error('fake-acp-multi requires output and gate paths')

const log = (line) => appendFileSync(output, `${line}\n`)
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)

let initialized = 0
let sessionCounter = 0
/** The rpcId of a permission request we raised and are still waiting on. */
let pendingPermission = null
/** How to finish the turn that is parked on that permission request. */
let finishParkedTurn = null

const reader = createInterface({ input: process.stdin })
reader.on('line', (line) => {
  const frame = JSON.parse(line)
  const id = frame.id
  // The client answered our permission request: acknowledge it and release the
  // turn it was blocking.
  if (pendingPermission !== null && id === pendingPermission && frame.method === undefined) {
    log(`permission-answered:${id}`)
    write({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'selected', optionId: 'once' } } })
    const finish = finishParkedTurn
    pendingPermission = null
    finishParkedTurn = null
    if (finish !== null && existsSync(gate)) finish()
    return
  }
  if (frame.method === 'initialize') {
    initialized += 1
    log(`initialize:${initialized}`)
    write({ jsonrpc: '2.0', id, result: { protocolVersion: 1, agentCapabilities: {} } })
    return
  }
  if (frame.method === 'session/new') {
    sessionCounter += 1
    const sessionId = `native-${sessionCounter}`
    log(`session/new:${sessionId}`)
    write({ jsonrpc: '2.0', id, result: { sessionId } })
    return
  }
  if (frame.method === 'session/load' || frame.method === 'session/resume') {
    log(`${frame.method}:${frame.params?.sessionId}`)
    write({ jsonrpc: '2.0', id, result: { modes: null, configOptions: null, models: null } })
    return
  }
  if (frame.method !== 'session/prompt') return
  const sessionId = frame.params?.sessionId
  log(`prompt:${id}:${sessionId}`)
  // Stream immediately: two sessions prompting at once must both make progress
  // before either turn completes.
  for (let index = 0; index < chunkCount; index += 1) {
    write({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `${sessionId}:${index} ` },
        },
      },
    })
  }
  const complete = () => {
    log(`complete:${id}:${sessionId}`)
    if (process.env['FAKE_ACP_ERROR'] === '1') {
      write({ jsonrpc: '2.0', id, error: { code: -32000, message: 'model unavailable' } })
      return
    }
    write({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })
  }
  if (process.env['FAKE_ACP_SILENT'] === '1') return
  if (process.env['FAKE_ACP_PERMISSION'] === '1') {
    // Park the turn: a permission request is a question the client has to
    // answer, and nothing else may be emitted until it does.
    pendingPermission = 900
    finishParkedTurn = complete
    write({
      jsonrpc: '2.0', id: 900, method: 'session/request_permission',
      params: { sessionId, title: 'Allow read?', options: [{ optionId: 'once', name: 'Allow once' }] },
    })
    return
  }
  if (existsSync(gate)) complete()
  else {
    const timer = setInterval(() => {
      if (!existsSync(gate)) return
      clearInterval(timer)
      complete()
    }, 5)
  }
})
