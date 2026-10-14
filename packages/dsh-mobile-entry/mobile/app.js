/**
 * 手机页应用挂接层：只做 DOM 挂接与调用编排。
 *
 * 分工铁律（无构建链的原生 ESM）：HTML 与全部用户可见文案出自 views.js 纯
 * 函数；本文件不拼用户可见字符串，只持状态、调 wire.js、把视图串塞进 DOM、
 * 在根部做一次事件委托。协议事实（端点、信封、帧形、throughSeq 语义）全部
 * 来自 Task 6 线上探针（docs/research/2026-10-15-mobile-wire.md）。
 *
 * 入口流程（spec §5）：先 rpcCall session/list 探测配对状态再渲染首页——
 * 401（unpaired）与 403（untrusted）各给一支配对引导（R2：没有第三支，
 * 无效令牌由官方交换的 401 页接管，探针只会看到这两类）；其余失败给错误屏。
 * 配对正常时首屏是主机清单（peers 仅展示，v1 不跨域连接），「会话」页签里
 * 是会话列表，点开经 session/page 取最新页。
 *
 * 会话内容没有 follow 流可开（wire.js 的 MuxConnection 只订阅 $events），
 * v1 的做法：进会话先用「游标探测」取最新页——session/page 的 throughSeq
 * 故意超界，宿主按实测报 `… past cursor N`，N 就是日志末端（空日志为 -1）；
 * 再用 throughSeq=N 倒页 PAGE_SIZE 条。之后靠 $events 的 api-session/* 广播
 * 触发整页补拉（spec §7「第一版整页级补齐」），assistant-stream 的归并在
 * stateFold 里就位，等将来开了 follow 流即可接上。
 *
 * 事件通道：MuxConnection 经 makeSocketFactory 适配真 WebSocket。构造失败
 * 在工厂内就地吞掉（返回立即断开的死 socket，界面显示未连接）——绝不让它
 * 逃进 MuxConnection 的重连定时器回调，否则退避循环会永久卡死。
 */

import {
  MUX_PATH,
  MuxConnection,
  SESSION_CANCEL_ENDPOINT,
  SESSION_HISTORY_ENDPOINT,
  SESSION_LIST_ENDPOINT,
  SESSION_PROMPT_ENDPOINT,
  rpcCall,
} from './wire.js'
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
} from './views.js'

/** 本机 peers 接口（Task 5 的 exact 路由，同源 GET）。 */
const PEERS_PATH = '/threadharbor/mobile/peers'

/** session/page 一页最多取多少条 durable 记录。 */
const PAGE_SIZE = 50

/** 会话列表客户端分页的一批条数（host 的 session/list 不分页）。 */
const SESSIONS_BATCH = 20

/** api-session/* 广播触发刷新的防抖窗口（毫秒）。 */
const REFRESH_DEBOUNCE_MS = 500

/**
 * 造一个 socketFactory（carryover#3 的落点）：真 WebSocket 构造失败（坏地址、
 * 升级被拒等）在工厂内就地吞掉——返回一只「立即断开」的死 socket 并把错误
 * 交给 onNotice 显示，绝不向调用方抛，也就不会逃进 MuxConnection 的重连
 * 定时器回调把退避循环永久打死。
 */
export function makeSocketFactory(onNotice, WebSocketCtor = globalThis.WebSocket) {
  return function socketFactory(url) {
    let ws
    try {
      ws = new WebSocketCtor(url)
    } catch (error) {
      // 构造失败不外逃：死 socket 的 onclose 异步触发，让 MuxConnection 走
      // 正常的断线退避路径；错误原文交给界面显示。
      const message = error instanceof Error ? error.message : String(error)
      const dead = { send() {}, close() {}, onopen: null, onmessage: null, onclose: null }
      queueMicrotask(() => {
        onNotice({ kind: 'construct-error', message })
        dead.onclose?.()
      })
      return dead
    }
    return {
      send: data => ws.send(data),
      close: () => ws.close(),
      get onopen() { return ws.onopen },
      set onopen(value) { ws.onopen = value },
      get onmessage() { return ws.onmessage },
      set onmessage(value) { ws.onmessage = value },
      set onclose(value) {
        // 包一层：断线事实先报给界面（未连接状态），再交给连接的恢复逻辑。
        ws.onclose = value === null ? null : () => {
          onNotice({ kind: 'socket-closed' })
          value()
        }
      },
      get onclose() { return ws.onclose },
    }
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function makeRequestId(rpcSeq) {
  const uuid = globalThis.crypto?.randomUUID?.()
  return typeof uuid === 'string' ? uuid : `req-${Date.now()}-${rpcSeq}`
}

function clientTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC'
  } catch {
    return 'UTC'
  }
}

function seqOf(record) {
  return record?.event?.seq
}

function maxSeqOf(conv) {
  if (conv === null || conv.records.length === 0) return undefined
  return seqOf(conv.records[conv.records.length - 1])
}

/**
 * 滚动决策（纯函数，导出仅为测试）：三种意图 → 重建后的 scrollTop。
 * - restore（「加载更早」prepend）：内容整体下移，按高度差补偿锚点，阅读位不动；
 * - keep（横幅/错误行等无关重渲染）：原样保持；
 * - bottom（首开、有新消息追加）：贴到最新一条。
 * 负值钳到 0。
 */
export function nextScrollTop(mode, anchor, newHeight) {
  if (mode === 'restore' && anchor !== null) return Math.max(0, anchor.top + (newHeight - anchor.height))
  if (mode === 'keep' && anchor !== null) return anchor.top
  return newHeight
}

/**
 * 启动应用：建壳、探测配对、渲染、挂事件。state 全部收在闭包里，一次
 * bootApp 一份（测试可各自起一份互不串扰）。
 */
export async function bootApp(root, deps = {}) {
  const fetchLike = deps.fetchLike ?? ((...args) => globalThis.fetch(...args))
  const WebSocketCtor = deps.WebSocketCtor ?? globalThis.WebSocket

  let rpcSeq = 0
  let connection = null
  let refreshTimer = null
  let refreshingSessions = false
  // 会话代际：每次打开会话/返回/重boot 都递增。会话内容的一切在途应答在
  // 兑现点核对代际，过期即丢弃——慢探测/慢倒页落到新会话上就是静默错数据。
  let convGeneration = 0
  // 滚动意图：由改状态的代码声明，render 消费后归 keep。
  let convScrollIntent = 'bottom'

  const state = {
    screen: 'boot',
    guideReason: null,
    errorMessage: '',
    hosts: { peers: [], error: undefined, loading: false },
    sessions: [],
    sessionsShown: SESSIONS_BATCH,
    sessionId: null,
    conv: null,
    convLoading: false,
    convError: undefined,
    olderLoading: false,
    draft: '',
    approvals: new Map(),
    pendingAnswers: new Set(),
    mux: 'connecting',
    muxDetail: '',
  }

  function shell() {
    root.innerHTML = [
      '<header class="appbar"><span class="app-title">ThreadHarbor 手机端</span>'
      + '<span class="mux-state" id="mux-state"></span></header>',
      '<div class="banners" id="banners"></div>',
      '<main id="main"></main>',
      '<nav class="tabbar" id="tabbar"></nav>',
    ].join('')
    root.addEventListener('click', onClick)
    root.addEventListener('submit', onSubmit)
    root.addEventListener('input', onInput)
  }

  // ---------- 渲染 ----------

  function muxStateText() {
    if (state.mux === 'online') return '事件通道：已连接'
    if (state.mux === 'offline') {
      return state.muxDetail.length > 0
        ? `事件通道：未连接（${state.muxDetail}）`
        : '事件通道：未连接（自动重试）'
    }
    return '事件通道：连接中…'
  }

  function currentSummary() {
    return state.sessions.find(item => item?.sessionId === state.sessionId) ?? null
  }

  function visibleSessions() {
    return state.sessions.slice(0, state.sessionsShown)
  }

  function render() {
    const activeId = document.activeElement instanceof Element ? document.activeElement.id : null
    const chip = root.querySelector('#mux-state')
    if (chip !== null) {
      chip.textContent = muxStateText()
      chip.hidden = !(state.screen === 'hosts' || state.screen === 'sessions' || state.screen === 'conversation')
      chip.className = `mux-state mux-${state.mux}`
    }
    const banners = root.querySelector('#banners')
    if (banners !== null) {
      banners.innerHTML = renderApprovalBanners(
        [...state.approvals.values()].map(item => ({ ...item, pending: state.pendingAnswers.has(item.eventId) })),
      )
      banners.hidden = state.approvals.size === 0
    }
    const main = root.querySelector('#main')
    const tabbar = root.querySelector('#tabbar')
    if (main === null || tabbar === null) return
    switch (state.screen) {
      case 'boot':
        main.innerHTML = renderLoading()
        tabbar.innerHTML = ''
        break
      case 'guide':
        main.innerHTML = pairingGuideView(state.guideReason)
        tabbar.innerHTML = ''
        break
      case 'error':
        main.innerHTML = renderErrorScreen(state.errorMessage)
        tabbar.innerHTML = ''
        break
      case 'hosts':
        main.innerHTML = renderHostList(state.hosts)
        tabbar.innerHTML = tabbarHtml('hosts')
        break
      case 'sessions':
        main.innerHTML = renderSessionList({
          items: visibleSessions(),
          hasMore: state.sessions.length > state.sessionsShown,
        })
        tabbar.innerHTML = tabbarHtml('sessions')
        break
      case 'conversation': {
        // 重建前抓旧列表的滚动锚点；重建后按意图落位（nextScrollTop）。
        const anchor = readConvAnchor(main)
        const summary = currentSummary()
        main.innerHTML = renderConversation({
          session: {
            sessionId: state.sessionId ?? '',
            title: summary?.projections?.values?.title,
            running: summary?.running === true,
          },
          conv: state.conv,
          hasMore: state.conv?.hasMore === true,
          loading: state.convLoading,
          error: state.convError,
        })
        applyConvScroll(main, anchor)
        tabbar.innerHTML = ''
        break
      }
    }
    const input = main.querySelector('#prompt-input')
    if (input !== null) {
      input.value = state.draft
      if (activeId === 'prompt-input') input.focus()
    }
  }

  function readConvAnchor(main) {
    const list = main.querySelector('.msg-list')
    return list === null ? null : { top: list.scrollTop, height: list.scrollHeight }
  }

  function applyConvScroll(main, anchor) {
    const list = main.querySelector('.msg-list')
    if (list === null) {
      convScrollIntent = 'keep'
      return
    }
    list.scrollTop = nextScrollTop(convScrollIntent, anchor, list.scrollHeight)
    convScrollIntent = 'keep'
  }

  function tabbarHtml(activeTab) {
    return [
      `<button type="button" class="tab${activeTab === 'hosts' ? ' tab-active' : ''}" data-action="tab" data-tab="hosts">主机</button>`,
      `<button type="button" class="tab${activeTab === 'sessions' ? ' tab-active' : ''}" data-action="tab" data-tab="sessions">会话</button>`,
    ].join('')
  }

  // ---------- 入口流程 ----------

  async function boot() {
    if (connection !== null) {
      connection.close()
      connection = null
    }
    convGeneration += 1 // 重 boot 使一切在途会话应答过期
    state.approvals.clear()
    state.pendingAnswers.clear()
    state.mux = 'connecting'
    state.muxDetail = ''
    state.screen = 'boot'
    render()
    let outcome
    try {
      outcome = await rpcCall(fetchLike, SESSION_LIST_ENDPOINT, { _request: {} }, `boot-${++rpcSeq}`)
    } catch (error) {
      state.screen = 'error'
      state.errorMessage = `无法连接主机：${messageOf(error)}`
      render()
      return
    }
    if (outcome.ok !== true) {
      applyFailureKind(outcome)
      render()
      return
    }
    state.sessions = Array.isArray(outcome.result?.items) ? outcome.result.items : []
    state.sessionsShown = SESSIONS_BATCH
    state.screen = 'hosts'
    render()
    openConnection()
    void loadHosts()
  }

  /** RPC 失败种类落屏：401/403 → 对应配对引导（R2），其余 → 错误屏。 */
  function applyFailureKind(outcome) {
    const reason = guidanceReasonForKind(outcome.kind)
    if (reason !== null) {
      state.screen = 'guide'
      state.guideReason = reason
      return
    }
    state.screen = 'error'
    state.errorMessage = outcome.message
  }

  // ---------- 主机清单 ----------

  async function loadHosts() {
    state.hosts = { peers: [], error: undefined, loading: true }
    if (state.screen === 'hosts') render()
    try {
      const response = await fetchLike(PEERS_PATH)
      if (response.status !== 200) {
        state.hosts = { peers: [], error: `主机清单请求失败：HTTP ${response.status}` }
      } else {
        const body = JSON.parse(await response.text())
        state.hosts = {
          peers: Array.isArray(body?.peers) ? body.peers : [],
          error: typeof body?.error === 'string' ? body.error : undefined,
        }
      }
    } catch (error) {
      state.hosts = { peers: [], error: messageOf(error) }
    }
    if (state.screen === 'hosts') render()
  }

  // ---------- 会话列表 ----------

  async function refreshSessions() {
    if (refreshingSessions) return
    refreshingSessions = true
    try {
      const outcome = await rpcCall(fetchLike, SESSION_LIST_ENDPOINT, { _request: {} }, `sessions-${++rpcSeq}`)
      if (outcome.ok === true) {
        state.sessions = Array.isArray(outcome.result?.items) ? outcome.result.items : []
        if (state.screen === 'sessions' || state.screen === 'conversation') render()
      } else {
        // 凭据过期（401）→ 回配对引导屏（spec §5）；其余失败保留旧清单。
        const reason = guidanceReasonForKind(outcome.kind)
        if (reason !== null) {
          state.guideReason = reason
          state.screen = 'guide'
          render()
        }
      }
    } catch {
      // 传输抖动：保留旧清单，等下一次广播/页签切换再试。
    } finally {
      refreshingSessions = false
    }
  }

  function scheduleRefresh() {
    if (refreshTimer !== null) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      void refreshSessions()
      if (state.screen === 'conversation' && state.sessionId !== null) {
        void refreshConversation()
      }
    }, REFRESH_DEBOUNCE_MS)
  }

  // ---------- 会话内容 ----------

  async function rpcSessionPage(sessionId, throughSeq, maxMessages, label) {
    return rpcCall(fetchLike, SESSION_HISTORY_ENDPOINT, {
      request: { address: { kind: 'session', sessionId }, throughSeq, maxMessages },
    }, `${label}-${++rpcSeq}`)
  }

  /**
   * 游标探测：throughSeq 故意超界，宿主必报 `… past cursor N`（Task 6 实测，
   * N=日志末端；空日志 N=-1）。返回 {status:'ok',…} | {status:'guide'} |
   * {status:'error'}；解析不出游标就报错，不硬猜。
   */
  async function fetchLatestPage(sessionId) {
    const probe = await rpcSessionPage(sessionId, Number.MAX_SAFE_INTEGER, 1, 'cursor')
    if (probe.ok) {
      // 协议上不可能：throughSeq 必须不小于已载入窗口且 MAX_SAFE_INTEGER 不
      // 会是合法 seq。真发生了按错误处置，不猜。
      return { status: 'error', message: '游标探测意外成功（协议形状变化，请反馈）' }
    }
    const reason = guidanceReasonForKind(probe.kind)
    if (reason !== null) return { status: 'guide', reason }
    const match = /past cursor (-?\d+)/.exec(probe.message)
    const cursor = match === null ? Number.NaN : Number(match[1])
    if (!Number.isSafeInteger(cursor)) {
      return { status: 'error', message: `无法确定会话最新位置：${probe.message}` }
    }
    if (cursor < 0) return { status: 'ok', records: [], hasMore: false }
    const outcome = await rpcSessionPage(sessionId, cursor, PAGE_SIZE, 'page')
    if (!outcome.ok) {
      const guide = guidanceReasonForKind(outcome.kind)
      if (guide !== null) return { status: 'guide', reason: guide }
      return { status: 'error', message: outcome.message }
    }
    return {
      status: 'ok',
      records: Array.isArray(outcome.result?.records) ? outcome.result.records : [],
      hasMore: outcome.result?.hasMore === true,
    }
  }

  /**
   * 把最新页并进对话状态：只追加比已有更新的记录（append 归并幂等）；一轮
   * 新增超过一页出现空洞时，窗口整体换成最新页——宁可少显历史，不显示断层。
   * 追加了新内容 → 滚动意图 bottom（贴到最新）；没有变化 → keep。
   */
  function mergeLatestPage(page) {
    const maxSeq = maxSeqOf(state.conv)
    const tail = maxSeq === undefined
      ? page.records
      : page.records.filter(record => seqOf(record) > maxSeq)
    const hole = maxSeq !== undefined && tail.length > 0 && seqOf(tail[0]) > maxSeq + 1
    if (hole) {
      state.conv = stateFold(null, { kind: 'append', records: page.records })
      convScrollIntent = 'bottom'
    } else if (tail.length > 0) {
      state.conv = stateFold(state.conv, { kind: 'append', records: tail })
      convScrollIntent = 'bottom'
    } else {
      convScrollIntent = 'keep'
    }
    if (state.conv === null) {
      state.conv = { records: [], streams: [], hasMore: false }
    }
    state.conv.hasMore = page.hasMore || state.conv.hasMore
  }

  async function openSession(sessionId) {
    const generation = ++convGeneration
    state.screen = 'conversation'
    state.sessionId = sessionId
    state.conv = null
    state.convError = undefined
    state.convLoading = true
    convScrollIntent = 'bottom'
    render()
    const page = await fetchLatestPage(sessionId)
    // 兑现点核对代际：用户已换会话/返回/重 boot 的话，这版应答整体丢弃。
    if (generation !== convGeneration) return
    state.convLoading = false
    if (page.status === 'ok') {
      mergeLatestPage(page)
      state.convError = undefined
    } else if (page.status === 'guide') {
      state.guideReason = page.reason
      state.screen = 'guide'
    } else {
      state.convError = page.message
    }
    render()
  }

  async function refreshConversation() {
    if (state.sessionId === null) return
    const generation = convGeneration
    const page = await fetchLatestPage(state.sessionId)
    if (generation !== convGeneration || state.sessionId === null) return
    if (page.status === 'ok') {
      mergeLatestPage(page)
      state.convError = undefined
    } else if (page.status === 'guide') {
      state.guideReason = page.reason
      state.screen = 'guide'
    } else {
      state.convError = page.message
    }
    render()
  }

  async function loadOlder() {
    if (state.olderLoading || state.sessionId === null) return
    const generation = convGeneration
    const oldest = state.conv === null ? undefined : seqOf(state.conv.records[0])
    if (typeof oldest !== 'number') return
    const throughSeq = oldest - 1
    // throughSeq 语义（Task 6 §3.2）：已载入窗口最旧之下的含端截断；-1 →
    // 空页即到底，按钮直接消失。
    if (throughSeq < 0) {
      state.conv = { ...state.conv, hasMore: false }
      convScrollIntent = 'keep'
      render()
      return
    }
    state.olderLoading = true
    render()
    const outcome = await rpcSessionPage(state.sessionId, throughSeq, PAGE_SIZE, 'older')
    // 兑现点核对代际：用户已换会话的话，这页更早记录绝不并入新会话；
    // olderLoading 仍要放掉，否则残留的 true 会卡死新会话的「加载更早」。
    if (generation !== convGeneration) {
      state.olderLoading = false
      return
    }
    state.olderLoading = false
    if (outcome.ok === true) {
      state.conv = stateFold(state.conv, {
        kind: 'prepend',
        records: Array.isArray(outcome.result?.records) ? outcome.result.records : [],
        hasMore: outcome.result?.hasMore === true,
      })
      convScrollIntent = 'restore'
      state.convError = undefined
    } else {
      convScrollIntent = 'keep'
      const reason = guidanceReasonForKind(outcome.kind)
      if (reason !== null) {
        state.guideReason = reason
        state.screen = 'guide'
      } else {
        state.convError = outcome.message
      }
    }
    render()
  }

  // ---------- 发消息 / 停止 ----------

  async function sendPrompt(text) {
    if (state.sessionId === null) return
    const outcome = await rpcCall(fetchLike, SESSION_PROMPT_ENDPOINT, {
      request: {
        requestId: makeRequestId(rpcSeq),
        sessionId: state.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
        clientTimeZone: clientTimeZone(),
      },
    }, `prompt-${++rpcSeq}`)
    if (outcome.ok === true) {
      state.draft = ''
      void refreshConversation()
    } else {
      const reason = guidanceReasonForKind(outcome.kind)
      if (reason !== null) {
        state.guideReason = reason
        state.screen = 'guide'
      } else {
        state.convError = outcome.message
      }
    }
    render()
  }

  async function stopSession() {
    if (state.sessionId === null) return
    const outcome = await rpcCall(fetchLike, SESSION_CANCEL_ENDPOINT, {
      request: { sessionId: state.sessionId },
    }, `cancel-${++rpcSeq}`)
    if (outcome.ok !== true) {
      const reason = guidanceReasonForKind(outcome.kind)
      if (reason !== null) {
        state.guideReason = reason
        state.screen = 'guide'
      } else {
        state.convError = outcome.message
      }
      render()
      return
    }
    await refreshSessions()
    await refreshConversation()
  }

  // ---------- 事件通道 ----------

  function onSocketNotice(notice) {
    if (notice.kind === 'socket-closed') {
      state.mux = 'offline'
    } else {
      state.mux = 'offline'
      state.muxDetail = notice.message ?? ''
    }
    render()
  }

  function openConnection() {
    const protocol = globalThis.location?.protocol === 'https:' ? 'wss:' : 'ws:'
    const host = globalThis.location?.host ?? ''
    try {
      connection = new MuxConnection(
        () => `${protocol}//${host}${MUX_PATH}`,
        makeSocketFactory(onSocketNotice, WebSocketCtor),
        fetchLike,
      )
    } catch (error) {
      state.mux = 'offline'
      state.muxDetail = messageOf(error)
      render()
      return
    }
    connection.onEvent('ready', () => {
      state.mux = 'online'
      state.muxDetail = ''
      render()
    })
    connection.onEvent('waterfall', onWaterfall)
    connection.onEvent('cancel', onCancelFrame)
    connection.onEvent('emit', onEmit)
    connection.onEvent('error', value => {
      state.muxDetail = typeof value?.message === 'string' ? value.message : '事件流错误'
      render()
    })
  }

  /** waterfall 事件：v1 只接 approval/request，进顶部横幅。 */
  function onWaterfall(value) {
    if (value?.event !== 'approval/request' || typeof value.eventId !== 'string') return
    state.approvals.set(value.eventId, {
      eventId: value.eventId,
      toolName: typeof value.request?.toolName === 'string' ? value.request.toolName : '未知工具',
      displayReason: typeof value.request?.displayReason === 'string' ? value.request.displayReason : undefined,
      reason: typeof value.request?.reason === 'string' ? value.request.reason : undefined,
    })
    render()
  }

  /** cancel 帧：谁先答谁生效，其余端据此撤卡（Task 6 §6.2）。 */
  function onCancelFrame(value) {
    if (typeof value?.eventId !== 'string') return
    if (state.approvals.delete(value.eventId)) render()
  }

  /** api-session/* 广播：会话清单与打开中的会话整页补拉（防抖）。 */
  function onEmit(value) {
    if (typeof value?.event !== 'string' || !value.event.startsWith('api-session/')) return
    scheduleRefresh()
  }

  // ---------- 应答 ----------

  async function answerApproval(eventId, approve) {
    if (connection === null || state.pendingAnswers.has(eventId)) return
    // 在途标记：横幅按钮渲染成 disabled（UI 不邀双击），重复派发在此拦下。
    state.pendingAnswers.add(eventId)
    render()
    const outcome = await connection.answer(eventId, {
      kind: 'result',
      value: approve ? 'allowed-once' : 'rejected',
    })
    state.pendingAnswers.delete(eventId)
    if (outcome.ok === true) {
      state.approvals.delete(eventId)
    } else {
      // 首答已生效时宿主报迟到，error 是良性的——cancel 帧会来收卡；真失败
      // 保留横幅让操作者重试。
      state.muxDetail = outcome.message
    }
    render()
  }

  // ---------- 事件委托 ----------

  function onClick(event) {
    const target = event.target instanceof Element ? event.target.closest('[data-action]') : null
    if (target === null) return
    switch (target.getAttribute('data-action')) {
      case 'retry-boot': void boot(); break
      case 'tab': {
        const tab = target.getAttribute('data-tab')
        if (tab === 'hosts' || tab === 'sessions') {
          state.screen = tab
          if (tab === 'sessions') void refreshSessions()
          render()
        }
        break
      }
      case 'refresh-hosts': void loadHosts(); break
      case 'load-more-sessions':
        state.sessionsShown += SESSIONS_BATCH
        render()
        break
      case 'open-session': {
        const sessionId = target.getAttribute('data-session-id')
        if (sessionId !== null) void openSession(sessionId)
        break
      }
      case 'back':
        convGeneration += 1 // 返回即作废在途的会话内容应答
        state.screen = 'sessions'
        state.sessionId = null
        state.conv = null
        state.convError = undefined
        render()
        break
      case 'load-older': void loadOlder(); break
      case 'stop': void stopSession(); break
      case 'approve':
      case 'reject': {
        const eventId = target.getAttribute('data-event-id')
        if (eventId !== null) void answerApproval(eventId, target.getAttribute('data-action') === 'approve')
        break
      }
    }
  }

  function onSubmit(event) {
    const form = event.target instanceof Element ? event.target : null
    if (form?.id !== 'prompt-form') return
    event.preventDefault()
    const input = form.querySelector('#prompt-input')
    const text = input instanceof HTMLInputElement ? input.value.trim() : ''
    if (text.length === 0) return
    void sendPrompt(text)
  }

  function onInput(event) {
    if (event.target instanceof HTMLInputElement && event.target.id === 'prompt-input') {
      state.draft = event.target.value
    }
  }

  shell()
  await boot()
}
