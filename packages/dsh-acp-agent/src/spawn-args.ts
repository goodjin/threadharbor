/**
 * What a stdio agent has to be told before it speaks ACP.
 *
 * Some of these binaries are the ACP service themselves: `claude-agent-acp` and
 * `codex-acp` speak JSON-RPC over stdio the moment they start, and need no
 * arguments. Cursor's binary is a general-purpose CLI that only becomes a
 * service when told to — run bare it is the interactive agent, which sits on
 * stdin waiting for a terminal and never answers a JSON-RPC line. That failure
 * is nasty precisely because the process stays alive: the handshake waits out
 * its full deadline and reports "the agent did not answer", which reads like a
 * slow agent rather than a missing subcommand. `acp` selects the service and
 * `--trust` answers the trust prompt it would otherwise stop to ask.
 *
 * Lives here, beside the dialects, rather than in whoever spawns: the same fact
 * is needed by the live probes and by production, and a second copy is how the
 * two drift apart — which is exactly how a fixed probe kept passing over a
 * broken deployment.
 */

import type { AcpDialect } from './dialects/types.ts'

/** Arguments per agent id; absent means the binary is the service itself. */
const ARGS_BY_AGENT: Readonly<Record<string, readonly string[]>> = {
  cursor: ['acp', '--trust'],
}

/**
 * The arguments this agent is spawned with when a caller names none.
 *
 * @param agent - the agent id from the preset configuration.
 * @returns the arguments, empty for an agent whose binary is already the service.
 */
export function stdioArgsFor(agent: string | undefined): readonly string[] {
  if (agent === undefined) return []
  return ARGS_BY_AGENT[agent] ?? []
}

/**
 * The arguments one dialect's agent is spawned with when a caller names none.
 *
 * @param dialect - the dialect the preset resolved to.
 * @returns the arguments, empty for an agent whose binary is already the service.
 */
export function stdioArgsForDialect(dialect: AcpDialect): readonly string[] {
  return stdioArgsFor(dialect.id)
}