/**
 * 状态帧读法：哪些帧说明 agent 在干什么、哪些只是背景。
 *
 * 这里钉的是「超时消息里那句话」的依据：普通 active/idle 不提示但更新快照；
 * 等待审批、内部错误、模式切换、压缩上下文要能被认出来。
 */

import { describe, expect, it } from 'vitest'
import type { AcpFrame } from '../src/acp-client.ts'
import { readSessionStatus } from '../src/session-status.ts'

function update(kind: string, extra: Record<string, unknown> = {}): AcpFrame {
  return { method: 'session/update', params: { update: { sessionUpdate: kind, ...extra } } }
}

function codexStatus(status: Record<string, unknown>): AcpFrame {
  return update('session_info_update', { _meta: { codex: { threadStatus: status } } })
}

describe('readSessionStatus', () => {
  it('codex 普通 active/idle：更新快照，但不值得提示', () => {
    expect(readSessionStatus(codexStatus({ type: 'active', activeFlags: [] }))).toEqual({
      key: 'codex:active',
      label: 'codex 正在处理',
      working: true,
      notable: false,
    })
    expect(readSessionStatus(codexStatus({ type: 'idle' }))).toEqual({
      key: 'codex:idle',
      label: 'codex 空闲',
      working: false,
      notable: false,
    })
  })

  it('active 带标志位：值得提示，键按标志排序稳定', () => {
    const reading = readSessionStatus(codexStatus({
      type: 'active',
      activeFlags: ['waitingOnUserInput', 'waitingOnApproval'],
    }))
    expect(reading).toMatchObject({ label: 'codex 正在处理（等待用户输入、等待审批）', notable: true, working: true })
    // 同一组标志换个顺序仍是同一个键：重复上报不该重复提示。
    expect(readSessionStatus(codexStatus({
      type: 'active',
      activeFlags: ['waitingOnApproval', 'waitingOnUserInput'],
    }))?.key).toBe(reading?.key)
  })

  it('内部错误与未知类型都值得提示', () => {
    expect(readSessionStatus(codexStatus({ type: 'systemError' }))).toMatchObject({
      label: 'codex 内部错误',
      working: false,
      notable: true,
    })
    expect(readSessionStatus(codexStatus({ type: 'paused' }))).toMatchObject({
      key: 'codex:paused',
      label: 'codex 状态：paused',
      notable: true,
    })
  })

  it('压缩上下文的状态各有一套读法', () => {
    expect(readSessionStatus(update('compaction_update', { status: 'in_progress' }))).toEqual({
      key: 'compaction:in_progress',
      label: 'codex 正在压缩上下文',
      working: true,
      notable: false,
    })
    expect(readSessionStatus(update('compaction_update', { status: 'failed', error: 'boom' }))).toMatchObject({
      label: '上下文压缩失败：boom',
    })
    expect(readSessionStatus(update('compaction_update', { status: 'completed' }))).toMatchObject({
      label: '上下文压缩完成',
    })
  })

  it('模式切换值得提示', () => {
    expect(readSessionStatus(update('current_mode_update', { currentModeId: 'agent' }))).toEqual({
      key: 'mode:agent',
      label: '模式切换：agent',
      working: true,
      notable: true,
    })
  })

  it('标题、内容帧与协议应答不是状态', () => {
    expect(readSessionStatus(update('session_info_update', { title: '修超时' }))).toBeUndefined()
    expect(readSessionStatus(update('agent_message_chunk', { content: { type: 'text', text: 'hi' } }))).toBeUndefined()
    expect(readSessionStatus(update('usage_update', { used: 1, size: 2 }))).toBeUndefined()
    expect(readSessionStatus({ id: 3, result: {} })).toBeUndefined()
  })

  it('厂商私有包装里的状态帧也认', () => {
    const wrapped: AcpFrame = {
      method: 'x/private_update',
      params: { update: { sessionUpdate: 'session_info_update', _meta: { codex: { threadStatus: { type: 'idle' } } } } },
    }
    expect(readSessionStatus(wrapped)?.key).toBe('codex:idle')
  })
})
