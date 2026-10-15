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

import { createMachineBackend } from './backend-machine.js'
import { createHubBackend } from './backend-hub.js'
import {
  MUX_PATH,
  MuxConnection,
  SESSION_CANCEL_ENDPOINT,
  SESSION_HISTORY_ENDPOINT,
  SESSION_LIST_ENDPOINT,
  SESSION_PROMPT_ENDPOINT,
  PEERS_PATH,
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
  escapeHtml,
  stateFold,
} from './views.js'

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
  // 服务端在 index.html 里注入的模式（{"mode":"hub"}）。注入的 config 优先，
  // 其次看 window 上的全局（页面直开时没有），都没有就是直连。
  const injectedMode = deps.mode
    ?? (typeof globalThis.__THREADHARBOR_MOBILE__ === 'object' && globalThis.__THREADHARBOR_MOBILE__ !== null
      ? globalThis.__THREADHARBOR_MOBILE__.mode
      : undefined)
  if (injectedMode === 'hub' && deps.backend === undefined) {
    deps = { ...deps, backend: createHubBackend({ fetchLike, WebSocketCtor: deps.WebSocketCtor }) }
  }
  const WebSocketCtor = deps.WebSocketCtor ?? globalThis.WebSocket
  // 后端是「数据从哪来」的唯一出处。不注入时用直连那套，且它的每个方法都只是
  // 转交下面这些既有调用——直连行为不是靠两套代码保持一致，而是没有第二套。
  const isHub = deps.backend !== undefined && deps.backend.mode === 'hub'
  const eventsHolder = { handle: null }

  let rpcSeq = 0
  let connection = null
  let refreshTimer = null
  let refreshingSessions = false
  // 会话代际：每次打开会话/返回/重boot 都递增。会话内容的一切在途应答在
  // 兑现点核对代际，过期即丢弃——慢探测/慢倒页落到新会话上就是静默错数据。
  let convGeneration = 0
  // 滚动意图：由改状态的代码声明，render 消费后归 keep。
  let convScrollIntent = 'bottom'

  /**
   * 中转模式下 `machineId` 是「现在看的是哪台机器」；null 表示停在机器清单屏。
   * 直连模式全程为 null——那条路上没有第二台机器可切。
   */
  const state = {
    screen: 'boot',
    guideReason: null,
    errorMessage: '',
    machineId: null,
    machines: [],
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
    /** 事件 id → 它来自哪台机器。应答按它路由，不按「当前在看哪台」。 */
    approvalHosts: new Map(),
    pendingAnswers: new Set(),
    sessionsError: undefined,
    mux: 'connecting',
    muxDetail: '',
    /** 最近一次「应答没送出去」的一句话；在横幅那一带显示，任何屏都看得到。 */
    answerError: undefined,
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

  /** 当前机器的显示名（没有选中机器时为 null——直连模式一直是 null）。 */
  function currentMachineLabel() {
    if (state.machineId === null) return null
    const machine = state.machines.find(item => item?.hostId === state.machineId)
    if (machine === undefined) return null
    return machine.name ?? state.machineId
  }

  function visibleSessions() {
    return state.sessions.slice(0, state.sessionsShown)
  }

  function render() {
    const activeId = document.activeElement instanceof Element ? document.activeElement.id : null
    const chip = root.querySelector('#mux-state')
    if (chip !== null) {
      chip.textContent = muxStateText()
      chip.hidden = !(state.screen === 'hosts' || state.screen === 'machines' || state.screen === 'sessions' || state.screen === 'conversation')
      chip.className = `mux-state mux-${state.mux}`
    }
    const banners = root.querySelector('#banners')
    if (banners !== null) {
      // 应答那一下没送出去要说一句。之前它塞在「事件通道」那一格，而那一格只在
      // 通道断开时才显示那句话——通道好好的（常见情形）就一个字都不露，横幅
      // 挂在那里不消失，人只会以为还在转圈。
      const notice = typeof state.answerError === 'string' && state.answerError.length > 0
        ? `<p class="notice-error" role="alert">${escapeHtml(state.answerError)}</p>`
        : ''
      banners.innerHTML = notice + renderApprovalBanners(
        [...state.approvals.values()].map(item => ({ ...item, pending: state.pendingAnswers.has(item.eventId) })),
      )
      banners.hidden = state.approvals.size === 0 && notice === ''
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
        main.innerHTML = pairingGuideView(state.guideReason, isHub ? 'hub' : 'machine')
        tabbar.innerHTML = ''
        break
      case 'error':
        main.innerHTML = renderErrorScreen(state.errorMessage)
        tabbar.innerHTML = ''
        break
      case 'machines':
        main.innerHTML = renderHostList({
          machines: state.machines,
          error: state.hosts.error,
          loading: state.hosts.loading,
        })
        tabbar.innerHTML = ''
        break
      case 'hosts':
        main.innerHTML = renderHostList(state.hosts)
        tabbar.innerHTML = tabbarHtml('hosts')
        break
      case 'sessions':
        main.innerHTML = (isHub && state.machineId !== null
          ? '<button type="button" class="ghost" data-action="back-to-machines">← 换机器</button>'
          : '')
        + renderSessionList({
          items: visibleSessions(),
          hasMore: state.sessions.length > state.sessionsShown,
          machineLabel: currentMachineLabel(),
          // 取会话这一拍失败过：得说出来。以前这行读了却没人渲染，故障时手机上
          // 显示的是「还没有会话」——像空列表，不像出事。
          error: state.sessionsError,
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
    if (isHub) {
      // 中转模式：首屏就是机器清单，选定机器之后才去取那台机的会话。
      // 放在直连那步之前——它自己不走本机的 RPC 通道。
      state.screen = 'machines'
      render()
      await loadMachines()
      openHubEvents()
      return
    }
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

  // ---------- 机器清单（中转模式） ----------

  async function loadMachines() {
    state.hosts = { peers: [], error: undefined, loading: true }
    render()
    try {
      const body = await state.backend.listHosts()
      // 断掉的机器补一句「最后一次有动静是什么时候」：否则「离线很久」与
      // 「从来没成功过」在界面上长得一模一样。看板已经把 lastSeenText 这个位
      // 备好了，之前没有东西往里填。
      state.machines = Array.isArray(body?.hosts)
        ? body.hosts.map(host => ({ ...host, lastSeenText: lastSeenTextOf(host) }))
        : []
      state.hosts = { peers: [], error: body?.error, loading: false }
    } catch (error) {
      state.machines = []
      state.hosts = { peers: [], error: messageOf(error), loading: false }
    }
    // 横幅的机器名是事件**到的那一刻**取的。清单当时是空的（刷新失败期间就是
    // 空的），横幅只能写机器编号 mac-a，而编号对看的人没意义——两台机器都在
    // 列表里，得自己猜哪个是哪个。清单回来之后补一次。
    for (const [eventId, hostId] of state.approvalHosts) {
      const item = state.approvals.get(eventId)
      if (item === undefined || item.machineLabel !== hostId) continue
      const name = state.machines.find(machine => machine?.hostId === hostId)?.name
      if (typeof name === 'string' && name.length > 0) {
        state.approvals.set(eventId, { ...item, machineLabel: name })
      }
    }
    render()
  }

  /**
   * 进入某台机器：会话代际 +1，让上一台机器在途的慢应答整体作废。不这么做的话，
   * A 的应答回来时会画到 B 上——不报错，操作者却读到了另一台机器的内容。
   */
  async function enterMachine(hostId) {
    const machine = state.machines.find(item => item?.hostId === hostId)
    if (machine === undefined) return
    if (machine.online === false || machine.reachable === false) return
    convGeneration += 1
    state.machineId = hostId
    state.sessions = []
    state.sessionsError = undefined
    state.sessionId = null
    state.conv = null
    state.screen = 'sessions'
    state.sessionsShown = SESSIONS_BATCH
    render()
    await refreshSessions()
  }

  function backToMachines() {
    convGeneration += 1
    state.machineId = null
    state.sessions = []
    state.sessionId = null
    state.conv = null
    state.screen = 'machines'
    render()
  }

  /** 事件流：每帧带 hostId，据此更新对应机器的状态与该机的待批事项。 */
  function openHubEvents() {
    if (eventsHolder.handle !== null) return
    eventsHolder.handle = state.backend.connectEvents({
      onEvent(hostId, type, value) {
        if (typeof hostId !== 'string') return
        // 词表只有一份：中转转发的是上游 mux 的原始 item（type 是
        // waterfall/emit/cancel，事件名与字段都在同一层 value 上），所以这里
        // **复用直连分支的处理器**，不另编一套词表——上一版自己编了
        // 'approval/request'/'session/update' 这套线上不存在的名字，结果待批
        // 横幅在中转模式下永远不出现、广播也永远不触发刷新。
        if (type === 'waterfall') {
          if (value?.event !== 'approval/request' || typeof value.eventId !== 'string') return
          // 归属必须在入队前记下：应答要回到**发起它的那台**，而不是正在看的。
          state.approvalHosts.set(value.eventId, hostId)
          const from = state.machines.find(item => item?.hostId === hostId)
          onWaterfall(value, from?.name ?? hostId)
          return
        }
        if (type === 'cancel') {
          onCancelFrame(value)
          return
        }
        if (type === 'emit') {
          // 别的机器的广播只更新它自己的会话；正在看的那台变了才补拉。
          if (hostId === state.machineId) onEmit(value)
          return
        }
        if (type === 'ready') return
      },
      onStatus(status, detail) {
        state.mux = status === 'online' ? 'online' : status === 'connecting' ? 'connecting' : 'offline'
        state.muxDetail = detail ?? ''
        render()
      },
    })
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
      if (isHub) {
        if (state.machineId === null) return
        const body = await state.backend.listSessions(state.machineId)
        if (typeof body?.error === 'string') {
          // 手机与中转站的连接断了：进配对引导，与直连同一支路。少了这一步，
          // 列表页只会写一句「与中转站的连接已过期」，操作者不知道该做什么。
          const guide = guidanceReasonForKind(body.kind)
          if (guide !== null) {
            state.sessions = []
            state.sessionsError = undefined
            state.screen = 'guide'
            state.guideReason = guide
            render()
            return
          }
          state.sessions = []
          state.sessionsError = body.error
          render()
          return
        }
        state.sessionsError = undefined
        state.sessions = Array.isArray(body?.items) ? body.items : []
        if (state.screen === 'sessions' || state.screen === 'conversation') render()
        return
      }
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
    if (isHub && state.machineId !== null) {
      const body = await state.backend.pageMessages(state.machineId, sessionId, throughSeq, maxMessages)
      // 手机自己的连接断了走配对引导；那台机器在重连就只是这次没拿到内容。
      if (typeof body?.error === 'string') return { ok: false, kind: body.kind ?? 'rpc-error', message: body.error }
      if (body?.conv === undefined) return { ok: false, kind: 'rpc-error', message: '那台机器没有返回会话内容' }
      return { ok: true, result: body.conv }
    }
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
    if (isHub && state.machineId !== null) {
      const result = await state.backend.prompt(state.machineId, state.sessionId, text)
      if (result.ok === true) {
        state.draft = ''
        void refreshConversation()
      } else {
        state.convError = result.message
      }
      render()
      return
    }
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
    if (isHub && state.machineId !== null) {
      const result = await state.backend.cancel(state.machineId, state.sessionId)
      if (result.ok !== true) state.convError = result.message
      await refreshSessions()
      await refreshConversation()
      render()
      return
    }
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

  /**
   * waterfall 事件：v1 只接 approval/request，进顶部横幅。
   *
   * machineLabel 只有中转模式会传：那边两台机器可能同时有待批事项，不标明来源
   * 操作者只能靠猜。直连是本机、没有「来自哪台」这回事，不传时 DOM 与改之前
   * 逐字相同。
   */
  function onWaterfall(value, machineLabel) {
    if (value?.event !== 'approval/request' || typeof value.eventId !== 'string') return
    state.approvals.set(value.eventId, {
      eventId: value.eventId,
      toolName: typeof value.request?.toolName === 'string' ? value.request.toolName : '未知工具',
      displayReason: typeof value.request?.displayReason === 'string' ? value.request.displayReason : undefined,
      reason: typeof value.request?.reason === 'string' ? value.request.reason : undefined,
      ...(typeof machineLabel === 'string' && machineLabel.length > 0 ? { machineLabel } : {}),
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
    if (state.pendingAnswers.has(eventId)) return
    if (isHub) {
      // 归属靠事件带来的 hostId：应答必须回到发起它的那台机器，不能按「当前
      // 在看哪台」猜——操作者可能正看着 B，A 的待批却先弹出来。
      const hostId = state.approvalHosts.get(eventId)
      if (hostId === undefined) return
      state.pendingAnswers.add(eventId)
      render()
      const outcome = await state.backend.answer(hostId, eventId, {
        kind: 'result',
        value: approve ? 'allowed-once' : 'rejected',
      })
      state.pendingAnswers.delete(eventId)
      if (outcome.ok === true) {
        state.approvals.delete(eventId)
        state.approvalHosts.delete(eventId)
        state.answerError = undefined
        render()
        return
      }
      // 手机与中转站的连接断了：进配对引导。只往顶栏塞一句文案的话，操作者
      // 看到的只是一次「答不上」，横幅还挂在那里，重试多少次都一样。
      const guide = guidanceReasonForKind(outcome.kind)
      if (guide !== null) {
        state.screen = 'guide'
        state.guideReason = guide
        render()
        return
      }
      state.answerError = outcome.message
      render()
      return
    }
    if (connection === null) return
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
      case 'enter-machine': {
        const hostId = target.getAttribute('data-machine-id')
        if (hostId !== null) void enterMachine(hostId)
        break
      }
      case 'back-to-machines': backToMachines(); break
      case 'refresh-hosts': void (isHub ? loadMachines() : loadHosts()); break
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

  // 直连后端：每个方法都转交既有调用，行为与今天逐字一致。
  state.backend = deps.backend ?? createMachineBackend({
    listSessions: async () => {
      const outcome = await rpcCall(fetchLike, SESSION_LIST_ENDPOINT, { _request: {} }, `sessions-${++rpcSeq}`)
      return outcome.ok === true ? { items: outcome.result?.items ?? [] } : { error: outcome.message }
    },
    pageMessages: (sessionId, throughSeq, maxMessages) => rpcSessionPage(sessionId, throughSeq, maxMessages, 'page'),
    prompt: async (sessionId, text) => {
      const outcome = await rpcCall(fetchLike, SESSION_PROMPT_ENDPOINT, {
        request: {
          requestId: makeRequestId(rpcSeq),
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
          clientTimeZone: clientTimeZone(),
        },
      }, `prompt-${++rpcSeq}`)
      return outcome.ok === true ? { ok: true } : { ok: false, message: outcome.message }
    },
    cancel: async sessionId => {
      const outcome = await rpcCall(fetchLike, SESSION_CANCEL_ENDPOINT, { request: { sessionId } }, `cancel-${++rpcSeq}`)
      return outcome.ok === true ? { ok: true } : { ok: false, message: outcome.message }
    },
    answer: async (eventId, outcome) => {
      if (connection === null) return { ok: false, message: '事件通道还没连上' }
      return await connection.answer(eventId, outcome)
    },
    connectEvents: handlers => {
      openConnection(handlers)
      return {
        close() {
          if (connection !== null) connection.close()
          connection = null
        },
      }
    },
    listHosts: async () => {
      const response = await fetchLike(PEERS_PATH)
      if (response.status !== 200) return { peers: [], error: `主机清单请求失败：HTTP ${response.status}` }
      const body = JSON.parse(await response.text())
      return { peers: Array.isArray(body?.peers) ? body.peers : [], error: typeof body?.error === 'string' ? body.error : undefined }
    },
  })

  shell()
  await boot()
}

/**
 * 机器最后一次被联系上的时间，说成「多久之前」。中转在清单里给的是
 * `lastSeenAt`（epoch 毫秒）；在线的机器不需要这句话，所以只有断掉的才补。
 *
 * 导出是为了能被用例直接问：这个文案错了不影响功能，但会让「离线」看起来像
 * 「死了」或「没问题」，两种都误导人。
 */
export function lastSeenTextOf(host, now = Date.now()) {
  if (host === null || typeof host !== 'object') return undefined
  const online = host.online !== false && host.reachable !== false
  if (online) return undefined
  const at = host.lastSeenAt
  if (typeof at !== 'number' || !Number.isFinite(at)) return undefined
  const minutes = Math.floor((now - at) / 60000)
  if (minutes < 1) return '刚刚还有动静'
  if (minutes < 60) return `${minutes} 分钟前还有动静`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前还有动静`
  return `${Math.floor(hours / 24)} 天前还有动静`
}
