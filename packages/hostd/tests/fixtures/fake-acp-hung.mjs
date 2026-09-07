import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const output = process.argv[2]
if (output === undefined) throw new Error('fake-acp-hung requires an output path')

const reader = createInterface({ input: process.stdin })
reader.on('line', (line) => {
  const frame = JSON.parse(line)
  if (frame.method !== 'session/prompt') return
  appendFileSync(output, `${String(frame.id)}\n`)
  // Intentionally never write a response or completion frame.
})