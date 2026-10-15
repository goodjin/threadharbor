/**
 * Liveness probing for a peer host, read from that machine over SSH.
 *
 * The record file only says ThreadHarbor was installed; whether the DSH web
 * process is actually up must be asked on the machine itself. This module
 * builds the probe (a small portable shell script), classifies its outcome by
 * exit status, and combines record + probe into the honest `PeerReport`.
 */

import type { PeerStatus } from './peer-status.ts'
import { shellQuote } from './parse.ts'

/** Liveness as measured on the remote machine itself, never guessed. */
export type Liveness = 'running' | 'stopped' | 'unknown'

/** A peer record extended with what the probe on that machine observed. */
export type PeerReport = PeerStatus & {
  readonly liveness: Liveness
  readonly livenessNote?: string
}

// No single quotes inside: the snippet is embedded in a single-quoted shell
// string by buildLivenessProbe. Any HTTP answer (200/401/403/…) exits 0;
// connection refused exits 7; a 2 s stall exits 28; anything else exits 1.
const NODE_PROBE = 'const http=require("http");const req=http.get(process.argv[1],{timeout:2000},(res)=>{res.resume();process.exit(0)});req.on("timeout",()=>{req.destroy();process.exit(28)});req.on("error",(e)=>{process.exit(e&&e.code==="ECONNREFUSED"?7:1)});'

/**
 * Build the remote liveness probe for the DSH web port.
 *
 * The returned text is spliced into a script owned by the caller and makes
 * exactly these assumptions about its environment, all guaranteed by the SSH
 * exec that runs it: `set -eu` is already active, and `$HOME`/`PATH` are set.
 * The text extends `PATH` itself with common tool locations, so no particular
 * `PATH` layout is assumed beyond that.
 *
 * Output contract (classification keys on these exit statuses, not on HTTP
 * codes — the remote DSH requires a token, so 401/403 still mean the process
 * is up): curl is tried first, then node; an HTTP answer prints RUNNING and
 * exits 0, connection refused prints STOPPED and exits 7, and any other tool
 * failure — including the 2 s per-tool timeout — exits with the tool's own
 * code, so the exit status that reaches classification carries the real
 * cause. Only when neither tool exists does it print UNKNOWN and exit 1.
 */
export function buildLivenessProbe(port: number): string {
  const url = shellQuote(`http://127.0.0.1:${port}/`)
  return [
    'PATH="$HOME/.local/bin:$HOME/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"',
    `url=${url}`,
    'if command -v curl >/dev/null 2>&1; then',
    '  curl_code=0',
    '  curl -sS -m 2 -o /dev/null -w \'%{http_code}\' "$url" >/dev/null 2>&1 || curl_code=$?',
    '  case "$curl_code" in',
    '    0) echo RUNNING; exit 0 ;;',
    '    7) echo STOPPED; exit 7 ;;',
    '    *) exit "$curl_code" ;;',
    '  esac',
    'fi',
    'if command -v node >/dev/null 2>&1; then',
    '  node_code=0',
    `  node -e ${shellQuote(NODE_PROBE)} "$url" || node_code=$?`,
    '  case "$node_code" in',
    '    0) echo RUNNING; exit 0 ;;',
    '    7) echo STOPPED; exit 7 ;;',
    '    *) exit "$node_code" ;;',
    '  esac',
    'fi',
    'echo UNKNOWN',
    'exit 1',
  ].join('\n')
}

/**
 * Classify a probe run by its exit status, never by the HTTP status code.
 *
 * The exit status is authoritative: exit 0 is `running` — any HTTP answer at
 * all counts, including 401/403 — even if stdout disagrees. Exit 7 (connection
 * refused) is `stopped`. A stdout of UNKNOWN is the script's neither-tool
 * fallback and reads as bare `unknown`. Everything else is `unknown` with the
 * exit code in the note; the probe script passes a timeout through as its own
 * exit code (curl's 28), so it lands here with the cause in the note — calling
 * a slow machine stopped would invite a needless redeploy.
 */
export function classifyLiveness(probe: { readonly code: number; readonly stdout: string }): {
  readonly liveness: Liveness
  readonly note?: string
} {
  if (probe.code === 0) return { liveness: 'running' }
  if (probe.stdout.includes('UNKNOWN')) return { liveness: 'unknown' }
  if (probe.code === 7) return { liveness: 'stopped' }
  return { liveness: 'unknown', note: `探测退出码 ${probe.code}` }
}

/**
 * Combine the peer record and the probe result into the honest report.
 *
 * No installed bundle means no port to probe: the record stays undeployed and
 * the liveness stays `unknown`, whatever the probe says. Installed without a
 * port in the record is deployed but unprobeable — `unknown` with a note.
 * Anything else is decided by `classifyLiveness`.
 */
export function decidePeerReport(
  peer: PeerStatus,
  probe: { readonly code: number; readonly stdout: string } | undefined,
): PeerReport {
  if (!peer.pluginsInstalled) return { ...peer, liveness: 'unknown' }
  if (peer.port === undefined) {
    return { ...peer, liveness: 'unknown', livenessNote: '记录里没有端口，无法探测存活' }
  }
  if (probe === undefined) return { ...peer, liveness: 'unknown' }
  const verdict = classifyLiveness(probe)
  return {
    ...peer,
    liveness: verdict.liveness,
    ...(verdict.note === undefined ? {} : { livenessNote: verdict.note }),
  }
}
