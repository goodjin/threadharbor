/**
 * 手机页视图纯函数（mobile/views.js）的用例。
 *
 * views.js 无 DOM 依赖、产出 HTML 串，本文件跑在 node 环境（不需要 jsdom）。
 * 覆盖面与 R2 修正在此钉死：
 * - 配对引导只有两支——'unpaired'（指向桌面二维码入口、提「重新扫码」）与
 *   'untrusted'（指向信任主机配置）；无效令牌由官方交换以 401 页接管，手机侧
 *   探针只会看到 401（→ unpaired）或 403（→ untrusted），没有第三支。
 * - 主机清单渲染 peers 的在线/离线与 dsh 标记，tailscale 失败有专属提示。
 * - 会话列表与对话视图在 hasMore 时渲染「加载更早」。
 * - stateFold 对 append / prepend / assistant-stream 三类变更归并幂等：
 *   同一帧重放两遍，状态深度相等；durable 记录按 seq 去重升序。
 */

import { describe, expect, it } from 'vitest'
import {
  guidanceReasonForKind,
  pairingGuideView,
  renderApprovalBanners,
  renderConversation,
  renderErrorScreen,
  renderHostList,
  renderLoading,
  renderSessionList,
  stateFold,
} from '../mobile/views.js'

/** 造一条 durable journal 记录（session/page 与 follow 流的 event 帧形）。 */
function eventRecord(type: string, seq: number, data: unknown, time = 1791916709370) {
  return { type: 'event', event: { type, seq, time, data } }
}

describe('启动态（loading / error 屏）', () => {
  it('renderLoading 给连接中文案', () => {
    expect(renderLoading()).toContain('正在连接')
  })

  it('renderErrorScreen 给错误原文、Tailscale 检查提示与重试按钮', () => {
    const html = renderErrorScreen('fetch failed')
    expect(html).toContain('fetch failed')
    expect(html).toContain('Tailscale')
    expect(html).toContain('data-action="retry-boot"')
  })
})

describe('pairingGuideView（配对引导，R2：只有两支）', () => {
  it('unpaired 指向桌面二维码入口并明确要重新扫码', () => {
    const html = pairingGuideView('unpaired')
    expect(html).toContain('二维码')
    expect(html).toContain('重新扫码')
  })

  it('untrusted 指向信任主机配置（tailscale serve --trusted-host）', () => {
    const html = pairingGuideView('untrusted')
    expect(html).toContain('信任')
    expect(html).toContain('tailscale serve')
  })

  it('两支文案不同，不共用一屏', () => {
    expect(pairingGuideView('unpaired')).not.toBe(pairingGuideView('untrusted'))
  })

  it('401 类探针结果映射到 unpaired 引导（其文案含重新扫码）；error 不映射', () => {
    // R2 替换用例：探针只观察得到 401（unpaired）或 403（untrusted），
    // token-rejected 一支已删——401 由 unpaired 引导的「重新扫码」覆盖。
    expect(guidanceReasonForKind('unpaired')).toBe('unpaired')
    expect(guidanceReasonForKind('untrusted')).toBe('untrusted')
    expect(guidanceReasonForKind('error')).toBe(null)
    const html = pairingGuideView(guidanceReasonForKind('unpaired')!)
    expect(html).toContain('重新扫码')
  })
})

describe('renderHostList（主机清单）', () => {
  it('渲染 peers 的在线/离线与 dsh 标记，dsh:false 不给标记', () => {
    const html = renderHostList({
      peers: [
        { dnsName: 'mac-a.tail-scale.ts.net', online: true, dsh: true },
        { dnsName: 'box-b.tail-scale.ts.net', online: false, dsh: false },
      ],
    })
    expect(html).toContain('mac-a.tail-scale.ts.net')
    expect(html).toContain('box-b.tail-scale.ts.net')
    expect(html).toContain('在线')
    expect(html).toContain('离线')
    expect(html.match(/>DSH</g)).toHaveLength(1)
  })

  it('tailscale 查询失败时显示结构化 error 原文与不可用提示，功能不受影响', () => {
    const html = renderHostList({ peers: [], error: 'tailscale 查询失败：boom' })
    expect(html).toContain('tailscale 查询失败：boom')
    expect(html).toContain('不可用')
  })

  it('加载中给加载文案', () => {
    expect(renderHostList({ peers: [], loading: true })).toContain('正在获取')
  })

  it('dnsName 等 interp 字段做 HTML 转义', () => {
    const html = renderHostList({ peers: [{ dnsName: '<script>alert(1)</script>', online: true, dsh: false }] })
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

describe('renderSessionList（会话列表）', () => {
  const items = [
    {
      sessionId: 'session-aaa',
      updatedAt: 1791916709370,
      running: true,
      blank: false,
      agentAvailable: true,
      projections: { kind: 'sequenced', asOfSeq: 3, values: { title: '修登录bug' } },
    },
    { sessionId: 'session-bbb', updatedAt: 1791916700000, running: false, blank: false, agentAvailable: false },
  ]

  it('渲染标题（无 projections 回退到 sessionId）与运行中标记', () => {
    const html = renderSessionList({ items, hasMore: false })
    expect(html).toContain('修登录bug')
    expect(html).toContain('运行中')
    expect(html).toContain('session-bbb')
    expect(html.match(/data-action="open-session"/g)).toHaveLength(2)
  })

  it('hasMore 为真渲染「加载更早」，为假不渲染', () => {
    expect(renderSessionList({ items, hasMore: true })).toContain('加载更早')
    expect(renderSessionList({ items, hasMore: true })).toContain('data-action="load-more-sessions"')
    expect(renderSessionList({ items, hasMore: false }).match(/load-more-sessions/g)).toBe(null)
  })

  it('标题做 HTML 转义', () => {
    const html = renderSessionList({
      items: [{
        sessionId: 'session-x',
        updatedAt: 1,
        running: false,
        blank: false,
        agentAvailable: true,
        projections: { kind: 'sequenced', asOfSeq: 0, values: { title: '<img src=x onerror=alert(1)>' } },
      }],
      hasMore: false,
    })
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img')
  })
})

describe('renderConversation（对话视图）', () => {
  const session = { sessionId: 'session-ccc', title: '手机联调', running: false }

  it('user/assistant 消息成对渲染气泡，tool 事件只给弱化标记', () => {
    const conv = stateFold(null, {
      kind: 'append',
      records: [
        eventRecord('user/message', 0, { content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } }),
        eventRecord('tool/call', 1, { toolName: 'bash' }),
        eventRecord('assistant/message', 2, { message: { content: [{ type: 'text', text: '答复' }] } }),
      ],
    })
    const html = renderConversation({ session, conv, hasMore: false })
    expect(html).toContain('你好')
    expect(html).toContain('答复')
    expect(html).toContain('data-role="user"')
    expect(html).toContain('data-role="assistant"')
    expect(html).toContain('tool/call')
  })

  it('agent/inbox/spliced 里 source.kind=user 的排入消息按用户气泡渲染', () => {
    const conv = stateFold(null, {
      kind: 'append',
      records: [eventRecord('agent/inbox/spliced', 0, {
        target: 'session-ccc',
        start: 0,
        inserted: [{ source: { kind: 'user', rpcId: 'rpc-1' }, content: [{ type: 'text', text: '排队的话' }] }],
      })],
    })
    const html = renderConversation({ session, conv, hasMore: false })
    expect(html).toContain('排队的话')
    expect(html).toContain('data-role="user"')
  })

  it('hasMore 为真渲染「加载更早」，为假不渲染', () => {
    const conv = stateFold(null, { kind: 'append', records: [eventRecord('user/message', 0, { content: [{ type: 'text', text: '嗨' }] })] })
    const more = renderConversation({ session, conv, hasMore: true })
    expect(more).toContain('加载更早')
    expect(more).toContain('data-action="load-older"')
    const less = renderConversation({ session, conv, hasMore: false })
    expect(less.match(/load-older/g)).toBe(null)
  })

  it('运行中的会话渲染停止按钮；空会话给空态文案', () => {
    const conv = stateFold(null, { kind: 'append', records: [] })
    const running = renderConversation({ session: { ...session, running: true }, conv, hasMore: false })
    expect(running).toContain('data-action="stop"')
    expect(running).toContain('停止')
    const empty = renderConversation({ session, conv, hasMore: false })
    expect(empty).toContain('还没有消息')
  })

  it('加载中与加载失败的文案都落在会话屏里', () => {
    expect(renderConversation({ session, conv: null, hasMore: false, loading: true })).toContain('正在加载')
    expect(renderConversation({ session, conv: null, hasMore: false, error: 'RPC session/page 失败' })).toContain('RPC session/page 失败')
  })

  it('在流的 assistant 块渲染成「正在输入」提示而不是死等', () => {
    let conv = stateFold(null, { kind: 'assistant-stream', frame: { type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1, startedAfterSeq: 0 } })
    conv = stateFold(conv, { kind: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a1', revision: 2, index: 0, time: 1, chunk: { type: 'text', text: '流式' } } })
    const html = renderConversation({ session, conv, hasMore: false })
    expect(html).toContain('正在输入')
  })
})

describe('renderApprovalBanners（待批权限横幅）', () => {
  it('渲染工具名与原因，带批准/拒绝动作钩子与 eventId', () => {
    const html = renderApprovalBanners([
      { eventId: 'evt-1', toolName: 'bash', displayReason: '要执行 ls' },
      { eventId: 'evt-2', toolName: 'write' },
    ])
    expect(html).toContain('bash')
    expect(html).toContain('要执行 ls')
    expect(html).toContain('data-event-id="evt-1"')
    expect(html).toContain('data-action="approve"')
    expect(html).toContain('data-action="reject"')
    expect(html.match(/data-event-id="evt-2"/g)).toHaveLength(2)
  })

  it('displayReason 缺省回退 reason，再回退固定文案；内容转义', () => {
    const html = renderApprovalBanners([{ eventId: 'e', toolName: 'bash', reason: '<b>reason</b>' }])
    expect(html).toContain('&lt;b&gt;reason&lt;/b&gt;')
    expect(html).not.toContain('<b>reason</b>')
    const bare = renderApprovalBanners([{ eventId: 'e2', toolName: 'bash' }])
    expect(bare).toContain('请求执行工具')
  })
})

describe('stateFold（事件归并，幂等）', () => {
  it('append 按 seq 去重升序：重放同一记录不产生重复', () => {
    const step1 = stateFold(null, { kind: 'append', records: [eventRecord('user/message', 5, { content: [{ type: 'text', text: 'a' }] })] })
    const step2 = stateFold(step1, {
      kind: 'append',
      records: [eventRecord('user/message', 5, { content: [{ type: 'text', text: 'a' }] }), eventRecord('assistant/message', 6, { message: { content: [] } })],
    })
    expect(step2.records.map(record => record.event.seq)).toEqual([5, 6])
    // 幂等：把同样的输入再归并一遍，状态深度相等。
    expect(stateFold(step2, { kind: 'append', records: [eventRecord('user/message', 5, { content: [{ type: 'text', text: 'a' }] })] }))
      .toEqual(step2)
  })

  it('乱序 append 也保持升序', () => {
    const state = stateFold(null, {
      kind: 'append',
      records: [
        eventRecord('user/message', 6, {}),
        eventRecord('user/message', 5, {}),
      ],
    })
    expect(state.records.map(record => record.event.seq)).toEqual([5, 6])
  })

  it('prepend 前插更早页并更新 hasMore；重复归并同一页不重复、hasMore 不回退', () => {
    const base = stateFold(null, {
      kind: 'append',
      records: [eventRecord('user/message', 4, {}), eventRecord('user/message', 5, {})],
    })
    const older = {
      kind: 'prepend' as const,
      records: [eventRecord('user/message', 2, {}), eventRecord('user/message', 3, {})],
      hasMore: true,
    }
    const once = stateFold(base, older)
    expect(once.records.map(record => record.event.seq)).toEqual([2, 3, 4, 5])
    expect(once.hasMore).toBe(true)
    expect(stateFold(once, older)).toEqual(once)
    // hasMore 不被重放打回假：仍 true。
    expect(stateFold(once, older).hasMore).toBe(true)
  })

  it('prepend 到底（hasMore:false）后状态如实记录', () => {
    const base = stateFold(null, { kind: 'append', records: [eventRecord('user/message', 1, {})] })
    const state = stateFold(base, { kind: 'prepend', records: [eventRecord('user/message', 0, {})], hasMore: false })
    expect(state.hasMore).toBe(false)
    expect(state.records.map(record => record.event.seq)).toEqual([0, 1])
  })

  it('assistant-stream：start 起块、chunk 按 index 归位，同帧重放幂等，end 收块', () => {
    const start = { type: 'start' as const, attemptId: 'a1', revision: 1, turn: 1, step: 1, startedAfterSeq: 0 }
    const chunk0 = { type: 'chunk' as const, attemptId: 'a1', revision: 2, index: 0, time: 1, chunk: { type: 'text', text: 'x' } }
    const chunk1 = { type: 'chunk' as const, attemptId: 'a1', revision: 3, index: 1, time: 2, chunk: { type: 'text', text: 'y' } }

    let state = stateFold(null, { kind: 'assistant-stream', frame: start })
    expect(state.streams).toHaveLength(1)
    expect(state.streams[0]!.attemptId).toBe('a1')

    state = stateFold(state, { kind: 'assistant-stream', frame: chunk0 })
    state = stateFold(state, { kind: 'assistant-stream', frame: chunk1 })
    expect(state.streams[0]!.blocks).toHaveLength(2)

    // 幂等：整段重放一遍（start/chunk0/chunk1 顺序再来），状态深度相等。
    const replay = stateFold(
      stateFold(stateFold(state, { kind: 'assistant-stream', frame: start }), { kind: 'assistant-stream', frame: chunk0 }),
      { kind: 'assistant-stream', frame: chunk1 },
    )
    expect(replay).toEqual(state)

    // 换成不对应的 start（同 attemptId 重开）不炸也不清已收的块。
    expect(stateFold(state, { kind: 'assistant-stream', frame: start }).streams[0]!.blocks).toHaveLength(2)

    const ended = stateFold(state, { kind: 'assistant-stream', frame: { type: 'end', attemptId: 'a1', revision: 4, index: 2, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 7 } } })
    expect(ended.streams).toHaveLength(0)
    // end 重放幂等。
    expect(stateFold(ended, { kind: 'assistant-stream', frame: { type: 'end', attemptId: 'a1', revision: 4, index: 2, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 7 } } })).toEqual(ended)
  })

  it('归并不改写入参状态（纯函数）', () => {
    const base = stateFold(null, { kind: 'append', records: [eventRecord('user/message', 1, {})] })
    const snapshot = structuredClone(base)
    stateFold(base, { kind: 'prepend', records: [eventRecord('user/message', 0, {})], hasMore: false })
    expect(base).toEqual(snapshot)
  })
})
