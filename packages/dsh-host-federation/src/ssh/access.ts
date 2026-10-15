/**
 * How a deployed DSH Web instance is reached from the operator's browser.
 */

import type { SshAccessMode } from './types.ts'

const FORBIDDEN_BIND = new Set(['0.0.0.0', '::', '[::]', '*', '0'])

/** Deploy always listens on loopback and is reached through an SSH tunnel. */
export function parseAccessMode(value: unknown): SshAccessMode {
  if (value === undefined || value === null || value === 'tunnel' || value === 'host-ip' || value === 'tailscale' || value === 'custom') {
    return 'tunnel'
  }
  throw new Error('accessMode must be tunnel')
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

/**
 * `dsh web: <url>` 那一行里的网址（dsh 自己启动时打印的形态）。
 *
 * 与 {@link parseDeployMarkers} 分开而不是塞进去：那个函数的契约是「解析
 * deploy 写的标记」，把另一种日志形态混进去会让它的名字与行为对不上。
 * 同样遵守「最后一条赢」——日志是只追加的。
 */
export function parseStdoutLaunchLine(stdout: string): string | undefined {
  let launchUrl: string | undefined
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith('dsh web: ')) continue
    const value = line.slice('dsh web: '.length).trim()
    if (value !== '') launchUrl = value
  }
  return launchUrl
}

/**
 * 日志里最新一条启动网址，两种形态都认（`LAUNCH_URL=` 与 `dsh web: `），
 * **按出现顺序取最后一条**。
 *
 * 不能「优先 deploy 标记」：一台机器先被 deploy 起过、后来手工重启，
 * 日志里两种形态各有一条，此时最新那条是手工启动的那条。日志是只追加的，
 * 所以位置就是时间。
 */
export function latestLaunchUrl(stdout: string): string | undefined {
  let launchUrl: string | undefined
  for (const line of stdout.split(/\r?\n/)) {
    const value = line.startsWith('LAUNCH_URL=')
      ? line.slice('LAUNCH_URL='.length).trim()
      : line.startsWith('dsh web: ')
        ? line.slice('dsh web: '.length).trim()
        : ''
    if (value !== '') launchUrl = value
  }
  return launchUrl
}
