/**
 * Transport tests.
 *
 * The WebSocket case is here for one reason: grok's connection shape is not
 * derivable from its code. It carries the secret in the URL as `server-key`
 * and has no Authorization header at all — a fact that was only visible from a
 * real `grok agent serve` process. Getting it wrong fails as a silent 401-style
 * rejection, so the URL is pinned here rather than rediscovered later.
 */

import { describe, expect, it, vi } from 'vitest'
import { ActivityBeacon, GrokServeTransport, grokWebSocketUrl, StdioAcpTransport, WebSocketAcpTransport } from '../src/transport.ts'
import type { GrokServeChild } from '../src/transport.ts'

/** A socket stand-in with just the surface the transport touches. */
function fakeSocket() {
  const state = {
    sent: [] as string[],
    closed: false,
    open: false,
    listener: undefined as ((line: string) => void) | undefined,
    opener: undefined as (() => void) | undefined,
    dier: undefined as ((reason: string) => void) | undefined,
  }
  return {
    state,
    /** Stand in for the socket finishing its handshake. */
    connect() {
      state.open = true
      state.opener?.()
    },
    send(line: string) {
      // A real WebSocket throws when sent to before it has connected. Modelling
      // that is the only way the queueing behaviour is actually under test.
      if (!state.open) throw new Error('Sent before connected.')
      state.sent.push(line)
    },
    close() { state.closed = true },
    onMessage(handler: (line: string) => void) { state.listener = handler },
    onOpen(handler: () => void) { state.opener = handler },
    onDeath(handler: (reason: string) => void) { state.dier = handler },
    deliver(line: string) { state.listener?.(line) },
    die(reason: string) { state.dier?.(reason) },
  }
}

describe('grokWebSocketUrl', () => {
  it('carries the secret in the query as server-key, not in a header', () => {
    expect(grokWebSocketUrl('127.0.0.1:2419', 's3cret')).toBe('ws://127.0.0.1:2419/ws?server-key=s3cret')
  })

  it('defaults to grok’s default port when the bind carries no port', () => {
    expect(grokWebSocketUrl('127.0.0.1', 's3cret')).toBe('ws://127.0.0.1:2419/ws?server-key=s3cret')
  })

  it('escapes a secret that needs it', () => {
    expect(grokWebSocketUrl('127.0.0.1:2419', 'a b&c')).toBe('ws://127.0.0.1:2419/ws?server-key=a%20b%26c')
  })
})

describe('WebSocketAcpTransport', () => {
  it('routes incoming messages to the handler', () => {
    const socket = fakeSocket()
    const transport = new WebSocketAcpTransport({ url: 'ws://x/ws?server-key=y', createSocket: () => socket })
    const seen: string[] = []
    transport.onLine(line => seen.push(line))
    socket.deliver('{"a":1}')
    expect(seen).toEqual(['{"a":1}'])
  })

  it('holds frames written before the socket connects, then flushes them in order', () => {
    // The client opens a connection and immediately writes its initialize
    // request. A real WebSocket refuses that with "Sent before connected", so
    // queueing is not a nicety — without it the very first request throws.
    const socket = fakeSocket()
    const transport = new WebSocketAcpTransport({ url: 'ws://x/ws?server-key=y', createSocket: () => socket })
    transport.send('{"first":1}')
    transport.send('{"second":2}')
    expect(socket.state.sent).toEqual([])

    socket.connect()
    expect(socket.state.sent).toEqual(['{"first":1}', '{"second":2}'])
  })

  it('writes frames that arrive after the connection is up', () => {
    const socket = fakeSocket()
    const transport = new WebSocketAcpTransport({ url: 'ws://x/ws?server-key=y', createSocket: () => socket })
    socket.connect()
    transport.send('{"b":2}')
    expect(socket.state.sent).toEqual(['{"b":2}'])
  })

  it('closes the socket', () => {
    const socket = fakeSocket()
    const WebSocketAcpTransportCtor = WebSocketAcpTransport
    new WebSocketAcpTransportCtor({ url: 'ws://x/ws?server-key=y', createSocket: () => socket }).close()
    expect(socket.state.closed).toBe(true)
  })
})

/** A grok serve process stand-in: records its spawn args and lets the test drive exit. */
function fakeServeChild() {
  const state = {
    killed: undefined as NodeJS.Signals | undefined,
    spawn: undefined as { command: string; args: string[] } | undefined,
    exitHandlers: [] as ((code: number | null, signal: NodeJS.Signals | null) => void)[],
    errorHandlers: [] as ((error: Error) => void)[],
    stderrListener: undefined as ((chunk: string) => void) | undefined,
  }
  const child: GrokServeChild = {
    stderr: {
      setEncoding() {},
      on(event, handler) { if (event === 'data') state.stderrListener = handler as (chunk: string) => void },
    },
    on(event, handler) {
      if (event === 'error') state.errorHandlers.push(handler as (error: Error) => void)
      if (event === 'exit') state.exitHandlers.push(handler as (code: number | null, signal: NodeJS.Signals | null) => void)
    },
    kill(signal) { state.killed = signal },
  }
  return {
    child,
    state,
    emitExit(code: number | null, signal: NodeJS.Signals | null) { state.exitHandlers.forEach(h => h(code, signal)) },
    emitError(error: Error) { state.errorHandlers.forEach(h => h(error)) },
    emitStderr(chunk: string) { state.stderrListener?.(chunk) },
  }
}

/** Build a GrokServeTransport with every OS touch-point injected, so no real port or process. */
async function makeGrokServe() {
  const socket = fakeSocket()
  const serve = fakeServeChild()
  let spawnArgs: { command: string; args: string[] } | undefined
  const transport = await GrokServeTransport.create({
    command: '/path/to/grok',
    pickPort: () => Promise.resolve(54321),
    waitUntilReady: () => Promise.resolve(),
    createSocket: () => socket,
    spawn: (command, args) => {
      spawnArgs = { command, args: [...args] }
      return serve.child
    },
  })
  return { transport, socket, serve, spawnArgs: () => spawnArgs }
}

describe('GrokServeTransport', () => {
  it('spawns `grok agent serve` on a chosen port with a secret', async () => {
    const { spawnArgs } = await makeGrokServe()
    const args = spawnArgs()?.args ?? []
    expect(spawnArgs()?.command).toBe('/path/to/grok')
    expect(args.slice(0, 4)).toEqual(['agent', 'serve', '--bind', '127.0.0.1:54321'])
    const secretIdx = args.indexOf('--secret')
    expect(secretIdx).toBeGreaterThan(0)
    expect(args[secretIdx + 1]).toBeTruthy()
  })

  it('dials the WebSocket once the serve process is ready', async () => {
    const { transport, socket } = await makeGrokServe()
    // The transport is only returned after readiness, so the inner socket is
    // already built — sending routes straight through once the socket opens.
    socket.connect()
    transport.send('{"a":1}')
    expect(socket.state.sent).toContain('{"a":1}')
  })

  it('forwards frames in both directions', async () => {
    const { transport, socket } = await makeGrokServe()
    const seen: string[] = []
    transport.onLine(line => seen.push(line))
    socket.connect()
    transport.send('out')
    socket.deliver('in')
    expect(socket.state.sent).toContain('out')
    expect(seen).toEqual(['in'])
  })

  it('reports the serve process dying', async () => {
    const { transport, serve } = await makeGrokServe()
    const deaths: string[] = []
    transport.onDeath(reason => deaths.push(reason))
    serve.emitExit(0, null)
    expect(deaths).toHaveLength(1)
    expect(deaths[0]).toContain('exited')
  })

  it('reports the serve process failing to start', async () => {
    const { transport, serve } = await makeGrokServe()
    const deaths: string[] = []
    transport.onDeath(reason => deaths.push(reason))
    serve.emitError(new Error('boom'))
    expect(deaths).toHaveLength(1)
    expect(deaths[0]).toContain('could not run')
  })

  it('reports the socket dying', async () => {
    const { transport, socket } = await makeGrokServe()
    const deaths: string[] = []
    transport.onDeath(reason => deaths.push(reason))
    socket.die('connection closed')
    expect(deaths).toEqual(['connection closed'])
  })

  it('closes both the socket and the serve process', async () => {
    const { transport, serve, socket } = await makeGrokServe()
    transport.close()
    expect(serve.state.killed).toBe('SIGTERM')
    expect(socket.state.closed).toBe(true)
  })

  it('does not report death after an intentional close', async () => {
    const { transport, serve } = await makeGrokServe()
    const deaths: string[] = []
    transport.onDeath(reason => deaths.push(reason))
    transport.close()
    serve.emitExit(0, null)
    expect(deaths).toEqual([])
  })

  it('forwards serve stderr to the diagnostic sink', async () => {
    const diagnostics: string[] = []
    const socket = fakeSocket()
    const serve = fakeServeChild()
    await GrokServeTransport.create({
      command: 'grok',
      pickPort: () => Promise.resolve(1),
      waitUntilReady: () => Promise.resolve(),
      createSocket: () => socket,
      onDiagnostic: line => diagnostics.push(line),
      spawn: () => serve.child,
    })
    serve.emitStderr('listening on 2419\n')
    expect(diagnostics).toContain('listening on 2419')
  })
})
describe('ActivityBeacon', () => {
  it('帧与诊断分开计时，stderr 进环形缓冲且上限 20 行', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000_000)
      const beacon = new ActivityBeacon()
      expect(beacon.lastFrameAt()).toBe(1_000_000)
      expect(beacon.lastDiagnosticAt()).toBe(1_000_000)
      vi.setSystemTime(1_000_100)
      beacon.frame()
      expect(beacon.lastFrameAt()).toBe(1_000_100)
      expect(beacon.lastDiagnosticAt()).toBe(1_000_000)
      vi.setSystemTime(1_000_200)
      beacon.diagnostic('first warning')
      expect(beacon.lastDiagnosticAt()).toBe(1_000_200)
      expect(beacon.lastFrameAt()).toBe(1_000_100)
      for (let index = 0; index < 25; index++) beacon.diagnostic(`line-${index}`)
      const tail = beacon.stderrTail()
      expect(tail).toHaveLength(20)
      expect(tail[0]).toBe('line-5')
      expect(tail[19]).toBe('line-24')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('WebSocketAcpTransport 信标', () => {
  it('socket 收到帧后 lastFrameAt 前移，lastDiagnosticAt 不动且无 stderr', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(2_000_000)
      const socket = fakeSocket()
      const transport = new WebSocketAcpTransport({ url: 'ws://x/ws?server-key=y', createSocket: () => socket })
      transport.onLine(() => {})
      vi.setSystemTime(2_000_500)
      socket.deliver('{"jsonrpc":"2.0"}')
      expect(transport.lastFrameAt()).toBe(2_000_500)
      expect(transport.lastDiagnosticAt()).toBe(2_000_000)
      expect(transport.stderrTail()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('StdioAcpTransport 信标', () => {
  it('stdout 行计帧、stderr 行计诊断，两者时间戳互不覆盖', async () => {
    const before = Date.now()
    const lines: string[] = []
    const transport = new StdioAcpTransport({
      command: process.execPath,
      args: ['-e', [
        'console.log(JSON.stringify({ a: 1 }))',
        "setTimeout(() => process.stderr.write('warn-one\\n'), 40)",
        'setTimeout(() => console.log(JSON.stringify({ b: 2 })), 90)',
        "setTimeout(() => process.stderr.write('warn-two\\n'), 140)",
        'setTimeout(() => {}, 400)',
      ].join(';')],
    })
    transport.onLine(line => lines.push(line))
    try {
      await new Promise(resolve => setTimeout(resolve, 500))
      expect(lines).toHaveLength(2)
      expect(transport.stderrTail()).toEqual(['warn-one', 'warn-two'])
      expect(transport.lastFrameAt()).toBeGreaterThan(before)
      expect(transport.lastDiagnosticAt()).toBeGreaterThan(transport.lastFrameAt())
    } finally {
      transport.close()
    }
  }, 10_000)
})

describe('GrokServeTransport 信标', () => {
  it('子进程 stderr 计诊断，帧经内层 WebSocket 计帧', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(3_000_000)
      const socket = fakeSocket()
      const serve = fakeServeChild()
      const transport = await GrokServeTransport.create({
        command: 'grok',
        pickPort: () => Promise.resolve(1),
        waitUntilReady: () => Promise.resolve(),
        createSocket: () => socket,
        spawn: () => serve.child,
      })
      transport.onLine(() => {})
      vi.setSystemTime(3_000_100)
      socket.deliver('{"jsonrpc":"2.0"}')
      vi.setSystemTime(3_000_200)
      serve.emitStderr('grok retrying\n')
      expect(transport.lastFrameAt()).toBe(3_000_100)
      expect(transport.lastDiagnosticAt()).toBe(3_000_200)
      expect(transport.stderrTail()).toEqual(['grok retrying'])
      transport.close()
    } finally {
      vi.useRealTimers()
    }
  })
})
