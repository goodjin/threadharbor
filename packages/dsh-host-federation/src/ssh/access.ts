/**
 * How a deployed DSH Web instance is reached from the operator's browser.
 */

import type { SshAccessMode } from './types.ts'

const FORBIDDEN_BIND = new Set(['0.0.0.0', '::', '[::]', '*', '0'])

export function parseAccessMode(value: unknown): SshAccessMode {
  if (value === undefined || value === null || value === 'host-ip') return 'host-ip'
  if (value === 'tunnel' || value === 'tailscale' || value === 'custom') return value
  throw new Error('accessMode must be host-ip, tunnel, tailscale, or custom')
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
