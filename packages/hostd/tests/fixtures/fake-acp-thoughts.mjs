import { createInterface } from 'node:readline'

const reader = createInterface({ input: process.stdin })
reader.on('line', (line) => {
  const frame = JSON.parse(line)
  if (frame.method !== 'session/prompt') return
  const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
  for (const text of ['The ', 'user ', 'wants ', 'to ', 'add ', 'outline']) {
    write({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'native',
        update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } },
      },
    })
  }
})
