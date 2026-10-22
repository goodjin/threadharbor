/**
 * Read the operator's local OpenSSH config and private-key paths on the machine
 * serving DSH Web. The browser cannot see ~/.ssh; these helpers back the panel.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

export type SshConfigHostEntry = {
  /** The `Host` alias the operator would pass to `ssh`. */
  readonly alias: string
  readonly hostName?: string
  readonly user?: string
  readonly identityFile?: string
  readonly port?: number
}

const SKIP_SSH_DIR_NAMES = new Set([
  'known_hosts',
  'config',
  'authorized_keys',
  'authorized_keys2',
  'environment',
])

const PRIVATE_KEY_HINTS = /^(id_|github-|deploy|.*_rsa|.*_ed25519|.*_ecdsa|.*_dsa)$/i

function expandHome(path: string): string {
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  if (path === '~') return homedir()
  return path
}

function isWildcardHost(pattern: string): boolean {
  return pattern.includes('*') || pattern.includes('?')
}

/**
 * Parse `~/.ssh/config` into concrete Host aliases with useful fields.
 * `Match` blocks and wildcard-only Host patterns are skipped.
 */
export function listSshConfigHosts(configPath = join(homedir(), '.ssh', 'config')): readonly SshConfigHostEntry[] {
  if (!existsSync(configPath)) return []
  const text = readFileSync(configPath, 'utf8')
  const lines = text.split(/\r?\n/)
  const entries: SshConfigHostEntry[] = []
  let inMatch = false
  let aliases: string[] = []
  let hostName: string | undefined
  let user: string | undefined
  let identityFile: string | undefined
  let port: number | undefined

  const flush = (): void => {
    if (inMatch || aliases.length === 0) {
      aliases = []
      hostName = undefined
      user = undefined
      identityFile = undefined
      port = undefined
      return
    }
    for (const alias of aliases) {
      if (isWildcardHost(alias)) continue
      entries.push({
        alias,
        ...(hostName === undefined ? {} : { hostName }),
        ...(user === undefined ? {} : { user }),
        ...(identityFile === undefined ? {} : { identityFile }),
        ...(port === undefined ? {} : { port }),
      })
    }
    aliases = []
    hostName = undefined
    user = undefined
    identityFile = undefined
    port = undefined
  }

  for (const raw of lines) {
    const trimmed = raw.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const parts = trimmed.split(/\s+/)
    const keyword = parts[0]?.toLowerCase()
    const rest = parts.slice(1).join(' ').trim()
    if (keyword === 'match') {
      flush()
      inMatch = true
      continue
    }
    if (keyword === 'host') {
      flush()
      inMatch = false
      aliases = rest.split(/\s+/).filter(token => token !== '')
      continue
    }
    if (inMatch || aliases.length === 0) continue
    if (keyword === 'hostname' && rest !== '') hostName = rest
    else if (keyword === 'user' && rest !== '') user = rest
    else if (keyword === 'identityfile' && rest !== '') identityFile = expandHome(rest)
    else if (keyword === 'port') {
      const parsed = Number.parseInt(rest, 10)
      if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535) port = parsed
    }
  }
  flush()
  return entries
}

function looksLikePrivateKeyFile(name: string, fullPath: string): boolean {
  if (name.endsWith('.pub')) return false
  if (SKIP_SSH_DIR_NAMES.has(name)) return false
  try {
    const stat = statSync(fullPath)
    if (!stat.isFile()) return false
  } catch {
    return false
  }
  if (PRIVATE_KEY_HINTS.test(name)) return true
  // Custom names without extension are common; skip obvious non-keys.
  if (name.includes('.')) return false
  return true
}

/** Absolute paths to candidate private keys under `~/.ssh`. */
export function listLocalIdentityFiles(sshDir = join(homedir(), '.ssh')): readonly string[] {
  if (!existsSync(sshDir)) return []
  const names = readdirSync(sshDir)
  const paths: string[] = []
  for (const name of names) {
    if (SKIP_SSH_DIR_NAMES.has(name)) continue
    const full = join(sshDir, name)
    if (!looksLikePrivateKeyFile(name, full)) continue
    paths.push(full)
  }
  return paths.sort((a, b) => a.localeCompare(b))
}

/**
 * Open a native file picker for a private key path on this machine.
 * Returns `undefined` when the operator cancels or no picker is available.
 */
export function pickLocalIdentityFile(): string | undefined {
  const sshDir = join(homedir(), '.ssh')
  if (process.platform === 'darwin') {
    const script = 'POSIX path of (choose file with prompt "选择 SSH 私钥" of type {"public.key", "txt", "????"})'
    const result = spawnSync('osascript', ['-e', script], { encoding: 'utf8' })
    if (result.status !== 0) return undefined
    const picked = result.stdout.trim()
    return picked === '' ? undefined : picked
  }
  if (process.platform === 'linux') {
    const zenity = spawnSync('which', ['zenity'], { encoding: 'utf8' })
    if (zenity.status !== 0 || zenity.stdout.trim() === '') {
      throw new Error('本机未安装 zenity，请手输私钥路径或从列表中选择')
    }
    const result = spawnSync('zenity', [
      '--file-selection',
      '--title=选择 SSH 私钥',
      `--filename=${sshDir}/`,
    ], { encoding: 'utf8' })
    if (result.status !== 0) return undefined
    const picked = result.stdout.trim()
    return picked === '' ? undefined : picked
  }
  if (process.platform === 'win32') {
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$d = New-Object System.Windows.Forms.OpenFileDialog',
      '$d.Title = "选择 SSH 私钥"',
      '$d.InitialDirectory = $env:USERPROFILE + "\\.ssh"',
      'if ($d.ShowDialog() -eq "OK") { Write-Output $d.FileName }',
    ].join('; ')
    const result = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' })
    if (result.status !== 0) return undefined
    const picked = result.stdout.trim()
    return picked === '' ? undefined : resolve(picked)
  }
  throw new Error('当前平台不支持原生文件选择，请手输私钥路径')
}

export function basenameOfIdentity(path: string): string {
  return basename(path)
}
