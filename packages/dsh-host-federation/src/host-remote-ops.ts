/**
 * Manage a session that lives on another host, from the machine serving this page.
 *
 * The session keeps running on that host. This module only speaks that host's
 * own DSH RPCs (the same ones the mobile page uses) through its launch URL.
 */

import { callRemoteDsh } from './host-remote-sessions.ts'

export type TranscriptTurn = {
  readonly role: 'user' | 'assistant' | 'note'
  readonly text: string
}

export type RemoteTranscript = {
  readonly turns: readonly TranscriptTurn[]
  readonly hasMore: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

function textOfBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  const parts: string[] = []
  for (const block of blocks) {
    if (isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string' && block['text'] !== '') {
      parts.push(block['text'])
    }
  }
  return parts.join('\n')
}

function eventOf(record: unknown): Record<string, unknown> | undefined {
  if (!isRecord(record)) return undefined
  const nested = record['event']
  if (isRecord(nested) && typeof nested['type'] === 'string') return nested
  if (typeof record['type'] === 'string') return record
  return undefined
}

/**
 * Project a session/page payload into the lines a person actually reads.
 * Unknown event types are skipped — guessing would show protocol noise as chat.
 */
export function turnsFromRecords(records: readonly unknown[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = []
  const push = (role: TranscriptTurn['role'], text: string): void => {
    if (text.trim() === '') return
    turns.push({ role, text })
  }
  for (const record of records) {
    const event = eventOf(record)
    if (event === undefined) continue
    const type = event['type']
    const data = isRecord(event['data']) ? event['data'] : undefined
    if (type === 'user/message') {
      push('user', textOfBlocks(data?.['content']))
      continue
    }
    if (type === 'assistant/message') {
      const message = isRecord(data?.['message']) ? data['message'] : undefined
      push('assistant', textOfBlocks(message?.['content']))
      continue
    }
    if (type === 'agent/inbox/spliced' && Array.isArray(data?.['inserted'])) {
      for (const item of data['inserted']) {
        if (!isRecord(item)) continue
        const source = isRecord(item['source']) ? item['source'] : undefined
        if (source?.['kind'] !== 'user') continue
        push('user', textOfBlocks(item['content']))
      }
      continue
    }
    if (typeof type === 'string' && type.startsWith('tool/')) {
      const title = typeof data?.['title'] === 'string' && data['title'] !== ''
        ? data['title']
        : typeof data?.['name'] === 'string'
          ? data['name']
          : type
      push('note', title)
    }
  }
  return turns
}

async function rpc(launchUrl: string, endpoint: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await callRemoteDsh(launchUrl, endpoint, args)
  if (!result.ok) throw new Error(result.error)
  return result.value
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} 必填`)
  return value
}

/** Latest page of a remote session. A cursor past the log end is how DSH names the tip. */
export async function readRemoteTranscript(launchUrl: string, sessionId: string, maxMessages = 40): Promise<RemoteTranscript> {
  const id = requireText(sessionId, 'sessionId')
  const probe = await callRemoteDsh(launchUrl, 'session/page', {
    request: {
      address: { kind: 'session', sessionId: id },
      throughSeq: Number.MAX_SAFE_INTEGER,
      maxMessages: 1,
    },
  })
  if (probe.ok) throw new Error('游标探测意外成功（协议形状变化）')
  const match = /past cursor (-?\d+)/.exec(probe.error)
  const cursor = match === null ? Number.NaN : Number(match[1])
  if (!Number.isSafeInteger(cursor)) throw new Error(probe.error)
  if (cursor < 0) return { turns: [], hasMore: false }
  const page = await rpc(launchUrl, 'session/page', {
    request: {
      address: { kind: 'session', sessionId: id },
      throughSeq: cursor,
      maxMessages,
    },
  })
  const records = isRecord(page) && Array.isArray(page['records']) ? page['records'] : []
  const hasMore = isRecord(page) && page['hasMore'] === true
  return { turns: turnsFromRecords(records), hasMore }
}

export async function promptRemoteSession(
  launchUrl: string,
  sessionId: string,
  text: string,
  timeZone?: string,
): Promise<{ readonly accepted: boolean }> {
  const id = requireText(sessionId, 'sessionId')
  const body = requireText(text, '消息')
  const value = await rpc(launchUrl, 'session/prompt', {
    request: {
      requestId: crypto.randomUUID(),
      sessionId: id,
      mode: 'queue',
      content: [{ type: 'text', text: body }],
      ...(timeZone === undefined || timeZone === '' ? {} : { clientTimeZone: timeZone }),
    },
  })
  return { accepted: !isRecord(value) || value['accepted'] !== false }
}

export async function cancelRemoteSession(launchUrl: string, sessionId: string): Promise<{ readonly accepted: boolean }> {
  const value = await rpc(launchUrl, 'session/cancel', { request: { sessionId: requireText(sessionId, 'sessionId') } })
  return { accepted: !isRecord(value) || value['accepted'] !== false }
}

export async function createRemoteSession(launchUrl: string, workspaceId?: string): Promise<{ readonly sessionId: string }> {
  const request = workspaceId === undefined || workspaceId === '' || workspaceId === 'ungrouped'
    ? {}
    : { workspaceId }
  const value = await rpc(launchUrl, 'session/create', { request })
  const sessionId = isRecord(value) && typeof value['sessionId'] === 'string' ? value['sessionId'] : undefined
  if (sessionId === undefined || sessionId === '') throw new Error('远端没有返回新会话编号')
  return { sessionId }
}

export async function renameRemoteSession(launchUrl: string, sessionId: string, title: string): Promise<void> {
  await rpc(launchUrl, 'session/rename', {
    request: { sessionId: requireText(sessionId, 'sessionId'), title: requireText(title, '名称') },
  })
}

export async function archiveRemoteSession(launchUrl: string, sessionId: string): Promise<void> {
  await rpc(launchUrl, 'workspace/archiveSession', { request: { sessionId: requireText(sessionId, 'sessionId') } })
}

export async function pinRemoteSession(launchUrl: string, sessionId: string, pinned: boolean): Promise<void> {
  const endpoint = pinned ? 'workspace/pinSession' : 'workspace/unpinSession'
  await rpc(launchUrl, endpoint, { request: { sessionId: requireText(sessionId, 'sessionId') } })
}

export async function forkRemoteSession(launchUrl: string, sessionId: string): Promise<{ readonly sessionId: string }> {
  const value = await rpc(launchUrl, 'session/fork', { request: { sessionId: requireText(sessionId, 'sessionId') } })
  const child = isRecord(value) && typeof value['sessionId'] === 'string' ? value['sessionId'] : undefined
  if (child === undefined || child === '') throw new Error('远端没有返回分叉后的会话编号')
  return { sessionId: child }
}

export async function renameRemoteWorkspace(launchUrl: string, workspaceId: string, title: string): Promise<void> {
  await rpc(launchUrl, 'workspace/rename', {
    request: { workspaceId: requireText(workspaceId, 'workspaceId'), title: requireText(title, '名称') },
  })
}

export async function deleteRemoteWorkspace(launchUrl: string, workspaceId: string): Promise<void> {
  await rpc(launchUrl, 'workspace/delete', { request: { workspaceId: requireText(workspaceId, 'workspaceId') } })
}

export type RemoteOpName =
  | 'transcript'
  | 'prompt'
  | 'cancel'
  | 'create'
  | 'rename-session'
  | 'archive-session'
  | 'pin-session'
  | 'unpin-session'
  | 'fork-session'
  | 'rename-workspace'
  | 'delete-workspace'

export type RemoteOpBody = {
  readonly op?: unknown
  readonly launchUrl?: unknown
  readonly sessionId?: unknown
  readonly workspaceId?: unknown
  readonly title?: unknown
  readonly text?: unknown
  readonly timeZone?: unknown
}

const OPS = new Set<RemoteOpName>([
  'transcript', 'prompt', 'cancel', 'create', 'rename-session', 'archive-session',
  'pin-session', 'unpin-session', 'fork-session', 'rename-workspace', 'delete-workspace',
])

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** The only remote operations the browser route is willing to forward. */
export async function performRemoteOp(body: RemoteOpBody): Promise<unknown> {
  const op = body.op
  if (typeof op !== 'string' || !OPS.has(op as RemoteOpName)) throw new Error('不认识的远端操作')
  const launchUrl = str(body.launchUrl)
  if (launchUrl === undefined || launchUrl.trim() === '') throw new Error('launchUrl 必填')
  const sessionId = str(body.sessionId)
  const workspaceId = str(body.workspaceId)
  const title = str(body.title)
  const text = str(body.text)
  const timeZone = str(body.timeZone)
  switch (op as RemoteOpName) {
    case 'transcript':
      return await readRemoteTranscript(launchUrl, sessionId ?? '')
    case 'prompt':
      return await promptRemoteSession(launchUrl, sessionId ?? '', text ?? '', timeZone)
    case 'cancel':
      return await cancelRemoteSession(launchUrl, sessionId ?? '')
    case 'create':
      return await createRemoteSession(launchUrl, workspaceId)
    case 'rename-session':
      await renameRemoteSession(launchUrl, sessionId ?? '', title ?? '')
      return { ok: true }
    case 'archive-session':
      await archiveRemoteSession(launchUrl, sessionId ?? '')
      return { ok: true }
    case 'pin-session':
      await pinRemoteSession(launchUrl, sessionId ?? '', true)
      return { ok: true }
    case 'unpin-session':
      await pinRemoteSession(launchUrl, sessionId ?? '', false)
      return { ok: true }
    case 'fork-session':
      return await forkRemoteSession(launchUrl, sessionId ?? '')
    case 'rename-workspace':
      await renameRemoteWorkspace(launchUrl, workspaceId ?? '', title ?? '')
      return { ok: true }
    case 'delete-workspace':
      await deleteRemoteWorkspace(launchUrl, workspaceId ?? '')
      return { ok: true }
  }
}
