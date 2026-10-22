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
import { fetchRemoteSessions } from './host-remote-sessions.ts'
import { performRemoteOp } from './host-remote-ops.ts'
import { parseAccessMode, validateBindHost } from './ssh/access.ts'
import { DEFAULT_REMOTE_DSH_PLUGINS, normalizePluginSpecs } from './ssh/deploy-plugins.ts'
import { parseRemoteAgentSelection } from './ssh/remote-agents.ts'
import { listLocalIdentityFiles, listSshConfigHosts, pickLocalIdentityFile } from './ssh/local-assets.ts'

export { SSH_DEPLOY_ENTRY_ID } from './ssh-deploy-id.ts'

/** Waits for the browser connection service so `/api` routes can register. */
export const inject = ['connection']

export const ROUTE_INSPECT = '/api/threadharbor.host-ssh.inspect'
export const ROUTE_DEPLOY = '/api/threadharbor.host-ssh.deploy'
export const ROUTE_OPERATION = '/api/threadharbor.host-ssh.operation'
export const ROUTE_PEER = '/api/threadharbor.host-ssh.peer'
export const ROUTE_REMOTE_SESSIONS = '/api/threadharbor.host-remote.sessions'
export const ROUTE_REMOTE_OP = '/api/threadharbor.host-remote.op'
export const ROUTE_CONNECT = '/api/threadharbor.host-ssh.connect'
export const ROUTE_CHECK = '/api/threadharbor.host-ssh.check'
export const ROUTE_SERVE = '/api/threadharbor.host-ssh.serve'
export const ROUTE_SERVICE = '/api/threadharbor.host-ssh.service'
export const ROUTE_START = '/api/threadharbor.host-ssh.start'
export const ROUTE_LOCAL_ASSETS = '/api/threadharbor.host-ssh.local.assets'
export const ROUTE_LOCAL_PICK_IDENTITY = '/api/threadharbor.host-ssh.local.pick-identity'

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

  const registerGet = (
    path: string,
    handler: () => Promise<unknown>,
  ): void => {
    disposers.push(connection.fetch.register({
      path,
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: async (request) => {
        if (request.method === 'HEAD') return new Response(null, { status: 200 })
        try {
          const value = await handler()
          return Response.json({ ok: true, value })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          log.warn(`route ${path} failed`, { error: message })
          return Response.json({ ok: false, error: message }, { status: 400 })
        }
      },
    }))
  }

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

  register(ROUTE_PEER, async body => {
    const ssh = manager.parseApprovedConfig((body as Record<string, unknown>)['ssh'])
    const peer = await manager.readPeer(ssh)
    log.info('ssh peer status', { target: ssh.target, pluginsInstalled: peer.pluginsInstalled, listen: peer.listen })
    return peer
  })

  register(ROUTE_REMOTE_SESSIONS, async body => {
    const record = body as Record<string, unknown>
    const launchUrl = typeof record['launchUrl'] === 'string' ? record['launchUrl'] : ''
    if (launchUrl.trim() === '') throw new Error('launchUrl 必填')
    return await fetchRemoteSessions(launchUrl)
  })

  register(ROUTE_REMOTE_OP, async body => {
    if (!isRecord(body)) throw new Error('请求体必须是对象')
    return await performRemoteOp(body)
  })

  register(ROUTE_CONNECT, async body => {
    const record = body as Record<string, unknown>
    const ssh = manager.parseApprovedConfig(record['ssh'])
    const remoteWebPort = typeof record['remoteWebPort'] === 'number' ? record['remoteWebPort'] : undefined
    const result = await manager.connect(ssh, remoteWebPort)
    log.info('ssh connect', { target: ssh.target, mode: result.mode, endpoint: result.endpoint, installed: result.peer.pluginsInstalled })
    return result
  })

  register(ROUTE_CHECK, async body => {
    const record = body as Record<string, unknown>
    const ssh = manager.parseApprovedConfig(record['ssh'])
    const report = await manager.checkPeer(ssh, portOf(record['remoteWebPort']))
    log.info('ssh peer check', { target: ssh.target, ready: report.ready, steps: report.steps.map(step => `${step.id}:${step.state}`).join(',') })
    return report
  })

  register(ROUTE_SERVE, async body => {
    const record = body as Record<string, unknown>
    const ssh = manager.parseApprovedConfig(record['ssh'])
    const port = portOf(record['remoteWebPort'])
    const outcome = await manager.configureServe(ssh, port)
    log.info('tailscale serve', { target: ssh.target, port, ok: outcome.ok })
    const report = await manager.checkPeer(ssh, port)
    return outcome.ok
      ? { report }
      : { report, failure: { error: outcome.error, ...(outcome.manualCommands === undefined ? {} : { manualCommands: outcome.manualCommands }) } }
  })

  register(ROUTE_SERVICE, async body => {
    const record = body as Record<string, unknown>
    const ssh = manager.parseApprovedConfig(record['ssh'])
    const verb = record['action']
    if (verb !== 'start' && verb !== 'restart') throw new Error('action 必须是 start 或 restart')
    const port = portOf(record['remoteWebPort'])
    const done = await manager.controlService(ssh, verb, port)
    log.info('dsh service', { target: ssh.target, verb, scope: done.scope })
    return { report: await manager.checkPeer(ssh, port) }
  })

  register(ROUTE_START, async body => {
    const record = body as Record<string, unknown>
    const ssh = manager.parseApprovedConfig(record['ssh'])
    const port = typeof record['port'] === 'number' ? record['port'] : undefined
    if (port === undefined) throw new Error('port 必填')
    const started = await manager.startPeer(ssh, port)
    if (!started.ok) throw new Error(started.reason)
    log.info('ssh peer started', { target: ssh.target, port: started.port })
    return { port: started.port }
  })

  registerGet(ROUTE_LOCAL_ASSETS, async () => ({
    configHosts: listSshConfigHosts(),
    identityFiles: listLocalIdentityFiles(),
  }))

  register(ROUTE_LOCAL_PICK_IDENTITY, async () => {
    const path = pickLocalIdentityFile()
    if (path === undefined) return { cancelled: true }
    return { cancelled: false, path }
  })

  register(ROUTE_INSPECT, async body => {
    const ssh = manager.parseInspectionConfig((body as Record<string, unknown>)['ssh'])
    const keys = await manager.inspectAll(ssh)
    log.info('ssh inspect', redactSshForLog(ssh))
    return { keys }
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
    // HEAD serves the availability probe (probeSshDeployApi): a method mismatch
    // would 404 there and the whole SSH UI would never show up.
    methods: ['GET', 'HEAD'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method === 'HEAD') return new Response(null, { status: 200 })
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

function portOf(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65_535) throw new Error('remoteWebPort 无效')
  return value
}

function parseDeployRequest(record: Record<string, unknown>): SshDeployRequest {
  const hostId = typeof record['hostId'] === 'string' ? record['hostId'].trim() : ''
  if (!isValidHostId(hostId)) throw new Error('hostId 无效')
  const hostTitle = typeof record['hostTitle'] === 'string' ? record['hostTitle'].trim() : hostId
  const remoteWebPort = typeof record['remoteWebPort'] === 'number' ? record['remoteWebPort'] : undefined
  const upgrade = record['upgrade'] === true
  const accessMode = parseAccessMode(record['accessMode'])
  const bindHost = typeof record['bindHost'] === 'string' ? record['bindHost'].trim() : ''
  const ssh = record['ssh']
  const remoteAgents = parseRemoteAgentSelection(record['remoteAgents'])
  return {
    hostId,
    hostTitle: hostTitle === '' ? hostId : hostTitle,
    ...(remoteWebPort === undefined ? {} : { remoteWebPort }),
    upgrade,
    accessMode,
    ...(bindHost === '' ? {} : { bindHost: validateBindHost(bindHost) }),
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
