/**
 * Transport tests.
 *
 * The WebSocket case is here for one reason: grok's connection shape is not
 * derivable from its code. It carries the secret in the URL as `server-key`
 * and has no Authorization header at all — a fact that was only visible from a
 * real `grok agent serve` process. Getting it wrong fails as a silent 401-style
 * rejection, so the URL is pinned here rather than rediscovered later.
 */

import { describe, expect, it } from 'vitest'
import { grokWebSocketUrl, WebSocketAcpTransport } from '../src/transport.ts'

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