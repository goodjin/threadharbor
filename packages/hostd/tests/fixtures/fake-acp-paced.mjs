// Fake ACP agent for prompt idle-guard tests. Modes (argv[3]):
//   stream     — emit a session/update every 40ms for ~300ms, then respond.
//   permission — emit a session/request_permission at once, wait for the answer
//                (however long that takes), then respond 60ms later.
//   late       — stay silent for 300ms, then respond (a turn that merely took long).
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const output = process.argv[2]
const mode = process.argv[3] ?? 'stream'
if (output === undefined) throw new Error('fake-acp-paced requires an output path')

const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const pending = new Map()

const reader = createInterface({ input: process.stdin })
reader.on('line', (line) => {
  const frame = JSON.parse(line)
  if (frame.method === undefined && pending.has(String(frame.id))) {
    // The answer to our permission request: finish the turn shortly after.
    const promptId = pending.get(String(frame.id))
    pending.delete(String(frame.id))
    setTimeout(() => write({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } }), 60)
    return
  }
  if (frame.method !== 'session/prompt') return
  appendFileSync(output, `${String(frame.id)}\n`)
  const update = (text) => write({
    jsonrpc: '2.0', method: 'session/update',
    params: { sessionId: 'native', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
  })
  if (mode === 'stream') {
    let ticks = 0
    const timer = setInterval(() => {
      ticks += 1
      update(`chunk ${ticks} `)
      if (ticks >= 8) {
        clearInterval(timer)
        write({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
      }
    }, 40)
    return
  }
  if (mode === 'permission') {
    pending.set('perm-1', frame.id)
    write({ jsonrpc: '2.0', id: 'perm-1', method: 'session/request_permission', params: {
      sessionId: 'native', toolCall: { title: 'rm -rf build' },
      options: [{ kind: 'reject_once', name: 'Deny', optionId: 'reject' }, { kind: 'allow_once', name: 'Allow', optionId: 'allow' }],
    } })
    return
  }
  // late
  setTimeout(() => write({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } }), 300)
})
