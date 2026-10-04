#!/usr/bin/env node
/** Prove the patched ACP bridge is live and that big text really gets sliced.
 *
 * Spawns `dsh --profile acp` over stdio, completes the ACP handshake, creates a
 * scratch session and (with `--prompt`) runs one real turn while recording every
 * `session/update` frame with its arrival time and length.
 *
 * Usage:
 *   node deploy/acp-stream/verify.mjs
 *   node deploy/acp-stream/verify.mjs --prompt "讲个长一点的技术问题" --seconds 300
 *   DSH_HOME=/path/to/home DSH_BIN=/path/to/dsh node deploy/acp-stream/verify.mjs
 *
 * Exit codes: 0 handshake and prompt succeeded, 1 the bridge failed,
 * 2 `--expect-sliced` was given but nothing was sliced.
 */

import { spawn } from 'node:child_process'

const argv = process.argv.slice(2)
const flag = (name) => {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}
const has = (name) => argv.includes(name)

const bin = process.env.DSH_BIN ?? 'dsh'
const seconds = Number(flag('--seconds') ?? 300)
const promptText = flag('--prompt')
const sliceThreshold = 800

const started = Date.now()
const at = () => `${((Date.now() - started) / 1000).toFixed(2)}s`
const child = spawn(bin, ['--profile', 'acp'], { env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] })

const frames = []
let stderrReport = []
let sessionId
let finished = false

const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)
const fail = (code, message) => {
  process.stderr.write(`verify: ${message}\n`)
  child.kill()
  process.exit(code)
}

child.stderr.on('data', (chunk) => {
  for (const line of chunk.toString().split('\n')) {
    if (!line.includes('threadharbor-acp-stream')) continue
    stderrReport.push(line.trim())
    process.stdout.write(`${at()} stderr ${line.trim()}\n`)
  }
})

child.stdout.on('data', (chunk) => {
  for (const line of chunk.toString().split('\n')) {
    if (line.trim() === '') continue
    let message
    try { message = JSON.parse(line) } catch { continue }

    if (message.id !== undefined) {
      if (message.error !== undefined) {
        fail(1, `request ${message.id} failed: ${JSON.stringify(message.error).slice(0, 200)}`)
      }
      if (message.id === 1) {
        process.stdout.write(`${at()} initialize ok: ${message.result.agentInfo.name}\n`)
        setTimeout(() => send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: process.cwd(), mcpServers: [] } }), 250)
      }
      if (message.id === 2) {
        sessionId = message.result.sessionId
        process.stdout.write(`${at()} session/new ok: ${sessionId}\n`)
        if (promptText === undefined) {
          finished = true
          child.kill()
          process.exit(0)
        }
        setTimeout(() => send({
          jsonrpc: '2.0', id: 3, method: 'session/prompt',
          params: { sessionId, prompt: [{ type: 'text', text: promptText }] },
        }), 200)
      }
      if (message.id === 3) {
        process.stdout.write(`${at()} turn finished: ${message.result?.stopReason ?? 'unknown'}\n`)
        finished = true
      }
      continue
    }

    const update = message.params?.update
    if (update === undefined) return
    const text = update.content?.text ?? ''
    frames.push({ at: Date.now() - started, kind: update.sessionUpdate, length: text.length })
    if (text !== '' && update.sessionUpdate !== 'usage_update') {
      process.stdout.write(`${at()} ${String(update.sessionUpdate).padEnd(20)} len=${String(text.length).padStart(6)}\n`)
    }
  }
})

child.on('exit', (code) => { if (!finished) process.stderr.write(`verify: bridge exited early (${code})\n`) })

setTimeout(() => {
  const text = frames.filter((frame) => frame.kind === 'agent_thought_chunk' || frame.kind === 'agent_message_chunk')
  const textChars = text.reduce((total, frame) => total + frame.length, 0)
  const counts = {}
  for (const frame of frames) counts[frame.kind] = (counts[frame.kind] ?? 0) + 1
  const largest = text.reduce((max, frame) => Math.max(max, frame.length), 0)
  const firstText = text[0]

  process.stdout.write('\n=== summary ===\n')
  process.stdout.write(`patched:      ${stderrReport.some((line) => line.includes('patched @deepseek-ai/dsh-acp loaded')) ? 'yes' : 'no (stock bridge)'}\n`)
  process.stdout.write(`live relay:   ${stderrReport.some((line) => line.includes('live streaming attached')) ? 'attached' : 'not attached'}\n`)
  process.stdout.write(`frames:       ${frames.length} ${JSON.stringify(counts)}\n`)
  process.stdout.write(`text frames:  ${text.length}, largest ${largest} chars, ${textChars} chars total\n`)
  if (firstText !== undefined) {
    process.stdout.write(`first text:   ${(firstText.at / 1000).toFixed(1)}s after the turn started\n`)
  }
  process.stdout.write(`oversized:    ${text.filter((frame) => frame.length > sliceThreshold).length} frames above ${sliceThreshold} chars\n`)
  process.stdout.write(`session:      ${sessionId ?? 'none'}\n`)

  if (promptText === undefined) process.exit(0)
  if (!finished) fail(1, `turn did not finish within ${seconds}s`)
  if (has('--expect-sliced') && !stderrReport.some((line) => line.includes('chars='))) {
    process.stderr.write('verify: no frame was sliced; run a prompt that produces a long block\n')
    process.exit(2)
  }
  process.exit(0)
}, seconds * 1000)

send({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } },
})
