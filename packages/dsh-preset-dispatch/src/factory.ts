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
import type { AcpDialect, PermissionDecision, PermissionRequest } from '@threadharbor/dsh-acp-agent'
import type { AcpSession, AcpSessionFactory, PresetConfig } from './registry.ts'
import { AcpTurnRunner } from './runner.ts'
import type { AcpClientPort } from './runner.ts'

export type FactoryDeps = {
  /** Answer an agent-initiated permission request. */
  answerPermission(request: PermissionRequest): Promise<PermissionDecision>
}

/** Which frame dialect an agent speaks. Unknown agents are not ours. */
const DIALECTS: Readonly<Record<string, AcpDialect>> = {
  grok: grokDialect,
  claude: claudeDialect,
  codex: codexDialect,
}

export function makeSessionFactory(config: PresetConfig, deps: FactoryDeps): AcpSessionFactory {
  return {
    dialectFor: (_presetId, preset) => DIALECTS[preset.agent ?? ''],

    open: (presetId, options): AcpSession => {
      const preset = config.presets[presetId]
      if (preset === undefined) throw new Error(`acp dispatch: no preset named ${presetId}`)

      const transport = preset.url !== undefined
        ? new WebSocketAcpTransport({ url: preset.url })
        : new StdioAcpTransport({ command: preset.command ?? '' })

      const client = new AcpClient(transport, DIALECTS[preset.agent ?? ''] ?? grokDialect)
      // grok delegates shell execution to the client. Without this the agent
      // waits for a terminal that never appears, and the turn hangs silently.
      client.terminals = new TerminalService()
      client.onPermissionRequest = async request => await deps.answerPermission(request)

      const runner = new AcpTurnRunner(adapt(client), options)
      return { run: async decision => await runner.run(decision) }
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
function adapt(client: AcpClient): AcpClientPort {
  return {
    request: (method, params) => client.request(method, params),
    notify: (method, params) => { client.notify(method, params) },
    onFrame: handler => { client.onFrame(frame => { handler(frame) }) },
  }
}
