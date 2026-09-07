#!/usr/bin/env node
/** `threadharbor-hostd` executable. Credentials are read only from this host process. */

import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { Command } from 'commander'
import { inheritLoginProxy } from './login-proxy.ts'
import { defaultHoldWorkerScript, RemoteAgentHostd, type HostdOptions } from './server.ts'

interface CliOptions {
  host: string
  port: string
  dataDir: string
  maxRequestBytes: string
  operationTimeoutMs: string
  workerStartupTimeoutMs: string
  maxJournalEvents: string
  maxJournalBytes: string
  maxDirectoryEntries: string
  authTimeoutMs: string
  installTimeoutMs: string
  promptTimeoutMs: string
  maxAgentConfigBytes: string
  codexCliCommand?: string
  codexCommand?: string
  codexArg: string[]
  claudeCommand?: string
  claudeAcpCommand?: string
  claudeAcpArg: string[]
  dshCommand?: string
  dshArg: string[]
  dshProvider: string
  dshModel: string
  grokCommand?: string
  grokServePort: string
  grokArg: string[]
  workerScript: string
}

function integer(value: string, name: string, minimum: number): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`${name} must be an integer >= ${minimum}`)
  return parsed
}

/** Parse CLI options and run until a termination signal closes the listener.
 * @param argv - process arguments including the executable and script slots.
 */
export async function runHostd(argv: readonly string[] = process.argv): Promise<void> {
  const command = new Command()
    .name('threadharbor-hostd')
    .description('Persistent local supervisor for Grok, Codex ACP, and DeepSeek Harness SDK sessions')
    .option('--host <host>', 'listen host (loopback only)', '127.0.0.1')
    .option('--port <port>', 'listen port, zero asks the OS', '3091')
    .option('--data-dir <path>', 'hostd private state root', join(homedir(), '.local', 'state', 'threadharbor'))
    .option('--max-request-bytes <bytes>', 'maximum control request body', '1048576')
    .option('--operation-timeout-ms <ms>', 'native RPC and hold operation timeout', '45000')
    .option('--worker-startup-timeout-ms <ms>', 'detached worker/Grok startup timeout', '15000')
    .option('--max-journal-events <count>', 'native frames retained per hold', '4000')
    .option('--max-journal-bytes <bytes>', 'native journal bytes retained per hold', '8388608')
    .option('--max-directory-entries <count>', 'fs.list entry limit', '1000')
    .option('--auth-timeout-ms <ms>', 'detached login timeout', '900000')
    .option('--install-timeout-ms <ms>', 'agent installation timeout', '600000')
    .option('--prompt-timeout-ms <ms>', 'session/prompt response timeout; on expiry the hold-worker synthesizes a timeout completion', '600000')
    .option('--max-agent-config-bytes <bytes>', 'maximum Agent user configuration size', '262144')
    .option('--codex-cli-command <path>', 'Codex CLI executable; defaults to codex on PATH')
    .option('--codex-command <path>', 'Codex ACP executable; defaults to codex-acp on PATH')
    .option('--codex-arg <arg...>', 'Codex ACP arguments', [])
    .option('--claude-command <path>', 'Claude Code executable; defaults to claude on PATH')
    .option('--claude-acp-command <path>', 'Claude Code ACP executable; defaults to claude-agent-acp on PATH')
    .option('--claude-acp-arg <arg...>', 'Claude Code ACP arguments', [])
    .option('--dsh-command <path>', 'Harness JSON-RPC executable; defaults to dsh-jsonrpc-agent on PATH')
    .option('--dsh-arg <arg...>', 'Harness JSON-RPC arguments; otherwise use DSH_CORDIS_CONFIG', [])
    .option('--dsh-provider <name>', 'Harness SDK provider route', 'deepseek-official')
    .option('--dsh-model <name>', 'Harness SDK model', 'deepseek-v4-flash')
    .option('--grok-command <path>', 'Grok executable; defaults to grok on PATH')
    .option('--grok-serve-port <port>', 'loopback Grok agent server port', '2419')
    .option('--grok-arg <arg...>', 'arguments prepended before `agent serve`', [])
    .option('--worker-script <path>', 'detached hold-worker JavaScript entry', defaultHoldWorkerScript())
  command.parse([...argv])
  inheritLoginProxy()
  const cli = command.opts<CliOptions>()
  if (cli.host !== '127.0.0.1') throw new Error('threadharbor-hostd only binds 127.0.0.1; use an SSH tunnel for remote hosts')
  const options: HostdOptions = {
    host: '127.0.0.1',
    port: integer(cli.port, 'port', 0),
    dataDir: resolve(cli.dataDir),
    maxRequestBytes: integer(cli.maxRequestBytes, 'max-request-bytes', 1),
    operationTimeoutMs: integer(cli.operationTimeoutMs, 'operation-timeout-ms', 1),
    workerStartupTimeoutMs: integer(cli.workerStartupTimeoutMs, 'worker-startup-timeout-ms', 1),
    maxJournalEvents: integer(cli.maxJournalEvents, 'max-journal-events', 1),
    maxJournalBytes: integer(cli.maxJournalBytes, 'max-journal-bytes', 1),
    maxDirectoryEntries: integer(cli.maxDirectoryEntries, 'max-directory-entries', 1),
    authTimeoutMs: integer(cli.authTimeoutMs, 'auth-timeout-ms', 1),
    installTimeoutMs: integer(cli.installTimeoutMs, 'install-timeout-ms', 1),
    promptTimeoutMs: integer(cli.promptTimeoutMs, 'prompt-timeout-ms', 1),
    agentConfigHome: homedir(),
    maxAgentConfigBytes: integer(cli.maxAgentConfigBytes, 'max-agent-config-bytes', 1),
    codexCliCommand: cli.codexCliCommand ?? 'codex',
    codexCommand: cli.codexCommand ?? 'codex-acp',
    codexArgs: cli.codexArg,
    claudeCommand: cli.claudeCommand ?? 'claude',
    claudeAcpCommand: cli.claudeAcpCommand ?? 'claude-agent-acp',
    claudeAcpArgs: cli.claudeAcpArg,
    dshCommand: cli.dshCommand ?? 'dsh-jsonrpc-agent',
    dshArgs: cli.dshArg,
    dshProvider: cli.dshProvider,
    dshModel: cli.dshModel,
    grokCommand: cli.grokCommand ?? 'grok',
    grokServeHost: '127.0.0.1',
    grokServePort: integer(cli.grokServePort, 'grok-serve-port', 1),
    grokArgs: cli.grokArg,
    workerScript: resolve(cli.workerScript),
    hostdHttpFallback: false,
  }
  const hostd = new RemoteAgentHostd(options)
  await hostd.start()
  process.stdout.write(`threadharbor-hostd listening on http://${options.host}:${hostd.port}\n`)
  let closing = false
  const close = async (): Promise<void> => {
    if (closing) return
    closing = true
    await hostd.close()
  }
  process.once('SIGINT', () => { void close() })
  process.once('SIGTERM', () => { void close() })
}

await runHostd()
