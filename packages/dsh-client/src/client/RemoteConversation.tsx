/** Active remote transcript, permissions, prompt, and cancel controls. */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Button, MarkdownText, MessageText, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConvOwnerProps } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { JsonValue, RemoteTranscriptEntry } from '@threadharbor/protocol'
import type { RemoteAgentStore } from './store.ts'
import css from './RemoteSurface.module.css'

/** Props injected by the conversation slot registration. */
export interface RemoteConversationInjected {
  readonly store: RemoteAgentStore
}

/** Full conversation component props. */
export type RemoteConversationProps = PropsRuntime<'conversation'> & ConvOwnerProps & RemoteConversationInjected

function permissionOptions(entry: RemoteTranscriptEntry): readonly { id: string; label: string; outcome: JsonValue }[] {
  const frame = entry.nativeFrame
  if (frame === undefined || frame === null || typeof frame !== 'object' || Array.isArray(frame)) return []
  const params = frame['params']
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return []
  const options = params['options']
  if (!Array.isArray(options)) return []
  return options.flatMap((candidate) => {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return []
    const id = candidate['optionId']
    if (typeof id !== 'string') return []
    const label = typeof candidate['name'] === 'string'
      ? candidate['name']
      : typeof candidate['kind'] === 'string' ? candidate['kind'] : id
    return [{ id, label, outcome: { outcome: 'selected', optionId: id } }]
  })
}

function TranscriptRow({ entry, onPermission }: {
  entry: RemoteTranscriptEntry
  onPermission: (requestId: string, outcome: JsonValue) => void
}) {
  if (entry.role === 'permission') {
    const options = permissionOptions(entry)
    return (
      <article className={css.permissionCard}>
        <strong>权限请求</strong>
        <p>{entry.text}</p>
        <div className={css.permissionActions}>
          {options.map(option => (
            <Button key={option.id} size="sm" variant="outline" onClick={() => {
              if (entry.requestId !== undefined) onPermission(entry.requestId, option.outcome)
            }}>{option.label}</Button>
          ))}
          <Button size="sm" variant="ghost" onClick={() => {
            if (entry.requestId !== undefined) onPermission(entry.requestId, { outcome: 'cancelled' })
          }}>拒绝</Button>
        </div>
      </article>
    )
  }
  if (entry.role === 'user') {
    return <article className={css.userMessage}><MessageText text={entry.text} /></article>
  }
  if (entry.role === 'assistant') {
    return (
      <article className={entry.kind === 'reasoning' ? css.reasoningMessage : css.assistantMessage}>
        {entry.kind === 'reasoning' && <span className={css.rowLabel}>思考</span>}
        <MarkdownText text={entry.text} streaming />
      </article>
    )
  }
  if (entry.role === 'tool') {
    return <article className={css.toolMessage}><span className={css.rowLabel}>{entry.kind === 'tool-call' ? '工具调用' : '工具结果'}</span>{entry.text}</article>
  }
  return <div className={css.statusRow}>{entry.text}</div>
}

/** Render the selected remote session. */
export function RemoteConversation({ store }: RemoteConversationProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const session = snapshot.state.sessions.find(candidate => candidate.sessionId === snapshot.currentSessionId)
  const transcript = useMemo(
    () => snapshot.state.transcript.filter(entry => entry.sessionId === session?.sessionId),
    [snapshot.state.transcript, session?.sessionId],
  )
  useEffect(() => {
    const element = scrollRef.current
    if (element !== null) element.scrollTop = element.scrollHeight
  }, [transcript.length, session?.sessionId])

  if (session === undefined) {
    return (
      <main className={css.hero}>
        <div className={css.heroMark}>远</div>
        <h1>连接一个远程 Agent 会话</h1>
        <p>在左侧添加 hostd、登记项目，并从该主机的可用库存中选择 Grok、Codex 或 dsh。</p>
      </main>
    )
  }

  const send = (): void => {
    const text = draft.trim()
    if (text === '') return
    setDraft('')
    void store.prompt(session.sessionId, text).catch(() => { setDraft(text) })
  }
  return (
    <main className={css.conversation}>
      <header className={css.conversationHeader}>
        <div>
          <h1>{session.title}</h1>
          <p>{session.backend} · {session.binding?.nativeSessionId ?? '正在建立远程会话'}</p>
        </div>
        <div className={css.sessionState}>
          <StateDot state={session.turnState === 'running' ? 'ongoing' : session.channelState === 'lost' ? 'error' : 'done'} />
          <span>{session.channelState} / {session.turnState}</span>
        </div>
      </header>
      <div ref={scrollRef} className={css.transcript}>
        {transcript.map(entry => (
          <TranscriptRow
            key={entry.transcriptId}
            entry={entry}
            onPermission={(requestId, outcome) => { void store.permission(session.sessionId, requestId, outcome) }}
          />
        ))}
        {transcript.length === 0 && <p className={css.emptyTranscript}>远程会话已连接。发送一条消息开始。</p>}
      </div>
      <div className={css.composer}>
        {snapshot.error !== undefined && <div className={css.composerError}>{snapshot.error}</div>}
        <textarea
          aria-label="发送给远程 Agent"
          value={draft}
          placeholder={`发送给 ${session.backend}`}
          disabled={session.channelState !== 'open' || session.parentSessionId !== undefined}
          onChange={(event) => { setDraft(event.target.value) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              send()
            }
          }}
        />
        <div className={css.composerActions}>
          <span>{session.parentSessionId === undefined ? '后端在创建后不可更改' : '子会话由远端产品管理'}</span>
          {session.turnState === 'running' && (
            <Button size="sm" variant="outline" onClick={() => { void store.cancel(session.sessionId) }}>停止</Button>
          )}
          <Button size="sm" variant="primary" disabled={session.parentSessionId !== undefined || draft.trim() === '' || snapshot.pending} onClick={send}>发送</Button>
        </div>
      </div>
    </main>
  )
}
