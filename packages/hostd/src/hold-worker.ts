#!/usr/bin/env node
/** Detached backend owner: native frame proxy, bounded journal, and prompt ledger. */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { createInterface } from 'node:readline'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import WebSocket, { type RawData } from 'ws'
import {
  isJsonValue, jsonObject, type JsonValue, type RemoteJournalEvent, type RemoteJournalPage,
} from '@threadharbor/protocol'
import type { HoldRequest, HoldResponse, HoldWorkerConfig, HoldWorkerState } from './hold-protocol.ts'
import { ChunkCoalescer } from './chunk-coalescer.ts'

const JOURNAL_COMPACT_APPEND_INTERVAL = 512
const JOURNAL_LOG_APPEND_INTERVAL = 128

export function parseConfig(path: string): HoldWorkerConfig {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const value = jsonObject(raw, 'hold worker config')
  if (value['version'] !== 1) throw new Error('hold worker config version must be 1')
  const text = (key: string): string => {
    const item = value[key]
    if (typeof item !== 'string' || item === '') throw new Error(`hold worker config ${key} must be a string`)
    return item
  }
  const integer = (key: string): number => {
    const item = value[key]
    if (!Number.isSafeInteger(item) || (item as number) <= 0) throw new Error(`hold worker config ${key} must be positive`)
    return item as number
  }
  const backend = text('backend')
  if (backend !== 'grok' && backend !== 'codex' && backend !== 'claude' && backend !== 'dsh') throw new Error('invalid hold backend')
  const transportValue = jsonObject(value['transport'], 'hold worker transport')
  const kind = transportValue['kind']
  const transport: HoldWorkerConfig['transport'] = kind === 'stdio'
    ? {
      kind,
      command: typeof transportValue['command'] === 'string' ? transportValue['command'] : '',
      args: Array.isArray(transportValue['args'])
        ? transportValue['args'].map((arg) => {
          if (typeof arg !== 'string') throw new Error('hold worker transport args must be strings')
          return arg
        })
        : [],
    }
    : kind === 'websocket' && typeof transportValue['url'] === 'string'
      ? {
        kind,
        url: transportValue['url'],
        ...(typeof transportValue['secret'] === 'string' && transportValue['secret'] !== ''
          ? { secret: transportValue['secret'] }
          : {}),
      }
      : (() => { throw new Error('invalid hold worker transport') })()
  if (transport.kind === 'stdio' && transport.command === '') throw new Error('stdio transport command must not be empty')
  return {
    version: 1,
    holdId: text('holdId'),
    generation: text('generation'),
    backend,
    cwd: text('cwd'),
    socketPath: text('socketPath'),
    journalPath: text('journalPath'),
    statePath: text('statePath'),
    maxJournalEvents: integer('maxJournalEvents'),
    maxJournalBytes: integer('maxJournalBytes'),
    transport,
  }
}

function parseJournal(path: string): RemoteJournalEvent[] {
  if (!existsSync(path)) return []
  const events: RemoteJournalEvent[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line === '') continue
    const value: unknown = JSON.parse(line)
    const record = jsonObject(value, 'journal event')
    if (!Number.isSafeInteger(record['seq']) || typeof record['generation'] !== 'string'
      || typeof record['timestamp'] !== 'string' || !isJsonValue(record['frame'])) {
      throw new Error('invalid hold journal event')
    }
    events.push(record as unknown as RemoteJournalEvent)
  }
  return events
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

function rawDataText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  return Buffer.from(data).toString('utf8')
}

function journalMetricsEnabled(): boolean {
  return process.env['THREADHARBOR_HOLD_JOURNAL_METRICS'] !== '0' && process.env['NODE_ENV'] !== 'test'
}

/** Live worker runtime. Its process lifetime is intentionally independent from hostd. */
export class HoldWorker {
  private readonly journal: RemoteJournalEvent[]
  private journalBytes: number
  private droppedThrough = 0
  private nextSeq: number
  private initialized = false
  private initializeResult: JsonValue | undefined
  private nativeSessionId: string | undefined
  private backendPid: number | undefined
  private child: ChildProcessWithoutNullStreams | undefined
  private upstream: WebSocket | undefined
  private server: Server | undefined
  private closeTask: Promise<void> | undefined
  private readonly admissions = new Set<string>()
  private readonly requests = new Map<string, { method: string; sessionId?: string }>()
  private readonly promptQueue: JsonValue[] = []
  private promptActive = false
  private readonly waiters = new Set<{
    readonly rpcId: string
    readonly afterSeq: number
    readonly socket: Socket
    readonly timer: NodeJS.Timeout
  }>()
  private readonly seqWaiters = new Set<{
    readonly afterSeq: number
    readonly socket: Socket
    readonly timer: NodeJS.Timeout
  }>()
  private readonly pageWaiters = new Set<{
    readonly afterSeq: number
    readonly generation?: string
    readonly socket: Socket
    readonly timer: NodeJS.Timeout
  }>()
  private readonly coalescer = new ChunkCoalescer()
  private coalesceTimer: ReturnType<typeof setTimeout> | undefined
  private appendsSinceCompact = 0

  /** @param config - immutable owner-only launch record. */
  constructor(private readonly config: HoldWorkerConfig) {
    this.journal = parseJournal(config.journalPath)
    this.journalBytes = this.journal.reduce((sum, event) => sum + Buffer.byteLength(jsonLine(event)), 0)
    this.droppedThrough = this.previousDroppedThrough()
    this.nextSeq = Math.max(this.journal.at(-1)?.seq ?? 0, this.droppedThrough) + 1
    this.logJournalMetric('recovered', {})
  }

  /** Start the backend, local socket, and state publication. */
  async start(): Promise<void> {
    mkdirSync(dirname(this.config.socketPath), { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32' && existsSync(this.config.socketPath)) unlinkSync(this.config.socketPath)
    if (this.config.transport.kind === 'stdio') this.startStdio(this.config.transport.command, this.config.transport.args)
    else await this.startWebSocket(this.config.transport.url)

    const server = createServer((socket) => { this.handleSocket(socket) })
    this.server = server
    server.on('error', (error) => {
      process.stderr.write(`threadharbor-hostd hold socket: ${String(error)}\n`)
      process.exitCode = 1
    })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(this.config.socketPath, () => {
          server.off('error', reject)
          if (process.platform !== 'win32') chmodSync(this.config.socketPath, 0o600)
          resolve()
        })
      })
      this.writeState(true)

      process.once('SIGTERM', this.stopFromSignal)
      process.once('SIGINT', this.stopFromSignal)
    } catch (error) {
      await this.close()
      throw error
    }
  }

  /** Close the private listener and backend transport. */
  close(): Promise<void> {
    this.closeTask ??= this.performClose()
    return this.closeTask
  }

  private readonly stopFromSignal = (): void => {
    this.close().catch((error: unknown) => {
      process.stderr.write(`threadharbor-hostd hold close: ${String(error)}\n`)
      process.exitCode = 1
    })
  }

  private async performClose(): Promise<void> {
    this.clearCoalesceTimer()
    for (const frame of this.coalescer.flush()) this.append(frame)
    process.off('SIGTERM', this.stopFromSignal)
    process.off('SIGINT', this.stopFromSignal)
    const server = this.server
    this.server = undefined
    const child = this.child
    const childClosed = child !== undefined && child.exitCode === null
      ? new Promise<void>(resolveClose => child.once('close', () => { resolveClose() }))
      : undefined
    child?.kill('SIGTERM')
    this.upstream?.close()
    if (server?.listening === true) {
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => {
          if (error === undefined) resolveClose()
          else reject(error)
        })
      })
    }
    await childClosed
    if (process.platform !== 'win32' && existsSync(this.config.socketPath)) unlinkSync(this.config.socketPath)
    this.writeState(false)
  }

  private startStdio(command: string, args: readonly string[]): void {
    const child = spawn(command, [...args], {
      cwd: this.config.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    child.stderr.pipe(process.stderr)
    this.backendPid = child.pid
    child.on('error', (error) => {
      this.append({
        jsonrpc: '2.0', method: '_dsh/transport_error', params: { message: String(error) },
      })
    })
    child.on('exit', (code, signal) => {
      this.append({
        jsonrpc: '2.0', method: '_dsh/transport_closed', params: {
          code: code ?? null, signal: signal ?? null,
        },
      })
      this.writeState(false)
    })
    createInterface({ input: child.stdout }).on('line', (line) => { this.receiveText(line) })
  }

  private async startWebSocket(baseUrl: string): Promise<void> {
    const envSecret = process.env['GROK_AGENT_SECRET']
    const configSecret = this.config.transport.kind === 'websocket'
      ? this.config.transport.secret
      : undefined
    const secret = envSecret !== undefined && envSecret !== '' ? envSecret : configSecret
    const url = new URL(baseUrl)
    if (secret !== undefined && secret !== '') url.searchParams.set('server-key', secret)
    const socket = new WebSocket(url)
    this.upstream = socket
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    socket.on('message', (data) => { this.receiveText(rawDataText(data)) })
    socket.on('close', (code, reason) => {
      this.append({
        jsonrpc: '2.0', method: '_dsh/transport_closed', params: { code, reason: reason.toString() },
      })
      this.writeState(false)
    })
    socket.on('error', (error) => {
      this.append({
        jsonrpc: '2.0', method: '_dsh/transport_error', params: { message: String(error) },
      })
    })
  }

  private receiveText(text: string): void {
    let frame: JsonValue
    try {
      const value: unknown = JSON.parse(text)
      frame = isJsonValue(value) ? value : { raw: text }
    } catch {
      frame = { raw: text }
    }
    const record = frame !== null && typeof frame === 'object' && !Array.isArray(frame) ? frame : undefined
    const id = record?.['id']
    const rpcId = typeof id === 'string' || typeof id === 'number' ? String(id) : undefined
    const request = rpcId === undefined ? undefined : this.requests.get(rpcId)
    if (request !== undefined && record !== undefined && record['method'] === undefined
      && (Object.hasOwn(record, 'result') || Object.hasOwn(record, 'error'))) {
      if (rpcId !== undefined) this.requests.delete(rpcId)
      if (request.method === 'initialize' && record['error'] === undefined) {
        this.initialized = true
        this.initializeResult = record['result']
      }
      if ((request.method === 'session/new' || request.method === 'session/fork') && record['error'] === undefined) {
        const result = record['result']
        const resultRecord = result !== null && typeof result === 'object' && !Array.isArray(result) ? result : undefined
        if (typeof resultRecord?.['sessionId'] === 'string') this.nativeSessionId = resultRecord['sessionId']
      }
    }
    const journaled = this.journalFrames(this.coalescer.push(frame))
    if (request?.method === 'session/prompt' && this.config.backend === 'codex') {
      const responseRecord = record ?? {}
      const result = responseRecord['result']
      const resultRecord = result !== null && typeof result === 'object' && !Array.isArray(result) ? result : undefined
      this.journalFrames([{
        jsonrpc: '2.0',
        method: '_x.ai/session/prompt_complete',
        params: {
          sessionId: request.sessionId ?? this.nativeSessionId ?? '',
          stopReason: typeof resultRecord?.['stopReason'] === 'string'
            ? resultRecord['stopReason']
            : responseRecord['error'] === undefined ? 'end_turn' : 'error',
        },
      }])
      this.promptActive = false
      this.drainPromptQueue()
    } else if ((request?.method === 'session/prompt' && record?.['error'] !== undefined)
      || this.completesPrompt(record)) {
      this.promptActive = false
      this.drainPromptQueue()
    }
    if (journaled.length > 0) {
      this.resolveWaiters(journaled[journaled.length - 1]!)
      this.resolveSeqWaiters()
      this.writeState(true)
    } else {
      this.scheduleCoalesceFlush()
    }
  }

  private journalFrames(frames: readonly JsonValue[]): RemoteJournalEvent[] {
    if (frames.length === 0) return []
    this.clearCoalesceTimer()
    return frames.map(frame => this.append(frame))
  }

  private scheduleCoalesceFlush(): void {
    if (this.coalesceTimer !== undefined) return
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = undefined
      const journaled = this.journalFrames(this.coalescer.flush())
      if (journaled.length === 0) return
      this.resolveWaiters(journaled[journaled.length - 1]!)
      this.resolveSeqWaiters()
      this.writeState(true)
    }, 40)
  }

  private clearCoalesceTimer(): void {
    if (this.coalesceTimer === undefined) return
    clearTimeout(this.coalesceTimer)
    this.coalesceTimer = undefined
  }

  private append(frame: JsonValue): RemoteJournalEvent {
    const event: RemoteJournalEvent = {
      seq: this.nextSeq++,
      generation: this.config.generation,
      timestamp: new Date().toISOString(),
      frame,
    }
    this.journal.push(event)
    this.journalBytes += Buffer.byteLength(jsonLine(event))
    const trimmed = this.trimJournal()
    if (trimmed || ++this.appendsSinceCompact >= JOURNAL_COMPACT_APPEND_INTERVAL) {
      const reason = trimmed ? 'retention' : 'interval'
      const started = performance.now()
      this.compactJournal()
      this.logJournalMetric('compact', { reason, durationMs: performance.now() - started })
    } else {
      const started = performance.now()
      appendFileSync(this.config.journalPath, jsonLine(event), { mode: 0o600 })
      if (this.appendsSinceCompact % JOURNAL_LOG_APPEND_INTERVAL === 0) {
        this.logJournalMetric('append-sample', { durationMs: performance.now() - started })
      }
    }
    return event
  }

  private trimJournal(): boolean {
    let trimmed = false
    while (this.journal.length > this.config.maxJournalEvents
      || (this.journalBytes > this.config.maxJournalBytes && this.journal.length > 1)) {
      const removed = this.journal.shift()
      if (removed === undefined) break
      this.journalBytes -= Buffer.byteLength(jsonLine(removed))
      this.droppedThrough = removed.seq
      trimmed = true
    }
    return trimmed
  }

  private compactJournal(): void {
    const temporary = `${this.config.journalPath}.${process.pid}.tmp`
    writeFileSync(temporary, this.journal.map(jsonLine).join(''), { mode: 0o600 })
    renameSync(temporary, this.config.journalPath)
    this.appendsSinceCompact = 0
  }

  private logJournalMetric(event: string, fields: Record<string, unknown>): void {
    if (!journalMetricsEnabled()) return
    const payload = {
      event,
      holdId: this.config.holdId,
      backend: this.config.backend,
      generation: this.config.generation,
      pid: process.pid,
      journalEvents: this.journal.length,
      journalBytes: this.journalBytes,
      latestSeq: this.nextSeq - 1,
      droppedThrough: this.droppedThrough,
      appendsSinceCompact: this.appendsSinceCompact,
      ...fields,
    }
    process.stderr.write(`threadharbor-hold-journal ${JSON.stringify(payload)}\n`)
  }

  private sendFrame(frame: JsonValue): void {
    const record = frame !== null && typeof frame === 'object' && !Array.isArray(frame) ? frame : undefined
    const id = record?.['id']
    const method = record?.['method']
    if (record !== undefined && (typeof id === 'string' || typeof id === 'number') && typeof method === 'string') {
      const params = record['params']
      const paramsRecord = params !== null && typeof params === 'object' && !Array.isArray(params) ? params : undefined
      this.requests.set(String(id), {
        method,
        ...(typeof paramsRecord?.['sessionId'] === 'string' ? { sessionId: paramsRecord['sessionId'] } : {}),
      })
    }
    const line = jsonLine(frame)
    if (this.child !== undefined) {
      this.child.stdin.write(line)
      return
    }
    if (this.upstream?.readyState !== WebSocket.OPEN) throw new Error('backend websocket is not open')
    this.upstream.send(JSON.stringify(frame))
  }

  private admitPrompt(frame: JsonValue): void {
    const record = frame !== null && typeof frame === 'object' && !Array.isArray(frame) ? frame : undefined
    if (record?.['method'] !== 'session/prompt') {
      this.sendFrame(frame)
      return
    }
    this.promptQueue.push(frame)
    this.drainPromptQueue()
  }

  private drainPromptQueue(): void {
    if (this.promptActive) return
    const frame = this.promptQueue.shift()
    if (frame === undefined) return
    this.promptActive = true
    try {
      this.sendFrame(frame)
    } catch (error) {
      this.promptActive = false
      this.append({
        jsonrpc: '2.0', method: '_dsh/transport_error', params: { message: String(error) },
      })
      this.drainPromptQueue()
    }
  }

  private completesPrompt(record: Record<string, JsonValue> | undefined): boolean {
    if (record === undefined) return false
    if (this.config.backend === 'grok') return record['method'] === '_x.ai/session/prompt_complete'
    if (this.config.backend !== 'dsh') return false
    if (record['method'] === 'session.status') {
      const params = record['params']
      return params !== null && typeof params === 'object' && !Array.isArray(params)
        && params['status'] === 'idle'
    }
    if (record['method'] !== 'session.event') return false
    const params = record['params']
    if (params === null || typeof params !== 'object' || Array.isArray(params)) return false
    const event = params['event']
    return event !== null && typeof event === 'object' && !Array.isArray(event) && event['type'] === 'turn/end'
  }

  private previousDroppedThrough(): number {
    if (!existsSync(this.config.statePath)) return 0
    try {
      const value: unknown = JSON.parse(readFileSync(this.config.statePath, 'utf8'))
      const state = jsonObject(value, 'hold worker state')
      const droppedThrough = state['droppedThrough']
      return state['generation'] === this.config.generation && Number.isSafeInteger(droppedThrough)
        && (droppedThrough as number) >= 0
        ? droppedThrough as number
        : 0
    } catch (error) {
      throw new Error(`cannot recover hold worker state: ${String(error)}`)
    }
  }

  private page(afterSeq: number, generation?: string): RemoteJournalPage {
    const latestSeq = this.nextSeq - 1
    const staleAhead = afterSeq > latestSeq
    const effectiveAfter = staleAhead ? 0 : afterSeq
    const generationChanged = generation !== undefined && generation !== this.config.generation
    const gap = generationChanged || effectiveAfter < this.droppedThrough
    return {
      generation: this.config.generation,
      latestSeq,
      droppedThrough: this.droppedThrough,
      gap,
      events: this.journal.filter(event => event.seq > (gap ? this.droppedThrough : effectiveAfter)),
    }
  }

  private handleSocket(socket: Socket): void {
    socket.setEncoding('utf8')
    let input = ''
    socket.on('data', (chunk: string) => {
      input += chunk
      const newline = input.indexOf('\n')
      if (newline === -1) return
      const line = input.slice(0, newline)
      input = ''
      try {
        const request = JSON.parse(line) as HoldRequest
        this.handleRequest(socket, request)
      } catch (error) {
        this.reply(socket, { ok: false, error: String(error) })
      }
    })
  }

  private handleRequest(socket: Socket, request: HoldRequest): void {
    switch (request.operation) {
      case 'ping':
        this.reply(socket, { ok: true, result: { generation: this.config.generation, latestSeq: this.nextSeq - 1 } })
        return
      case 'read':
        this.reply(socket, { ok: true, result: this.page(request.afterSeq, request.generation) })
        return
      case 'send': {
        const key = `${request.admission.clientId}:${request.admission.requestId}`
        if (this.admissions.has(key)) {
          this.reply(socket, { ok: true, result: { accepted: true, duplicate: true } })
          return
        }
        this.admissions.add(key)
        this.admitPrompt(request.admission.frame)
        this.reply(socket, { ok: true, result: { accepted: true, duplicate: false } })
        return
      }
      case 'send-frame':
        this.sendFrame(request.frame)
        this.reply(socket, { ok: true, result: { accepted: true } })
        return
      case 'wait-seq': {
        if (this.nextSeq - 1 > request.afterSeq) {
          this.reply(socket, { ok: true, result: { latestSeq: this.nextSeq - 1, timedOut: false } })
          return
        }
        const timer = setTimeout(() => {
          for (const waiter of this.seqWaiters) {
            if (waiter.socket !== socket) continue
            this.seqWaiters.delete(waiter)
            this.reply(socket, { ok: true, result: { latestSeq: this.nextSeq - 1, timedOut: true } })
            break
          }
        }, request.timeoutMs)
        this.seqWaiters.add({ afterSeq: request.afterSeq, socket, timer })
        socket.once('close', () => {
          for (const waiter of this.seqWaiters) {
            if (waiter.socket !== socket) continue
            clearTimeout(waiter.timer)
            this.seqWaiters.delete(waiter)
          }
        })
        return
      }
      case 'wait-page': {
        if (this.nextSeq - 1 > request.afterSeq) {
          this.reply(socket, { ok: true, result: this.page(request.afterSeq, request.generation) })
          return
        }
        const timer = setTimeout(() => {
          for (const waiter of this.pageWaiters) {
            if (waiter.socket !== socket) continue
            this.pageWaiters.delete(waiter)
            this.reply(socket, { ok: true, result: this.page(waiter.afterSeq, waiter.generation) })
            break
          }
        }, request.timeoutMs)
        this.pageWaiters.add({
          afterSeq: request.afterSeq,
          ...(request.generation === undefined ? {} : { generation: request.generation }),
          socket,
          timer,
        })
        socket.once('close', () => {
          for (const waiter of this.pageWaiters) {
            if (waiter.socket !== socket) continue
            clearTimeout(waiter.timer)
            this.pageWaiters.delete(waiter)
          }
        })
        return
      }
      case 'wait': {
        const existing = this.findResponse(request.rpcId, request.afterSeq)
        if (existing !== undefined) {
          this.reply(socket, { ok: true, result: existing.frame })
          return
        }
        const timer = setTimeout(() => {
          for (const waiter of this.waiters) {
            if (waiter.socket !== socket) continue
            this.waiters.delete(waiter)
            this.reply(socket, { ok: false, error: `timed out waiting for RPC ${request.rpcId}` })
            break
          }
        }, request.timeoutMs)
        this.waiters.add({ rpcId: request.rpcId, afterSeq: request.afterSeq, socket, timer })
        socket.once('close', () => {
          for (const waiter of this.waiters) {
            if (waiter.socket !== socket) continue
            clearTimeout(waiter.timer)
            this.waiters.delete(waiter)
          }
        })
        return
      }
      case 'set-native-session':
        this.nativeSessionId = request.nativeSessionId
        this.writeState(true)
        this.reply(socket, { ok: true, result: { nativeSessionId: request.nativeSessionId } })
        return
      case 'shutdown':
        this.reply(socket, { ok: true, result: { stopping: true } })
        process.kill(process.pid, 'SIGTERM')
        return
      default:
        request satisfies never
    }
  }

  private findResponse(rpcId: string, afterSeq: number): RemoteJournalEvent | undefined {
    return this.journal.find((event) => {
      if (event.seq <= afterSeq || event.frame === null || typeof event.frame !== 'object' || Array.isArray(event.frame)) return false
      const id = event.frame['id']
      return (typeof id === 'string' || typeof id === 'number') && String(id) === rpcId
        && event.frame['method'] === undefined
    })
  }

  private resolveWaiters(event: RemoteJournalEvent): void {
    if (event.frame === null || typeof event.frame !== 'object' || Array.isArray(event.frame)) return
    const id = event.frame['id']
    if (typeof id !== 'string' && typeof id !== 'number') return
    for (const waiter of this.waiters) {
      if (event.seq <= waiter.afterSeq || String(id) !== waiter.rpcId || event.frame['method'] !== undefined) continue
      clearTimeout(waiter.timer)
      this.waiters.delete(waiter)
      this.reply(waiter.socket, { ok: true, result: event.frame })
    }
  }

  private resolveSeqWaiters(): void {
    const latestSeq = this.nextSeq - 1
    for (const waiter of this.seqWaiters) {
      if (latestSeq <= waiter.afterSeq) continue
      clearTimeout(waiter.timer)
      this.seqWaiters.delete(waiter)
      this.reply(waiter.socket, { ok: true, result: { latestSeq, timedOut: false } })
    }
    for (const waiter of this.pageWaiters) {
      if (latestSeq <= waiter.afterSeq) continue
      clearTimeout(waiter.timer)
      this.pageWaiters.delete(waiter)
      this.reply(waiter.socket, { ok: true, result: this.page(waiter.afterSeq, waiter.generation) })
    }
  }

  private reply(socket: Socket, response: HoldResponse): void {
    if (socket.destroyed) return
    socket.end(jsonLine(response))
  }

  private writeState(ready: boolean): void {
    const state: HoldWorkerState = {
      pid: process.pid,
      ...(this.backendPid === undefined ? {} : { backendPid: this.backendPid }),
      ready,
      generation: this.config.generation,
      latestSeq: this.nextSeq - 1,
      droppedThrough: this.droppedThrough,
      initialized: this.initialized,
      ...(this.initializeResult === undefined ? {} : { initializeResult: this.initializeResult }),
      ...(this.nativeSessionId === undefined ? {} : { nativeSessionId: this.nativeSessionId }),
      updatedAt: new Date().toISOString(),
    }
    const temporary = `${this.config.statePath}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify(state, undefined, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, this.config.statePath)
  }
}

/** Run the detached worker from its configuration path.
 * @param configPath - owner-only hold configuration file.
 */
export async function runHoldWorker(configPath: string): Promise<void> {
  await new HoldWorker(parseConfig(configPath)).start()
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const configPath = process.argv[2]
  if (configPath === undefined) throw new Error('usage: hold-worker <config.json>')
  await runHoldWorker(configPath)
}
