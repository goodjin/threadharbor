import { chmodSync, existsSync, readFileSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:net'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('fake hold worker requires a config path')
const config = JSON.parse(readFileSync(configPath, 'utf8'))
const events = []
let nextSeq = 1

function append(frame) {
  events.push({
    seq: nextSeq++, generation: config.generation,
    timestamp: '2026-08-28T00:00:00.000Z', frame,
  })
}

function reply(socket, response) {
  socket.end(`${JSON.stringify(response)}\n`)
}

function handle(request) {
  if (request.operation === 'ping') {
    return { ok: true, result: { generation: config.generation, latestSeq: nextSeq - 1 } }
  }
  if (request.operation === 'read') {
    return {
      ok: true,
      result: {
        generation: config.generation, latestSeq: nextSeq - 1, droppedThrough: 0, gap: false,
        events: events.filter(event => event.seq > request.afterSeq),
      },
    }
  }
  if (request.operation === 'set-native-session') {
    return { ok: true, result: { nativeSessionId: request.nativeSessionId } }
  }
  if (request.operation === 'send-frame') {
    const frame = request.frame
    if (frame.method === 'initialize') append({ jsonrpc: '2.0', id: frame.id, result: { ready: true } })
    else if (frame.method === 'session/new' || frame.method === 'session/fork') {
      append({ jsonrpc: '2.0', id: frame.id, result: { sessionId: `${config.backend}-native` } })
    }
    return { ok: true, result: { accepted: true } }
  }
  if (request.operation === 'send') {
    const frame = request.admission.frame
    const sessionId = frame.params?.sessionId || `${config.backend}-native`
    if (config.backend === 'dsh') {
      append({
        jsonrpc: '2.0', method: 'session.event', params: {
          sessionId, event: { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'dsh reply' } } },
        },
      })
      append({
        jsonrpc: '2.0', method: 'session.event', params: {
          sessionId, event: { type: 'turn/end', data: { reason: { kind: 'completed' } } },
        },
      })
    } else {
      if (config.backend === 'codex') {
        append({
          jsonrpc: '2.0', id: 41, method: 'session/request_permission',
          params: { sessionId, title: 'Allow read?', options: [{ optionId: 'once', name: 'Allow once' }] },
        })
      }
      append({
        jsonrpc: '2.0', method: 'session/update', params: {
          sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${config.backend} reply` } },
        },
      })
      append({
        jsonrpc: '2.0', method: '_x.ai/session/prompt_complete',
        params: { sessionId, stopReason: 'end_turn' },
      })
    }
    return { ok: true, result: { accepted: true, duplicate: false } }
  }
  return { ok: false, error: `unsupported fake hold operation ${request.operation}` }
}

if (process.platform !== 'win32' && existsSync(config.socketPath)) unlinkSync(config.socketPath)
const server = createServer((socket) => {
  socket.setEncoding('utf8')
  let input = ''
  socket.on('data', (chunk) => {
    input += chunk
    const newline = input.indexOf('\n')
    if (newline === -1) return
    const request = JSON.parse(input.slice(0, newline))
    if (request.operation === 'wait') {
      const event = events.find(candidate => candidate.seq > request.afterSeq
        && String(candidate.frame?.id) === request.rpcId && candidate.frame?.method === undefined)
      reply(socket, event === undefined
        ? { ok: false, error: `missing fake RPC ${request.rpcId}` }
        : { ok: true, result: event.frame })
      return
    }
    if (request.operation === 'shutdown') {
      reply(socket, { ok: true, result: { stopping: true } })
      server.close(() => {
        if (process.platform !== 'win32' && existsSync(config.socketPath)) unlinkSync(config.socketPath)
        process.exit(0)
      })
      return
    }
    reply(socket, handle(request))
  })
})
server.listen(config.socketPath, () => {
  if (process.platform !== 'win32') chmodSync(config.socketPath, 0o600)
})
