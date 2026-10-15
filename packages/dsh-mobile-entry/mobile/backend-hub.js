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

  const hostOf = hostId => encodeURIComponent(hostId)
  const sessionsPath = hostId => `${root}/hosts/${hostOf(hostId)}/sessions`

  /** 一次转发的共同外壳：形状对齐直连后端（ok/value 或 error）。 */
  async function relay(path, init) {
    const response = await fetchLike(path, init)
    if (response.status === 401 || response.status === 403) {
      return { ok: false, kind: 'unauthorized', message: '中转站拒绝了这次请求' }
    }
    if (response.status !== 200) {
      return { error: `中转站请求失败：HTTP ${response.status}` }
    }
    const body = JSON.parse(await response.text())
    if (body && body.error === 'credential-stale') {
      // 中转说那台机器的凭据该换了：按「需要重新配对」处置，与直连的 401 同路。
      return { ok: false, kind: 'unauthorized', message: '那台机器的凭据已过期，需要重新配对' }
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
      if (body.error !== undefined) return body
      return { items: Array.isArray(body?.value?.items) ? body.value.items : [] }
    },

    async pageMessages(hostId, sessionId, throughSeq, maxMessages) {
      const path = `${sessionsPath(hostId)}/${encodeURIComponent(sessionId)}/messages`
      const query = []
      if (typeof throughSeq === 'number') query.push(`throughSeq=${throughSeq}`)
      if (typeof maxMessages === 'number') query.push(`maxMessages=${maxMessages}`)
      const body = await relay(query.length > 0 ? `${path}?${query.join('&')}` : path)
      if (body.error !== undefined) return body
      return { conv: body?.value }
    },

    async prompt(hostId, sessionId, text) {
      const body = await postJson(`${sessionsPath(hostId)}/${encodeURIComponent(sessionId)}/prompt`, {
        text,
        requestId: `hub-${Date.now().toString(36)}`,
      })
      return body.error !== undefined ? { ok: false, message: body.error } : { ok: true }
    },

    async cancel(hostId, sessionId) {
      const body = await postJson(`${sessionsPath(hostId)}/${encodeURIComponent(sessionId)}/cancel`, {})
      return body.error !== undefined ? { ok: false, message: body.error } : { ok: true }
    },

    async answer(hostId, eventId, outcome) {
      const body = await postJson(ANSWER_PATH, { hostId, eventId, outcome })
      if (body?.ok === true) return { ok: true }
      return { ok: false, message: body?.error ?? body?.message ?? '应答没有送到那台机器' }
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
