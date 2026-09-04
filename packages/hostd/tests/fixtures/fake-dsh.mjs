import { appendFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const pidFile = process.argv[2]
const output = process.argv[3]
if (pidFile === undefined || output === undefined) throw new Error('fake-dsh requires pid and output paths')

writeFileSync(pidFile, `${process.pid}\n`)
let initialized = false

const reader = createInterface({ input: process.stdin })
reader.on('line', (line) => {
  const frame = JSON.parse(line)
  const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
  if (frame.method === 'initialize') {
    if (initialized) {
      write({ jsonrpc: '2.0', id: frame.id, error: { code: -32603, message: 'reinitialization is unsupported' } })
      return
    }
    initialized = true
    write({ jsonrpc: '2.0', id: frame.id, result: { serverInfo: { name: 'fake-dsh', version: '0' } } })
    return
  }
  if (frame.method === 'session/prompt') {
    appendFileSync(output, `prompt:${String(frame.id)}:${process.pid}\n`)
    write({ jsonrpc: '2.0', id: frame.id, result: { messageId: frame.id } })
    write({
      jsonrpc: '2.0', method: 'session.status',
      params: { sessionId: frame.params?.sessionId ?? 'native', status: 'running' },
    })
    return
  }
  if (frame.method === 'session/cancel') {
    appendFileSync(output, `cancel-ignored:${process.pid}\n`)
  }
})
