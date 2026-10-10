/**
 * Reaching a configured external agent: process or socket, per preset.
 *
 * DSH's own approval service is not reachable from here, so permission
 * answering arrives as a port. Keeping it injected rather than importing the
 * runtime package is deliberate — see the service entry for why.
 */

import {
  AcpClient,
  StdioAcpTransport,
  TerminalService,
  WebSocketAcpTransport,
  claudeDialect,
  codexDialect,
  grokDialect,
} from '@threadharbor/dsh-acp-agent'
import type { AcpDialect, AcpTransport, PermissionDecision, PermissionRequest } from '@threadharbor/dsh-acp-agent'
import type { AcpSession, AcpSessionFactory, PresetConfig } from './registry.ts'
import { AcpTurnRunner } from './runner.ts'
import type { AcpClientPort } from './runner.ts'

export type FactoryDeps = {
  /** Answer an agent-initiated permission request. */
  answerPermission(request: PermissionRequest): Promise<PermissionDecision>
  /**
   * Build the transport a preset connects over.
   *
   * Supplied by tests so the client this factory builds can actually be driven —
   * permission handling is decided inside a client the factory otherwise keeps
   * to itself, which leaves nothing to assert against.
   */
  transport?(preset: { url?: string; command?: string }): AcpTransport
}

/** Which frame dialect an agent speaks. Unknown agents are not ours. */
const DIALECTS: Readonly<Record<string, AcpDialect>> = {
  grok: grokDialect,
  claude: claudeDialect,
  codex: codexDialect,
}

/**
 * A transport whose death reaches every listener, not only the last one.
 *
 * The real transports hold a single death slot: each `onDeath` registration
 * replaces the previous handler. The AcpClient owns that slot the moment it is
 * constructed, so a second listener registered afterwards would silently steal
 * the client's — in-flight turns would then wait forever on a dead connection
 * while only the registry heard about the death. Fanning out from one
 * underlying registration is what keeps both listeners live.
 */
class DeathFanoutTransport implements AcpTransport {
  private readonly inner: AcpTransport
  private readonly listeners = new Set<(reason: string) => void>()
  private wired = false

  constructor(inner: AcpTransport) {
    this.inner = inner
  }

  send(line: string): void { this.inner.send(line) }

  onLine(handler: (line: string) => void): void { this.inner.onLine(handler) }

  onDeath(handler: (reason: string) => void): void {
    this.listeners.add(handler)
    if (this.wired) return
    this.wired = true
    // Copied before iterating: a listener that registers another one during
    // death must not be half-covered by this loop.
    this.inner.onDeath(reason => {
      for (const listener of [...this.listeners]) listener(reason)
    })
  }

  close(): void { this.inner.close() }
}

export function makeSessionFactory(config: PresetConfig, deps: FactoryDeps): AcpSessionFactory {
  return {
    dialectFor: (_presetId, preset) => DIALECTS[preset.agent ?? ''],

    open: (presetId, options): AcpSession => {
      const preset = config.presets[presetId]
      if (preset === undefined) throw new Error(`acp dispatch: no preset named ${presetId}`)

      const raw = deps.transport?.(preset) ?? (preset.url !== undefined
        ? new WebSocketAcpTransport({ url: preset.url })
        : new StdioAcpTransport({ command: preset.command ?? '' }))
      // The client and the registry's death watcher both listen; the fanout is
      // what lets them without one stealing the other's slot.
      const transport = new DeathFanoutTransport(raw)

      const client = new AcpClient(transport, DIALECTS[preset.agent ?? ''] ?? grokDialect)
      // grok delegates shell execution to the client. Without this the agent
      // waits for a terminal that never appears, and the turn hangs silently.
      client.terminals = new TerminalService()
      client.onPermissionRequest = async request => await deps.answerPermission(request)

      const runner = new AcpTurnRunner(adaptClient(client), options)
      return {
        run: async (decision, turn) => await runner.run(decision, turn),
        // Drops the connection itself, not just the runner's bookkeeping: a
        // runner that forgets its session id would otherwise hand back the
        // same conversation.
        close: () => { client.close() },
        onDead: handler => { transport.onDeath(handler) },
      }
    },
  }
}

/**
 * Present the ACP client as the incremental frame port the runner expects.
 *
 * The runner installs one handler at construction; every inbound frame then
 * reaches it as it lands, which is what lets text reach the UI while the agent
 * is still working.
 */
export function adaptClient(client: AcpClient): AcpClientPort {
  return {
    request: (method, params) => client.request(method, params),
    notify: (method, params) => { client.notify(method, params) },
    onFrame: handler => { client.onFrame(frame => { handler(frame) }) },
  }
}
