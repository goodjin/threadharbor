#!/usr/bin/env node
// A scripted ZCode app-server for the adapter tests.
//
// Speaks enough of the ZCode Protocol (ndjson, no `jsonrpc` key, reverse
// requests with 15 s answers expected) to drive the adapter end to end:
// the account handshake, a session, one turn with a tool call, usage, the
// completion event, and — when FAKE_PERMISSION=1 — a permission request
// answered through the adapter's ACP side.
//
// Findings it records to $FAKE_STATUS as JSON:
//   apiKeyOk            the decrypted key matched FAKE_EXPECTED_KEY
//   sawRuntimePrefs     session/requestRuntimePreferences came and was answered
//   permissionResponse  the ZCode-side response object the adapter sent back

import { appendFileSync, writeFileSync } from 'node:fs'

const status = { apiKeyOk: false, sawRuntimePrefs: false, permissionResponse: undefined }

function send(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`)
}

function reply(id, result) {
  send({ id, result })
}

function notify(method, params) {
  send({ method, params })
}

/** The registry line the adapter parses its revision from. */
function writeRegistryLog() {
  const dir = process.env.ZCODE_ACP_LOG_DIR
  if (dir === undefined) return
  const day = new Date().toISOString().slice(0, 10)
  const line = `${JSON.stringify({
    event: 'zcode_protocol.provider_registry.ready',
    context: { configRevision: JSON.stringify(['rev-fake-1']) },
  })}\n`
  try {
    appendFileSync(`${dir}/zcode-${day}.jsonl`, line)
  } catch (error) {
    // A silent swallow here once cost an hour: the adapter retries the
    // revision parse for eight seconds and every test times out with no
    // trace. Say it on stderr instead.
    process.stderr.write(`fake-app-server: cannot write ${dir}/zcode-${day}.jsonl: ${String(error)}\n`)
  }
}

const pendingReverse = new Map()

function reverse(id, method, params) {
  return new Promise(resolve => {
    pendingReverse.set(id, resolve)
    send({ id, method, params })
  })
}

process.stdin.setEncoding('utf8')
// The registry line goes down at startup, the way the real app-server does:
// the adapter reads the revision BEFORE it sends provider/updateAccountConfig,
// so a line written only on that request would deadlock the handshake.
writeRegistryLog()
let buffer = ''
process.stdin.on('data', chunk => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (line.trim() === '') continue
    handle(JSON.parse(line))
  }
})

function handle(frame) {
  if (typeof frame.id === 'number' && frame.method === undefined) {
    const resolve = pendingReverse.get(frame.id)
    if (resolve !== undefined) {
      pendingReverse.delete(frame.id)
      resolve(frame.result ?? frame.error)
    }
    return
  }
  if (frame.method === undefined) return
  const params = frame.params ?? {}
  switch (frame.method) {
    case 'provider/updateAccountConfig': {
      reply(frame.id, { providerCount: 1 })
      return
    }
    case 'session/create': {
      reply(frame.id, { session: { sessionId: 'sess_fake_1' } })
      return
    }
    case 'session/subscribe': {
      reply(frame.id, {})
      return
    }
    case 'session/setMode': {
      reply(frame.id, {})
      return
    }
    case 'session/messages': {
      reply(frame.id, { messages: [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'fake reply (from transcript)' }] }] })
      return
    }
    case 'session/stop': {
      reply(frame.id, {})
      if (process.env.FAKE_HANG === '1') {
        // The turn the adapter cancelled: the terminal event only fires now,
        // which is how a real stop behaves.
        notify('v4/telemetry/event', { kind: 'turn.terminal', status: 'success' })
      }
      return
    }
    case 'session/send': {
      reply(frame.id, { accepted: true })
      void runTurn(params)
      return
    }
    default: {
      reply(frame.id, { code: -32601, message: `fake server has no ${frame.method}` })
    }
  }
}

async function runTurn(params) {
  const sessionId = params.sessionId
  const prefs = await reverse(900, 'session/requestRuntimePreferences', { sessionId })
  status.sawRuntimePrefs = prefs !== undefined && prefs.memoryEnabled === true

  const headers = await reverse(901, 'interaction/requestProviderRuntimeHeaders', {
    sessionId,
    reason: 'model-request',
    modelSelection: { providerId: 'account:bigmodel-individual-coding-plan', modelId: 'GLM-5.3' },
  })
  const apiKey = headers !== undefined && typeof headers === 'object' ? headers.requestAuth?.apiKey : undefined
  status.apiKeyOk = apiKey === process.env.FAKE_EXPECTED_KEY
  flushStatus()

  if (process.env.FAKE_PERMISSION === '1') {
    const response = await reverse(902, 'interaction/requestPermission', {
      sessionId,
      toolCallId: 'call_perm_1',
      toolName: 'Write',
      riskLevel: 'medium',
      reason: 'Tool has side effects',
      input: { file_path: '/tmp/fake.txt', content: 'hi\n' },
      options: [
        { kind: 'allow_once', name: 'Allow once', optionId: 'allow_once', response: { decision: 'allow', reason: 'Approved once' } },
        { kind: 'allow_always', name: 'Always allow in this project', optionId: 'allow_project', response: { decision: 'allow', permissionUpdates: [], reason: 'Approved for this project' } },
        { kind: 'deny', name: 'Deny', optionId: 'deny', response: { decision: 'deny', reason: 'The user declined' } },
      ],
    })
    status.permissionResponse = response
    flushStatus()
  }

  if (process.env.FAKE_HANG === '1') return // no terminal until session/stop

  notify('v4/telemetry/event', { kind: 'tool.lifecycle', phase: 'scheduled', sessionId, toolCallId: 'call_w1', toolName: 'Write' })
  notify('v4/telemetry/event', { kind: 'tool.lifecycle', phase: 'started', sessionId, toolCallId: 'call_w1', toolName: 'Write' })
  notify('v4/telemetry/event', { kind: 'usage.delta', sessionId, requestId: 'req_1', inputTokens: 100, outputTokens: 20, totalTokens: 120 })
  notify('v4/telemetry/event', { kind: 'tool.lifecycle', phase: 'completed', sessionId, toolCallId: 'call_w1', toolName: 'Write' })
  notify('session/event', { sessionId, payload: { content: 'fake reply', stopReason: 'stop' } })
  notify('v4/telemetry/event', { kind: 'turn.terminal', sessionId, status: 'success' })
}

function flushStatus() {
  const path = process.env.FAKE_STATUS
  if (path !== undefined) writeFileSync(path, `${JSON.stringify(status)}\n`)
}

process.stdin.resume()
