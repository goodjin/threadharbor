/**
 * The client-side half of ACP's terminal sub-protocol.
 *
 * Some agents — grok among them — do not run shell commands themselves. They ask
 * the client to, and then poll for the result. A client that serves the first
 * call but not the rest looks like it half-works: the turn finishes, but the tool
 * result is a complaint that a later call could not be served.
 *
 * The spawn step is injected on purpose. DSH rejected this sub-protocol for its
 * own runtime because routing execution to the client forks it into a second
 * backend and bypasses its env scrub and background-task ownership
 * (`reference/deepseek-harness/.agents/notes/archived/feature/
 * 2026-06-18-acp-terminal-and-tool-rendering.md`). Keeping spawn injectable lets
 * a host run the process its own way while still serving an agent that insists
 * on this shape.
 */

import { spawn } from 'node:child_process'

/** A running process, however the host chose to start it. */
export type SpawnedCommand = {
  /** Everything written so far, stdout and stderr together. */
  output(): string
  /** Settles with the exit code once the process ends. */
  readonly exited: Promise<number>
  kill(): void
}

export type TerminalSpec = {
  readonly command: string
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
}

export type TerminalExitStatus = {
  readonly exitCode: number
  readonly signal: string | null
}

/**
 * The three fields ACP names for `terminal/output`.
 *
 * All three are named in the spec, and a strict decoder rejects a response
 * that is missing one — so they are always present rather than omitted when
 * they have nothing to say.
 */
export type TerminalStatus = {
  readonly output: string
  readonly exitStatus: TerminalExitStatus | null
  readonly truncated: boolean
}

/**
 * Spawn through a plain shell.
 *
 * The command arrives already assembled (`"/bin/bash -lc '...'"`), so it is run
 * as one line rather than re-parsed into argv — splitting it here would break on
 * the quoting the agent chose.
 */
function spawnInShell(spec: TerminalSpec): SpawnedCommand {
  const child = spawn(spec.command, {
    shell: true,
    ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(spec.env === undefined ? {} : { env: spec.env }),
  })
  let buffer = ''
  const collect = (chunk: Buffer | string) => { buffer += String(chunk) }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  return {
    output: () => buffer,
    exited: new Promise<number>(resolve => {
      child.on('close', code => resolve(code ?? 0))
      // A spawn failure (no such binary) must settle, not hang: an unsettled
      // `exited` is exactly the silent stall this whole layer exists to avoid.
      child.on('error', () => resolve(127))
    }),
    kill: () => { child.kill('SIGTERM') },
  }
}

type Entry = {
  readonly command: SpawnedCommand
  /** Once the process has ended, the exit status; undefined while running. */
  exitStatus?: TerminalExitStatus
}

export class TerminalService {
  private readonly terminals = new Map<string, Entry>()
  private nextId = 1

  constructor(private readonly options: { readonly spawn?: (spec: TerminalSpec) => SpawnedCommand } = {}) {}

  /**
   * Start a command, as `terminal/create` expects.
   *
   * Returns as soon as the terminal exists — it does **not** wait for the
   * process. Blocking here would make a long command look like a hung protocol
   * call, and the exit code is what `wait_for_exit` is for.
   */
  async create(spec: TerminalSpec): Promise<{ terminalId: string }> {
    const command = this.options.spawn?.(spec) ?? spawnInShell(spec)
    const terminalId = `term-${this.nextId++}`
    const entry: Entry = { command }
    void command.exited.then(exitCode => { entry.exitStatus = { exitCode, signal: null } })
    this.terminals.set(terminalId, entry)
    // Only a terminal id. ACP's CreateTerminalResponse names no output field,
    // and an extra one makes a strict decoder reject the whole response.
    return { terminalId }
  }

  /** Block until the command ends, as `terminal/wait_for_exit` expects. */
  async waitForExit(terminalId: string): Promise<TerminalExitStatus> {
    const entry = this.require(terminalId)
    const exitCode = await entry.command.exited
    const status: TerminalExitStatus = { exitCode, signal: null }
    entry.exitStatus = status
    return status
  }

  /** Everything written so far, as `terminal/output` expects. */
  async output(terminalId: string): Promise<TerminalStatus> {
    const entry = this.require(terminalId)
    return { output: entry.command.output(), exitStatus: entry.exitStatus ?? null, truncated: false }
  }

  async kill(terminalId: string): Promise<Record<never, never>> {
    this.require(terminalId).command.kill()
    return {}
  }

  async release(terminalId: string): Promise<Record<never, never>> {
    this.require(terminalId)
    this.terminals.delete(terminalId)
    return {}
  }

  private require(terminalId: string): Entry {
    const entry = this.terminals.get(terminalId)
    // Saying "unknown terminal" beats answering as if it succeeded: the agent
    // can then report the failure instead of waiting on output that never comes.
    if (entry === undefined) throw new Error(`unknown terminal ${terminalId}`)
    return entry
  }
}