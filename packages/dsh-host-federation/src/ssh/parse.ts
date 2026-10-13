import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { SshConnectionConfig, SshConnectionInput } from './types.ts'

export function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} must be a non-empty string`)
  return value.trim()
}

function optionalText(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined
  return text(value, name)
}

function sshPort(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 65_535) {
    throw new Error('ssh.port must be an integer from 1 to 65535')
  }
  return value as number
}

export function parseSshInput(value: unknown, requireFingerprint: boolean): SshConnectionConfig {
  if (value === null || Array.isArray(value) || typeof value !== 'object') throw new Error('ssh must be an object')
  const record = value as Record<string, unknown>
  const identityFile = optionalText(record['identityFile'], 'ssh.identityFile')
  if (identityFile !== undefined && (!isAbsolute(identityFile) || !existsSync(identityFile))) {
    throw new Error('ssh.identityFile must be an existing absolute path on the Web service host')
  }
  const identityPem = optionalText(record['identityPem'], 'ssh.identityPem')
  const password = optionalText(record['password'], 'ssh.password')
  if (identityFile !== undefined && identityPem !== undefined) {
    throw new Error('ssh.identityFile and ssh.identityPem cannot both be set')
  }
  const fingerprint = optionalText(record['hostKeyFingerprint'], 'ssh.hostKeyFingerprint')
  if (requireFingerprint && fingerprint === undefined) throw new Error('ssh.hostKeyFingerprint is required')
  const port = sshPort(record['port'])
  const user = optionalText(record['user'], 'ssh.user')
  const proxyJump = optionalText(record['proxyJump'], 'ssh.proxyJump')
  if (identityFile === undefined && identityPem === undefined && password === undefined) {
    throw new Error('ssh authentication requires identityFile, identityPem, or password')
  }
  return {
    target: text(record['target'], 'ssh.target'),
    ...(port === undefined ? {} : { port }),
    ...(user === undefined ? {} : { user }),
    ...(identityFile === undefined ? {} : { identityFile }),
    ...(identityPem === undefined ? {} : { identityPem }),
    ...(password === undefined ? {} : { password }),
    ...(proxyJump === undefined ? {} : { proxyJump }),
    hostKeyFingerprint: fingerprint ?? 'unapproved',
  }
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export function destination(config: SshConnectionConfig): string {
  return config.user === undefined ? config.target : `${config.user}@${config.target}`
}

export function deploymentChannel(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(value)) {
    throw new Error('deploymentChannel must use 1-32 lowercase letters, digits, or hyphens')
  }
  return value
}

export function redactSshForLog(config: SshConnectionConfig): Record<string, string | number | undefined> {
  return {
    target: config.target,
    port: config.port,
    user: config.user,
    proxyJump: config.proxyJump,
    hostKeyFingerprint: config.hostKeyFingerprint,
    auth: config.identityFile !== undefined ? 'identityFile' : config.identityPem !== undefined ? 'identityPem' : 'password',
  }
}
