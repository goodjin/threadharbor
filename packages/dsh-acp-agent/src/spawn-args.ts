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
  // Qoder's CLI is the interactive agent bare; `--acp` turns it into the
  // JSON-RPC service (measured 2026-10-20 on qoder-cli-cn 1.1.6).
  qoder: ['--acp'],
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

/**
 * Environment variables a launched-from-the-IDE binary must not inherit.
 *
 * Qoder's CLI shares the Claude Agent SDK's entrypoint detection with the Qoder
 * IDE: with the IDE's `QODER_AGENT_SDK_ENTRYPOINT` (and friends) inherited, a
 * plain `qoderclicn --acp` decides it was started as an SDK worker and dies with
 * `sdk_invalid_args: Agent SDK entrypoint env is set but required flags are
 * missing` before it reads a single frame. The IDE also exports VS Code IPC
 * handles that mean nothing to a headless child. Measured 2026-10-20.
 */
const SCRUBBED_ENV_PREFIXES: Readonly<Record<string, readonly RegExp[]>> = {
  qoder: [/^QODER/, /^CLAUDE/, /^VSCODE/, /^__CFBundle/, /^__QODER/],
}

/**
 * The environment one agent's child process gets.
 *
 * Spawn REPLACES the environment when given one, so a filtered copy has to be
 * complete. `undefined` means "inherit as-is", which is right for every agent
 * whose IDE does not inject startup flags into its CLI.
 *
 * @param agent - the agent id from the preset configuration.
 * @param base - the environment to filter; defaults to this process's.
 * @returns the complete child environment, or undefined to inherit.
 */
export function stdioEnvFor(agent: string | undefined, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv | undefined {
  if (agent === undefined) return undefined
  const scrubbed = SCRUBBED_ENV_PREFIXES[agent]
  if (scrubbed === undefined) return undefined
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) {
    if (scrubbed.some(pattern => pattern.test(key))) continue
    env[key] = value
  }
  return env
}