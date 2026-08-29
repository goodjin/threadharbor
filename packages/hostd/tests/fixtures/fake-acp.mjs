import { appendFileSync, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'

const output = process.argv[2]
const gate = process.argv[3]
const completion = process.argv[4] ?? 'codex'
if (output === undefined || gate === undefined) throw new Error('fake-acp requires output and gate paths')

const reader = createInterface({ input: process.stdin })
reader.on('line', (line) => {
  const frame = JSON.parse(line)
  if (frame.method !== 'session/prompt') return
  appendFileSync(output, `${String(frame.id)}\n`)
  const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
  const complete = () => {
    if (completion === 'codex') {
      write({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
      return
    }
    if (completion === 'grok') {
      write({ jsonrpc: '2.0', method: '_x.ai/session/prompt_complete', params: { sessionId: 'native', stopReason: 'end_turn', source: 'fake' } })
      return
    }
    write({ jsonrpc: '2.0', method: 'session.status', params: { sessionId: 'native', status: 'idle' } })
  }
  if (completion !== 'codex') write({ jsonrpc: '2.0', id: frame.id, result: { accepted: true } })
  if (existsSync(gate)) complete()
  else {
    const timer = setInterval(() => {
      if (!existsSync(gate)) return
      clearInterval(timer)
      complete()
    }, 5)
  }
})
