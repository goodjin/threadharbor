/**
 * 中转后端：手机连中转站，由它转发到各台机器。
 *
 * 与直连后端同形，所以 app.js 不知道自己在连谁。差别全在这一层：
 * - 每个请求都带 hostId（路径里），应答带上 hostId 后路由到发起它的那台；
 * - 事件流是一条汇流，每帧都带 hostId，据此更新对应机器的状态；
 * - 上游失败是中转压过的固定文案（`machine-error` / `credential-stale`），
 *   这里原样交给上层，不自己猜原因——中转已经比手机更知道上游出了什么事。
 */

const RELAY_ROOT = '/threadharbor/relay'
const EVENTS_PATH = `${RELAY_ROOT}/events`
const ANSWER_PATH = `${RELAY_ROOT}/answer`

/**
 * @param {{ fetchLike?: typeof fetch, WebSocketCtor?: any, relayRoot?: string }} [opts]
 */
export function createHubBackend(opts = {}) {
  const fetchLike = opts.fetchLike ?? ((...args) => globalThis.fetch(...args))
  const WebSocketCtor = opts.WebSocketCtor ?? globalThis.WebSocket
  const root = opts.relayRoot ?? RELAY_ROOT

  /**
   * 把 relay/postJson 的应答收成 prompt/cancel 用的 {ok,message}。
   *
   * 收口在这里，而不是散在每个方法里各判一遍：`ok:false` 被漏判时表现是**假报
   * 成功**——界面清掉草稿、以为发出去了，其实那台机器一个字也没收到，而手机上
   * 没有任何迹象能让人起疑。
   */
  const outcomeOf = body => {
    if (body?.ok === false) return { ok: false, kind: body.kind, message: body.message ?? '这次请求没有送到那台机器' }
    if (typeof body?.error === 'string') return { ok: false, message: reasonText(body.error) }
    return { ok: true }
  }

  /**
   * 中转的错误代号 → 操作者看得懂的一句话。
   *
   * 以前是把代号原样显示，于是机器没接住时手机上写的是「machine-error」——
   * 那不是给看的人写的。细节（中转不把上游原文与 SSH 报错透给手机）都在
   * relay.log 里，所以这里只说「出了什么事、下一步找谁」，不猜具体原因。
   *
   * 认不出的代号照原样显示、只是加上「不认识的错误码」几个字：把它藏起来
   * 等于把一个真问题变成「什么都没发生」。
   */
  const reasonText = slug => {
    const known = {
      'machine-error': '那台机器没接住这次请求，看它上面 DSH 的状态',
      'not-found': '中转上没有这台机器的登记',
      'bad-request': '中转没认这次请求，请核对入口域名',
      'credential-stale': '那台机器正在重新连接，稍后再试',
    }
    if (typeof known[slug] === 'string') return known[slug]
    return `中转回了一个不认识的错误码：${slug}`
  }

  const hostOf = hostId => encodeURIComponent(hostId)
  const sessionsPath = hostId => `${root}/hosts/${hostOf(hostId)}/sessions`

  /** 一次转发的共同外壳：形状对齐直连后端（ok/value 或 error）。 */
  async function relay(path, init) {
    const response = await fetchLike(path, init)
    if (response.status === 401 || response.status === 403) {
      // 手机**自己**与中转站的连接过期了：只有重新配对能救。kind 用 'unpaired'，
      // 与直连同一支（views.js 的 guidanceReasonForKind 只认这三个词），否则
      // 配对引导那条路根本走不到。
      return { ok: false, kind: 'unpaired', message: '与中转站的连接已过期，需要重新配对' }
    }
    if (response.status !== 200) {
      return { error: `中转站请求失败：HTTP ${response.status}` }
    }
    const body = JSON.parse(await response.text())
    if (body && body.error === 'credential-stale') {
      // 中转说**那台机器**的凭据脏了——重配手机没有用，中转自己会换掉再重试。
      // 所以这句话不能说「需要重新配对」：照着做的人会白白重来一遍。
      return { ok: false, kind: 'error', message: '那台机器正在重新连接，稍后再试' }
    }
    // 游标这一条要把那个**整数**带出来（其它错误只留文案）。少了这一步，
    // pageMessages 拿到的就只剩 'session-cursor' 三个字，探测无从还原。
    if (body && body.error === 'session-cursor' && Number.isSafeInteger(body.cursor)) {
      return { error: 'session-cursor', cursor: body.cursor }
    }
    if (body && typeof body.error === 'string') return { error: body.error }
    return body
  }

  const postJson = (path, payload) => relay(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })

  return {
    mode: 'hub',

    async listHosts() {
      const response = await fetchLike(`${root}/hosts`)
      if (response.status === 401 || response.status === 403) {
        return { hosts: [], error: '中转站拒绝了这次请求' }
      }
      if (response.status !== 200) return { hosts: [], error: `机器清单请求失败：HTTP ${response.status}` }
      const body = JSON.parse(await response.text())
      return { hosts: Array.isArray(body?.hosts) ? body.hosts : [], error: typeof body?.error === 'string' ? body.error : undefined }
    },

    async listSessions(hostId) {
      const body = await relay(sessionsPath(hostId))
      // 凭据过期**不能**折成空清单：空清单在界面上长得就是「这台机器还没有
      // 会话」，操作者不会想到是凭据出了问题。
      // kind 一起带出去：手机要靠它分「重配对」与「那台机器正在重连」——这两件事
      // 要做的动作完全不同，混成一句「重新配对」会让人白白重来一遍。
      if (body?.ok === false) return { error: body.message ?? '这次请求没有送到那台机器', kind: body.kind }
      if (body.error !== undefined) return { error: reasonText(body.error) }
      return { items: Array.isArray(body?.value?.items) ? body.value.items : [] }
    },

    async pageMessages(hostId, sessionId, throughSeq, maxMessages) {
      const path = `${sessionsPath(hostId)}/${encodeURIComponent(sessionId)}/messages`
      const query = []
      if (typeof throughSeq === 'number') query.push(`throughSeq=${throughSeq}`)
      if (typeof maxMessages === 'number') query.push(`maxMessages=${maxMessages}`)
      const body = await relay(query.length > 0 ? `${path}?${query.join('&')}` : path)
      // 中转只把「日志末端」那个**整数**放出来，不放上游原文。这里把整数还原成
      // 直连模式同一句游标错误，让应用层那套探测逻辑在两种后端上完全一致——
      // 直连是从上游原文里解析的，这里从中转的结构化字段还原。
      if (body?.error === 'session-cursor' && Number.isSafeInteger(body.cursor)) {
        return { error: `session page request past cursor ${body.cursor}` }
      }
      if (body?.ok === false) return { error: body.message ?? '这次请求没有送到那台机器', kind: body.kind }
      if (body.error !== undefined) return { error: reasonText(body.error) }
      return { conv: body?.value }
    },

    async prompt(hostId, sessionId, text) {
      const body = await postJson(`${sessionsPath(hostId)}/${encodeURIComponent(sessionId)}/prompt`, {
        text,
        requestId: `hub-${Date.now().toString(36)}`,
      })
      return outcomeOf(body)
    },

    async cancel(hostId, sessionId) {
      const body = await postJson(`${sessionsPath(hostId)}/${encodeURIComponent(sessionId)}/cancel`, {})
      return outcomeOf(body)
    },

    async answer(hostId, eventId, outcome) {
      const body = await postJson(ANSWER_PATH, { hostId, eventId, outcome })
      if (body?.ok === true) return { ok: true }
      // kind 一并带出去：手机要靠它分「重配对」与「那台机器在重连」。
      const kind = typeof body?.kind === 'string' ? body.kind : undefined
      const message = body?.error ?? body?.message ?? '应答没有送到那台机器'
      return kind === undefined ? { ok: false, message } : { ok: false, kind, message }
    },

    /**
     * 事件流。每帧 `{type:'item', hostId, value}`；`ready` 只表示汇流已就绪。
     * 断线按 1s/2s/5s/10s 退避重连（与直连同一阶梯，注释互认）。
     */
    connectEvents(handlers) {
      let socket = null
      let closed = false
      let attempts = 0
      let timer = null
      const STEPS = [1000, 2000, 5000]
      const CAP = 10000

      const open = () => {
        if (closed) return
        handlers.onStatus?.('connecting', '')
        // 按页面协议选 ws/wss：中转的入口是 HTTPS，写死 ws:// 会被浏览器的
        // 混合内容策略当场拦掉（Chrome 还在构造期同步抛 SecurityError），事件
        // 通道就永远连不上。与直连分支 app.js 的取法同款。
        const protocol = globalThis.location?.protocol === 'https:' ? 'wss:' : 'ws:'
        const host = globalThis.location?.host ?? ''
        try {
          socket = new WebSocketCtor(`${protocol}//${host}${EVENTS_PATH}`)
        } catch (error) {
          // 构造期抛错（混合内容、URL 非法）也要落到「连不上」而不是把异常
          // 顺着 boot() 一路炸出去——直连分支有 makeSocketFactory 专管这一档。
          socket = null
          handlers.onStatus?.('offline', error instanceof Error ? error.message : String(error))
          return
        }
        socket.onopen = () => {
          attempts = 0
          handlers.onStatus?.('online', '')
        }
        socket.onmessage = event => {
          let frame
          try {
            frame = JSON.parse(typeof event.data === 'string' ? event.data : '')
          } catch {
            return
          }
          if (frame?.type === 'item' && typeof frame.hostId === 'string') {
            const value = frame.value
            // ready 是**连接级**的（那台机器的事件流已就绪），不是业务事件：
            // 手机的状态由 onStatus 报，混进 onEvent 只会让界面多一条看不懂的分支。
            if (value?.type === 'ready') return
            handlers.onEvent(frame.hostId, value?.type ?? 'item', value)
          }
        }
        socket.onclose = () => {
          socket = null
          if (closed) return
          const wait = STEPS[Math.min(attempts, STEPS.length - 1)] ?? CAP
          attempts += 1
          handlers.onStatus?.('offline', attempts >= STEPS.length ? '自动重试' : '自动重试')
          timer = setTimeout(open, wait)
        }
        socket.onerror = () => socket?.close()
      }
      open()
      return {
        close() {
          closed = true
          if (timer !== null) clearTimeout(timer)
          timer = null
          socket?.close()
          socket = null
        },
      }
    },
  }
}

export { EVENTS_PATH, ANSWER_PATH, RELAY_ROOT }
