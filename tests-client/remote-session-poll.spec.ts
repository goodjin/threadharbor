import { describe, expect, it } from 'vitest'
import { settleHostFetch } from '../src/remote-session-poll.ts'

describe('settleHostFetch', () => {
  it('成功时换成新清单，并丢掉上次的失败说明', () => {
    const settled = settleHostFetch(
      [{ projectId: 'w', sessionId: 'old', title: '旧', projectTitle: '项' }],
      { sessions: [] },
    )
    expect(settled.sessions).toEqual([])
    expect(settled.note).toBeUndefined()
  })

  it('失败时留下上次的会话，并带上原因', () => {
    const previous = [{ projectId: 'w', sessionId: 'old', title: '旧', projectTitle: '项' }]
    const settled = settleHostFetch(previous, { failed: 'HTTP 500' })
    expect(settled.sessions).toEqual(previous)
    expect(settled.note).toBe('HTTP 500')
  })
})
