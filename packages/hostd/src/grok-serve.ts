/**
 * hostd-owned Grok agent server lifecycle.
 *
 * The Grok backend is a `grok agent serve` process bound to a loopback port.
 * Its secret used to come only from the hostd parent environment
 * (`GROK_AGENT_SECRET`). That made every hostd restart a potential secret
 * drift: a serve started by an earlier hostd generation keeps requiring its
 * old secret while the new hostd (and the hold workers it spawns) no longer
 * know it, so a session reopen silently fails inside the worker handshake.
 *
 * This module makes hostd the owner of the secret and gives the control plane
 * enough introspection to repair drift without guessing:
 *
 *  - `grok-serve-secret` (owner-only, under the dataDir) is the source of
 *    truth: generated on first use, or adopted from `GROK_AGENT_SECRET`, or
 *    recovered from the command line of an already-running serve.
 *  - The serve's command line keeps `--secret`, so a serve started by a
 *    previous hostd generation can be claimed non-destructively (adopt).
 *  - `probe` verifies the WebSocket handshake with a candidate secret instead
 *    of trusting "a TCP port is open", which is how the mismatch used to slip
 *    through until a hold worker failed.
 */

import { existsSync, readFileSync, writeFileSync, openSync, readSync, statSync, closeSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { readdir, readFile, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import WebSocket from 'ws'

const execFileAsync = promisify(execFile)

/** Secret file lives beside `sessions.json` and `host-id`. */
export function grokServeSecretPath(dataDir: string): string {
  return join(dataDir, 'grok-serve-secret')
}

const SECRET_RE = /^[0-9a-fA-F-]{10,64}$/u

function isPlausibleSecret(value: string): boolean {
  return SECRET_RE.test(value)
}

/**
 * Resolve the secret hostd owns for `grok agent serve`.
 *
 * Precedence: persisted file (canonical, survives restarts) → parent env
 * (legacy deployments; written to the file so the next restart keeps it) →
 * freshly generated. Never throws; generation failures surface on the caller
 * as a conflict/install error instead.
 */
export function resolveGrokServeSecret(dataDir: string, envSecret: string | undefined): string {
  const path = grokServeSecretPath(dataDir)
  if (existsSync(path)) {
    const persisted = readFileSync(path, 'utf8').trim()
    if (persisted !== '' && isPlausibleSecret(persisted)) return persisted
  }
  const candidate = envSecret !== undefined && envSecret !== ''
    ? envSecret
    : randomUUID()
  writeFileSync(path, `${candidate}\n`, { mode: 0o600 })
  return candidate
}

/** Overwrite the persisted secret (adopt). Caller verifies reachability. */
export function persistGrokServeSecret(dataDir: string, secret: string): void {
  writeFileSync(grokServeSecretPath(dataDir), `${secret}\n`, { mode: 0o600 })
}

/**
 * Verify a Grok agent server accepts WebSocket connections with this secret.
 * A real handshake is the only honest check: `tcpOpen` cannot distinguish a
 * keyed serve from any other listener on the port.
 */
export async function probeGrokServe(
  host: string,
  port: number,
  secret: string,
  timeoutMs = 3_000,
): Promise<boolean> {
  return await new Promise<boolean>((resolveProbe) => {
    let settled = false
    let socket: WebSocket | undefined
    // Listeners stay attached after settle: a late `error`/`close` (e.g. the
    // server never answered and the timeout closed a CONNECTING socket) must
    // be a no-op instead of an unhandled WebSocket error.
    const settle = (open: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // terminate() (not close()) hard-drops the TCP socket even while the
      // handshake is still CONNECTING, so a listener that never answers cannot
      // keep a connection open and block a later server.close().
      try { socket?.terminate() } catch { /* ignore */ }
      resolveProbe(open)
    }
    const timer = setTimeout(() => { settle(false) }, timeoutMs)
    try {
      socket = new WebSocket(`ws://${host}:${port}/ws?server-key=${encodeURIComponent(secret)}`)
    } catch {
      settle(false)
      return
    }
    socket.on('open', () => { settle(true) })
    socket.on('error', () => { settle(false) })
    socket.on('close', () => { settle(false) })
  })
}

/** Read `st`, `st6`, `tcp`, `tcp6` listener inode for a numeric port (Linux). */
async function linuxListenerInode(port: number): Promise<number | undefined> {
  const wanted = port.toString(16).toLowerCase()
  for (const file of ['tcp', 'tcp6']) {
    let text: string
    try {
      text = await readFile(`/proc/net/${file}`, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n').slice(1)) {
      const columns = line.trim().split(/\s+/)
      if (columns.length < 10) continue
      // local_address is HEX:IP:HEX:PORT; LISTEN state is 0A.
      const local = columns[1]
      if (columns[3] !== '0A') continue
      if (local === undefined) continue
      const separator = local.lastIndexOf(':')
      if (separator === -1) continue
      if (local.slice(separator + 1).toLowerCase() !== wanted) continue
      const inode = Number(columns[9])
      if (Number.isSafeInteger(inode) && inode > 0) return inode
    }
  }
  return undefined
}

/** Map a socket inode to the owning pid (Linux). */
async function linuxPidForInode(inode: number): Promise<number | undefined> {
  let entries: string[]
  try {
    entries = await readdir('/proc')
  } catch {
    return undefined
  }
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue
    const fdDir = `/proc/${entry}/fd`
    let fds: string[]
    try {
      fds = await readdir(fdDir)
    } catch {
      continue // process exited or not ours
    }
    for (const fd of fds) {
      try {
        const target = await readlink(join(fdDir, fd))
        if (target === `socket:[${inode}]`) return Number(entry)
      } catch {
        // fd vanished between readdir and readlink
      }
    }
  }
  return undefined
}

/** Find the pid currently LISTENing on a TCP port, or undefined. */
export async function findTcpListenerPid(port: number): Promise<number | undefined> {
  if (process.platform === 'linux') {
    const inode = await linuxListenerInode(port)
    if (inode !== undefined) return await linuxPidForInode(inode)
    return undefined
  }
  // macOS/BSD: lsof is shipped with the OS and gives a reliable answer.
  // The protocol spec must be a single token (`-iTCP:port`), matching how
  // macOS lsof parses `-i` arguments.
  for (const command of ['/usr/sbin/lsof', 'lsof']) {
    try {
      const { stdout } = await execFileAsync(
        command,
        ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'],
        { timeout: 3_000 },
      )
      for (const line of stdout.split('\n')) {
        if (line.startsWith('p')) {
          const pid = Number(line.slice(1))
          if (Number.isSafeInteger(pid) && pid > 0) return pid
        }
      }
      return undefined
    } catch {
      // try the next candidate; no match is a valid outcome too
    }
  }
  return undefined
}

/** Read a process's command line (space-joined argv). */
export async function readProcessCommandLine(pid: number): Promise<string | undefined> {
  if (process.platform === 'linux') {
    try {
      const raw = await readFile(`/proc/${pid}/cmdline`)
      return raw.toString('utf8').split('\0').filter(part => part !== '').join(' ')
    } catch {
      return undefined
    }
  }
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command='], { timeout: 3_000 })
    return stdout.trim() === '' ? undefined : stdout.trim()
  } catch {
    return undefined
  }
}

/** Whether a command line looks like a `grok agent serve --bind <port>` process. */
export function looksLikeGrokAgentServe(commandLine: string | undefined, port: number): boolean {
  if (commandLine === undefined || commandLine === '') return false
  const portToken = commandLine.includes(`:${port}`)
    || commandLine.includes(`--bind ${port}`)
    || commandLine.includes(`--bind=127.0.0.1:${port}`)
  const isGrokServe = /(^|\/|\s)grok[\w.-]*(\s|$)/iu.test(commandLine)
    && /\bagent\s+serve\b/iu.test(commandLine)
  return isGrokServe && portToken
}

/** Extract the `--secret <value>` (or `--secret=<value>`) from a serve command line. */
export function grokServeSecretFromCommandLine(commandLine: string | undefined): string | undefined {
  if (commandLine === undefined) return undefined
  const separated = /\s--secret\s+(\S+)/iu.exec(commandLine)
  if (separated !== null && isPlausibleSecret(separated[1]!)) return separated[1]
  const assigned = /--secret=(\S+)/iu.exec(commandLine)
  if (assigned !== null && isPlausibleSecret(assigned[1]!)) return assigned[1]
  return undefined
}

/** Send SIGTERM (then SIGKILL after the grace period) and wait for exit. */
export async function stopProcess(pid: number, graceMs = 4_000): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return // already gone
  }
  const deadline = Date.now() + graceMs + 2_000
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return // exited
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 150))
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // gone between the poll and the kill
  }
}

/** Last `maxChars` of a file (worker startup log tails); undefined when absent. */
export function readFileTail(path: string, maxChars = 4_000): string | undefined {
  try {
    const size = statSync(path).size
    const fd = openSync(path, 'r')
    try {
      if (size === 0) return ''
      const start = Math.max(0, size - maxChars)
      const buffer = Buffer.alloc(size - start)
      readSync(fd, buffer, 0, buffer.length, start)
      return buffer.toString('utf8').replace(/\0+$/gu, '').trim()
    } finally {
      closeSync(fd)
    }
  } catch {
    return undefined
  }
}
