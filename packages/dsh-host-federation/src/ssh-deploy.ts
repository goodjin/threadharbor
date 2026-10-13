/**
 * Host-side SSH auto-deploy for remote DSH + ThreadHarbor.
 *
 * Registers authenticated `/api/threadharbor.host-ssh.*` routes on the machine
 * serving the Web UI. Private keys and passwords only transit browser → this
 * host over the existing session cookie; they are not logged or stored.
 */

import Schema from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DshSshManager } from './ssh/manager.ts'
import { OperationStore } from './ssh/operations.ts'
import { deploymentChannel, redactSshForLog } from './ssh/parse.ts'
import type { SshDeployOperationView, SshDeployRequest } from './ssh/types.ts'
import { isValidHostId } from './identity.ts'
import { optionalHost, parseAccessMode, validateBindHost } from './ssh/access.ts'
import { fetchRemoteSessions } from './host-remote-sessions.ts'
import { DEFAULT_REMOTE_DSH_PLUGINS, normalizePluginSpecs } from './ssh/deploy-plugins.ts'
import { parseRemoteAgentSelection } from './ssh/remote-agents.ts'

export const SSH_DEPLOY_ENTRY_ID = 'threadharbor-ssh-deploy'

/** Waits for the browser connection service so `/api` routes can register. */
export const inject = ['connection']

export const ROUTE_INSPECT = '/api/threadharbor.host-ssh.inspect'
export const ROUTE_DEPLOY = '/api/threadharbor.host-ssh.deploy'
export const ROUTE_OPERATION = '/api/threadharbor.host-ssh.operation'
export const ROUTE_REMOTE_SESSIONS = '/api/threadharbor.host-remote.sessions'

export type Config = {
  knownHostsPath?: string
  connectTimeoutMs?: number
  installTimeoutMs?: number
  deploymentChannel?: string
  releaseDirectory?: string
  defaultRemoteWebPort?: number
  remotePlugins?: readonly string[]
  installPluginsFromGithub?: boolean
}

export const Config: Schema = Schema.object({
  knownHostsPath: Schema.string().description('SSH known_hosts file on the Web host').default(
    join(homedir(), '.local/state/threadharbor/ssh/known_hosts'),
  ),
  connectTimeoutMs: Schema.natural().min(1_000).default(15_000),
  installTimeoutMs: Schema.natural().min(10_000).default(600_000),
  deploymentChannel: Schema.string().default('managed'),
  releaseDirectory: Schema.string().description('ThreadHarbor release directory to upload; defaults to stable-current or workspace'),
  defaultRemoteWebPort: Schema.natural().min(1).max(65_535).default(3081),
  remotePlugins: Schema.array(Schema.string()).description('GitHub/npm specs for dsh plugin add on remote hosts').default([...DEFAULT_REMOTE_DSH_PLUGINS]),
  installPluginsFromGithub: Schema.boolean().description('Install plugins from GitHub instead of uploading a local release tarball').default(true),
})

type ConnectionService = {
  fetch: {
    register(route: {
      readonly path: string
      readonly methods: readonly ('GET' | 'HEAD' | 'POST')[]
      readonly requestBody: 'buffered'
      readonly fetch: (request: Request) => Promise<Response>
    }): () => void
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

function connectionOf(ctx: unknown): ConnectionService {
  if (!isRecord(ctx)) throw new Error('host context missing')
  const connection = ctx['connection']
  if (!isRecord(connection) || !isRecord(connection['fetch'])) {
    throw new Error('connection.fetch is not available — threadharbor-ssh-deploy requires dsh-client-connection on the host')
  }
  return connection as ConnectionService
}

function loggerOf(ctx: unknown): { info(message: string, extra?: unknown): void; warn(message: string, extra?: unknown): void } {
  if (!isRecord(ctx) || typeof ctx['logger'] !== 'function') {
    return { info: () => undefined, warn: () => undefined }
  }
  const named = (ctx['logger'] as (name: string) => Record<string, unknown>)('threadharbor-ssh-deploy')
  return {
    info: (message, extra) => {
      if (typeof named['info'] === 'function') named['info'](message, extra)
    },
    warn: (message, extra) => {
      if (typeof named['warn'] === 'function') named['warn'](message, extra)
    },
  }
}

export function apply(ctx: unknown, config: Config = {}): void {
  const log = loggerOf(ctx)
  const channel = deploymentChannel(config.deploymentChannel ?? 'managed')
  const remotePlugins = normalizePluginSpecs(config.remotePlugins)
  const manager = new DshSshManager({
    knownHostsPath: config.knownHostsPath ?? join(homedir(), '.local/state/threadharbor/ssh/known_hosts'),
    connectTimeoutMs: config.connectTimeoutMs ?? 15_000,
    installTimeoutMs: config.installTimeoutMs ?? 600_000,
    deploymentChannel: channel,
    ...(config.releaseDirectory === undefined ? {} : { releaseDirectory: config.releaseDirectory }),
    defaultRemoteWebPort: config.defaultRemoteWebPort ?? 3081,
    remotePlugins,
    installPluginsFromGithub: config.installPluginsFromGithub ?? true,
  })
  const operations = new OperationStore()
  const connection = connectionOf(ctx)

  const disposers: Array<() => void> = []

  const register = (
    path: string,
    handler: (body: unknown) => Promise<unknown>,
  ): void => {
    disposers.push(connection.fetch.register({
      path,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return Response.json({ ok: false, error: '请求体必须是 JSON' }, { status: 400 })
        }
        try {
          const value = await handler(body)
          return Response.json({ ok: true, value })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          log.warn(`route ${path} failed`, { error: message })
          return Response.json({ ok: false, error: message }, { status: 400 })
        }
      },
    }))
  }

  register(ROUTE_INSPECT, async body => {
    const ssh = manager.parseInspectionConfig((body as Record<string, unknown>)['ssh'])
    const keys = await manager.inspectAll(ssh)
    log.info('ssh inspect', redactSshForLog(ssh))
    return { keys }
  })

  register(ROUTE_REMOTE_SESSIONS, async body => {
    const record = body as Record<string, unknown>
    const launchUrl = typeof record['launchUrl'] === 'string' ? record['launchUrl'] : ''
    if (launchUrl.trim() === '') throw new Error('launchUrl 必填')
    return await fetchRemoteSessions(launchUrl)
  })

  register(ROUTE_DEPLOY, async body => {
    const record = body as Record<string, unknown>
    const request = parseDeployRequest(record)
    const operation = operations.create()
    void runDeploy(manager, operations, operation.operationId, request, log)
    return { operationId: operation.operationId }
  })

  disposers.push(connection.fetch.register({
    path: ROUTE_OPERATION,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const id = new URL(request.url).searchParams.get('operationId')
      if (id === null || id === '') {
        return Response.json({ ok: false, error: 'operationId is required' }, { status: 400 })
      }
      const operation = operations.get(id)
      if (operation === undefined) {
        return Response.json({ ok: false, error: 'unknown operation' }, { status: 404 })
      }
      return Response.json({ ok: true, value: operation })
    },
  }))

  if (isRecord(ctx) && typeof ctx['effect'] === 'function') {
    (ctx['effect'] as (callback: () => () => void, label?: string) => void)(() => {
      return () => {
        for (const dispose of disposers) dispose()
        manager.close()
      }
    }, 'threadharbor-ssh-deploy')
  }

  process.stderr.write('[threadharbor] ssh-deploy routes registered\n')
}

function parseDeployRequest(record: Record<string, unknown>): SshDeployRequest {
  const hostId = typeof record['hostId'] === 'string' ? record['hostId'].trim() : ''
  if (!isValidHostId(hostId)) throw new Error('hostId 无效')
  const hostTitle = typeof record['hostTitle'] === 'string' ? record['hostTitle'].trim() : hostId
  const remoteWebPort = typeof record['remoteWebPort'] === 'number' ? record['remoteWebPort'] : undefined
  const upgrade = record['upgrade'] === true
  const accessMode = parseAccessMode(record['accessMode'])
  const bindHost = optionalHost(record['bindHost'], 'bindHost')
  const trustedHost = optionalHost(record['trustedHost'], 'trustedHost')
  if (accessMode === 'custom') {
    if (bindHost === undefined) throw new Error('custom 访问模式必须提供 bindHost')
    validateBindHost(bindHost)
  }
  if (bindHost !== undefined) validateBindHost(bindHost)
  const ssh = record['ssh']
  const remoteAgents = parseRemoteAgentSelection(record['remoteAgents'])
  return {
    hostId,
    hostTitle: hostTitle === '' ? hostId : hostTitle,
    ...(remoteWebPort === undefined ? {} : { remoteWebPort }),
    upgrade,
    accessMode,
    ...(bindHost === undefined ? {} : { bindHost }),
    ...(trustedHost === undefined ? {} : { trustedHost }),
    ...(remoteAgents === undefined ? {} : { remoteAgents }),
    ssh: ssh as SshDeployRequest['ssh'],
  }
}

async function runDeploy(
  manager: DshSshManager,
  operations: OperationStore,
  operationId: string,
  request: SshDeployRequest,
  log: ReturnType<typeof loggerOf>,
): Promise<void> {
  operations.progress(operationId, { phase: 'connecting', detail: '开始部署……' })
  try {
    const result = await manager.deploy(request, progress => {
      operations.progress(operationId, progress)
    })
    operations.succeed(operationId, result)
    log.info('ssh deploy succeeded', { hostId: request.hostId, endpoint: result.endpoint, version: result.releaseVersion })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    operations.fail(operationId, message)
    log.warn('ssh deploy failed', { hostId: request.hostId, error: message })
  }
}

export type { SshDeployOperationView }
