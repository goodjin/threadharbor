/** Copy the user's login-shell proxy into hostd so Grok/Codex can reach auth.x.ai. */

import { spawnSync } from 'node:child_process'

const PROXY_NAMES = [
  'http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY',
  'all_proxy', 'ALL_PROXY', 'no_proxy', 'NO_PROXY',
] as const

const PROXY_LINE = new RegExp(
  `^export (${PROXY_NAMES.join('|')})=(?:'([^']*)'|"([^"]*)"|(\\S+))$`,
)

/** Parse `export -p` lines for HTTP/HTTPS/SOCKS proxy variables.
 * @param text - shell `export -p` output.
 */
export function parseProxyExport(text: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const match = line.match(PROXY_LINE)
    if (match === null) continue
    const name = match[1]
    const value = match[2] ?? match[3] ?? match[4]
    if (name === undefined || value === undefined || value === '') continue
    result[name] = value
  }
  return result
}

function alreadyHasProxy(): boolean {
  return process.env['https_proxy'] !== undefined
    || process.env['HTTPS_PROXY'] !== undefined
    || process.env['http_proxy'] !== undefined
    || process.env['HTTP_PROXY'] !== undefined
}

/** If hostd was started without a proxy, copy one from the user's login shell. */
export function inheritLoginProxy(): void {
  if (process.platform === 'win32' || alreadyHasProxy()) return
  const zsh = spawnSync('zsh', ['-lic', 'export -p'], {
    encoding: 'utf8', timeout: 3_000, stdio: ['ignore', 'pipe', 'ignore'],
  })
  const bash = zsh.status === 0 && typeof zsh.stdout === 'string' && zsh.stdout !== ''
    ? zsh
    : spawnSync('bash', ['-lc', 'export -p'], {
      encoding: 'utf8', timeout: 3_000, stdio: ['ignore', 'pipe', 'ignore'],
    })
  if (bash.status !== 0 || typeof bash.stdout !== 'string') return
  for (const [name, value] of Object.entries(parseProxyExport(bash.stdout))) {
    if (process.env[name] === undefined) process.env[name] = value
  }
}
