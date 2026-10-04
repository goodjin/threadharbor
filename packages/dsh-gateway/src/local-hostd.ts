/** Restart a loopback threadharbor-hostd using the gateway's current artifact. */

import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { connect } from 'node:net'
import { join, resolve } from 'node:path'

function tokenAfter(tokens: readonly string[], flag: string): string | undefined {
  const index = tokens.indexOf(flag)
  if (index < 0) return undefined
  const value = tokens[index + 1]
  return value === undefined || value.startsWith('-') ? undefined : value
}

export function parseHostdCommand(command: string): { readonly port?: number; readonly dataDir?: string } | undefined {
  if (!/threadharbor-hostd|hostd[/\\]lib[/\\]bin\.js/.test(command)) return undefined
  const tokens = command.trim().split(/\s+/)
  const portToken = tokenAfter(tokens, '--port')
  const dataDir = tokenAfter(tokens, '--data-dir')
  const port = portToken !== undefined && /^\d+$/.test(portToken) ? Number(portToken) : undefined
  return {
    ...(port === undefined ? {} : { port }),
    ...(dataDir === undefined ? {} : { dataDir }),
  }
}

/**
 * Paths the OS may clear on reboot or sooner. A hostd launched with
 * `--data-dir` under one of these (e.g. a manual `mktemp -d` from a previous
 * developer) would lose `sessions.json` and every hold journal the moment the
 * temp area gets reaped.
 */
const EPHEMERAL_DIR_PATTERNS: readonly RegExp[] = [
  /^\/tmp\//,
  /^\/private\/tmp\//,
  /^\/var\/folders\//,
]

/**
 * Return the designed private state root for this machine's hostd.
 *
 * One root per deployment channel, mirroring the remote layout
 * (`~/.local/state/threadharbor/<channel>/hostd`) so a local hostd and an SSH
 * host never share state and switching channels never reuses another channel's
 * holds. Nothing about the path is generated: `mktemp`-style roots are exactly
 * what this function exists to replace.
 */
export function defaultHostdDataDir(channel: string): string {
  return join(homedir(), '.local', 'state', 'threadharbor', channel, 'hostd')
}

/** True when `dataDir` lives under a path the host can clear without notice. */
export function isEphemeralHostdDataDir(dataDir: string): boolean {
  const absolute = resolve(dataDir)
  if (EPHEMERAL_DIR_PATTERNS.some(pattern => pattern.test(absolute))) return true
  const systemTmp = resolve(tmpdir())
  return absolute === systemTmp || absolute.startsWith(`${systemTmp}/`)
}

/**
 * Move an ephemeral `--data-dir` onto the designed root so a hostd launched
 * against `/tmp` (a manual `mktemp -d`) does not get wiped with the temp area.
 *
 * Only an empty destination is populated. If the designed root already exists
 * — a live hostd is writing it, or a previous generation left it behind —
 * the current root is kept as-is: merging could hand two hostds the same holds,
 * and switching would strand this process's sessions, journals and secrets on
 * the ephemeral path. Consolidation is left to an operator (stop, copy, start),
 * which the caller's log line states.
 *
 * @param dataDir - the path the running hostd was launched with.
 * @param options.persistentRoot - designed root to migrate into.
 * @returns the path argv should hand to the next hostd process.
 */
export function resolveLoopbackHostdDataDir(
  dataDir: string,
  options: { readonly persistentRoot: string },
): string {
  if (!isEphemeralHostdDataDir(dataDir)) return dataDir
  const destination = options.persistentRoot
  if (existsSync(destination)) {
    process.stderr.write(
      `threadharbor-hostd: ephemeral dataDir ${dataDir} kept; designed root ${destination} already exists. `
      + 'Stop hostd, copy the ephemeral root into the designed root (or remove the empty designed root first), then start it again.\n',
    )
    return dataDir
  }
  mkdirSync(destination, { recursive: true, mode: 0o700 })
  cpSync(dataDir, destination, { recursive: true, verbatimSymlinks: true })
  process.stderr.write(`threadharbor-hostd: dataDir migrated from ephemeral ${dataDir} to ${destination}\n`)
  return destination
}

export function hostdRestartArgv(
  command: string,
  artifactBin: string,
  listenPort: number,
  persistentRoot: string,
): string[] {
  const parsed = parseHostdCommand(command)
  if (parsed === undefined) throw new Error('端口上的进程不是 threadharbor-hostd')
  if (!existsSync(artifactBin)) throw new Error(`缺少 hostd 制品 ${artifactBin}，请先构建 ThreadHarbor`)
  const originalDataDir = parsed.dataDir
  if (originalDataDir === undefined || originalDataDir === '') throw new Error('本机 hostd 没有 --data-dir，无法安全重启')
  const dataDir = resolveLoopbackHostdDataDir(originalDataDir, { persistentRoot })
  return [artifactBin, '--host', '127.0.0.1', '--port', String(parsed.port ?? listenPort), '--data-dir', dataDir]
}

function listenerPid(port: number): number | undefined {
  const lsof = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
  if (lsof.status === 0) {
    const pid = Number((lsof.stdout ?? '').trim().split(/\s+/)[0])
    if (Number.isSafeInteger(pid) && pid > 0) return pid
  }
  return undefined
}

function processCommand(pid: number): string {
  const ps = spawnSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' })
  if (ps.status !== 0) throw new Error(`无法读取本机进程 ${pid} 的启动参数`)
  return (ps.stdout ?? '').trim()
}

function wait(ms: number): Promise<void> {
  return new Promise(resolveWait => setTimeout(resolveWait, ms))
}

async function tcpOpen(host: string, port: number): Promise<boolean> {
  return await new Promise((resolveOpen) => {
    const socket = connect({ host, port })
    const settle = (open: boolean): void => {
      socket.removeAllListeners()
      socket.destroy()
      resolveOpen(open)
    }
    socket.once('connect', () => { settle(true) })
    socket.once('error', () => { settle(false) })
    socket.setTimeout(400, () => { settle(false) })
  })
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Replace the loopback hostd listening on `port` with the current artifact. */
export async function restartLoopbackHostd(
  port: number,
  artifactDirectory: string,
  persistentRoot: string,
): Promise<void> {
  const pid = listenerPid(port)
  if (pid === undefined) throw new Error('找不到本机 hostd 进程。请确认它仍在监听后再点升级。')
  const command = processCommand(pid)
  const argv = hostdRestartArgv(command, join(artifactDirectory, 'bin.js'), port, persistentRoot)
  process.kill(pid, 'SIGTERM')
  const deadline = Date.now() + 8_000
  while (processAlive(pid) && Date.now() < deadline) await wait(50)
  if (processAlive(pid)) {
    process.kill(pid, 'SIGKILL')
    await wait(100)
  }
  const child = spawn(process.execPath, argv, {
    detached: true,
    stdio: 'ignore',
    env: process.env,
    windowsHide: true,
  })
  child.unref()
  const readyDeadline = Date.now() + 8_000
  while (Date.now() < readyDeadline) {
    if (await tcpOpen('127.0.0.1', port)) return
    await wait(50)
  }
  throw new Error('本机 hostd 重启后没有在端口上恢复监听')
}
