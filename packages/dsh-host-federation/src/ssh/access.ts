/**
 * How a deployed DSH Web instance is reached from the operator's browser.
 */

import type { SshAccessMode } from './types.ts'
import type { PeerStatus } from './peer-status.ts'

const FORBIDDEN_BIND = new Set(['0.0.0.0', '::', '[::]', '*', '0'])

/** One honest decision about how this peer can be used right now. */
export type ConnectionPlan = {
  /** `tunnel` opens a local SSH forward; `direct` opens the recorded origin as-is. */
  readonly mode: 'tunnel' | 'direct'
  /** The remote port a tunnel must forward. */
  readonly remotePort: number
  /** The tokenized launch URL the plan is built from. */
  readonly launchUrl: string
}

/**
 * Decide how to reach a peer from the facts its record states — no guessing.
 *
 * Every refusal names the next operator action: install first, redeploy for a
 * token, or name a port to forward to. Refusals throw; the route passes the
 * text on untouched.
 */
export function planConnection(
  peer: PeerStatus,
  callerPort: number | undefined,
  defaultPort: number | undefined,
): ConnectionPlan {
  if (!peer.pluginsInstalled) {
    throw new Error('远端还没有 ThreadHarbor 部署记录（未安装或未成功启动）；请先执行一次部署')
  }
  const launchUrl = peer.launchUrl
  if (launchUrl === undefined || launchUrl === '') {
    throw new Error('远端记录里没有带令牌的启动网址；请重新部署（可勾选升级）以刷新记录')
  }
  if (peer.listen === 'tailscale') {
    return { mode: 'direct', remotePort: peer.port ?? defaultPort ?? 0, launchUrl }
  }
  const remotePort = peer.port ?? callerPort ?? defaultPort
  if (remotePort === undefined) {
    throw new Error('记录里没有远端网页端口，也没有可用的默认端口；请重新部署')
  }
  return { mode: 'tunnel', remotePort, launchUrl }
}

/** Deploy always listens on loopback and is reached through an SSH tunnel. */
export function parseAccessMode(value: unknown): SshAccessMode {
  if (value === 'serve') return 'serve'
  if (value === undefined || value === null || value === 'tunnel' || value === 'host-ip' || value === 'tailscale' || value === 'custom') {
    return 'tunnel'
  }
  throw new Error('accessMode must be tunnel or serve')
}

export function validateBindHost(input: string): string {
  const trimmed = input.trim()
  if (trimmed === '') throw new Error('bindHost 不能为空')
  const lower = trimmed.toLowerCase()
  if (FORBIDDEN_BIND.has(lower) || lower.includes('0.0.0.0')) {
    throw new Error('不允许绑定 0.0.0.0 或通配地址')
  }
  return trimmed
}

export function optionalHost(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new Error(`${name} must be a string`)
  return value.trim()
}

/**
 * Build the browser open URL on the managing machine.
 * For tunnel mode the remote log prints 127.0.0.1:remotePort; swap to the local forward port.
 */
export function composeLaunchUrl(endpointOrigin: string, remoteLaunchUrl: string): string {
  let remote: URL
  let local: URL
  try {
    remote = new URL(remoteLaunchUrl)
    local = new URL(endpointOrigin)
  } catch {
    return remoteLaunchUrl
  }
  const token = remote.searchParams.get('token')
  if (token === null || token === '') return endpointOrigin
  local.searchParams.set('token', token)
  return local.toString()
}

export function parseDeployMarkers(stdout: string): {
  readonly alreadyRunning: boolean
  readonly launchUrl?: string
  readonly bindHost?: string
} {
  let alreadyRunning = false
  let launchUrl: string | undefined
  let bindHost: string | undefined
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('ALREADY_RUNNING=1')) alreadyRunning = true
    if (line.startsWith('LAUNCH_URL=')) {
      const value = line.slice('LAUNCH_URL='.length).trim()
      if (value !== '') launchUrl = value
    }
    if (line.startsWith('BIND_HOST=')) {
      const value = line.slice('BIND_HOST='.length).trim()
      if (value !== '') bindHost = value
    }
  }
  return { alreadyRunning, ...(launchUrl === undefined ? {} : { launchUrl }), ...(bindHost === undefined ? {} : { bindHost }) }
}
