/** Durable Web-machine catalog declaration for remote-agent sessions. */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import {
  RemoteHoldId, RemoteHostId, RemoteProjectId, RemoteSessionId, RemoteTranscriptId,
  type RemoteHostView, type RemoteProjectView, type RemoteSessionView, type RemoteTranscriptEntry,
} from '@threadharbor/protocol'

const hostId = z.string().transform(RemoteHostId)
const projectId = z.string().transform(RemoteProjectId)
const sessionId = z.string().transform(RemoteSessionId)

/** Durable catalog ordering state. */
export const remoteAgentCatalogState = z.object({
  hostIds: z.array(hostId),
  projectIds: z.array(projectId),
  sessionIds: z.array(sessionId),
  nextTranscriptSeq: z.record(z.string(), z.number().int().nonnegative()),
})

/** Durable catalog state type. */
export type RemoteAgentCatalogState = z.infer<typeof remoteAgentCatalogState>

const inventoryBackend = z.object({
  backend: z.enum(['grok', 'codex', 'claude', 'dsh']),
  installed: z.boolean(),
  authenticated: z.boolean(),
  running: z.boolean(),
  sessionCapable: z.boolean(),
  detail: z.string().optional(),
})
const inventory = z.object({
  protocolVersion: z.literal(1),
  hostdVersion: z.string(),
  hostId: z.string(),
  healthy: z.boolean(),
  backends: z.array(inventoryBackend),
})
const hostRecord = z.object({
  hostId,
  title: z.string(),
  endpoint: z.string(),
  ssh: z.object({
    target: z.string(),
    port: z.number().int().min(1).max(65535).optional(),
    user: z.string().optional(),
    identityFile: z.string().optional(),
    proxyJump: z.string().optional(),
    hostKeyFingerprint: z.string(),
  }).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  inventory: inventory.optional(),
  inventoryError: z.string().optional(),
}) as unknown as z.ZodType<RemoteHostView>
const projectRecord: z.ZodType<RemoteProjectView> = z.object({
  projectId,
  hostId,
  title: z.string(),
  cwd: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
const binding = z.object({
  holdId: z.string().transform(RemoteHoldId),
  nativeSessionId: z.string().optional(),
  generation: z.string(),
  state: z.enum(['active', 'superseded', 'lost']),
  lastSeq: z.number().int().nonnegative(),
})
const sessionRecord = z.object({
  sessionId,
  projectId,
  parentSessionId: sessionId.optional(),
  title: z.string(),
  backend: z.enum(['grok', 'codex', 'claude', 'dsh']),
  channelState: z.enum(['connecting', 'open', 'reconnecting', 'closed', 'lost']),
  turnState: z.enum(['idle', 'running', 'waiting-permission', 'failed']),
  createdAt: z.string(),
  updatedAt: z.string(),
  binding: binding.optional(),
}) as unknown as z.ZodType<RemoteSessionView>
const transcriptRecord: z.ZodType<RemoteTranscriptEntry> = z.object({
  transcriptId: z.string().transform(RemoteTranscriptId),
  sessionId,
  seq: z.number().int().nonnegative(),
  role: z.enum(['user', 'assistant', 'system', 'tool', 'permission']),
  kind: z.enum(['message', 'reasoning', 'tool-call', 'tool-result', 'status', 'permission']),
  text: z.string(),
  createdAt: z.string(),
  nativeFrame: z.json().optional(),
  requestId: z.string().optional(),
}) as z.ZodType<RemoteTranscriptEntry>

/** Durable domain: remote catalog and transcript projection, separate from dsh-workspace/session. */
export const remoteAgentDomainSpec = defineDomain({
  name: 'remote_agent',
  version: 1,
  global: {
    schema: remoteAgentCatalogState,
    initial: { hostIds: [], projectIds: [], sessionIds: [], nextTranscriptSeq: {} },
  },
  tables: {
    hosts: domainTable<ReturnType<typeof RemoteHostId>, RemoteHostView>(hostRecord),
    projects: domainTable<ReturnType<typeof RemoteProjectId>, RemoteProjectView>(projectRecord),
    sessions: domainTable<ReturnType<typeof RemoteSessionId>, RemoteSessionView>(sessionRecord),
    transcript: domainTable<ReturnType<typeof RemoteTranscriptId>, RemoteTranscriptEntry>(transcriptRecord),
  },
})
