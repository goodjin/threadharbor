/**
 * 手机页视图纯函数：输入状态对象，输出 HTML 串。
 *
 * 无 DOM、无 IO、无 import——node 可直接加载（views.spec.ts 就在 node 环境
 * 跑），浏览器由 app.js 注入页面。所有用户可见文案集中在这一层，全部中文。
 * 约定：
 * - 任何插值先过 escapeHtml，标题/原因/机器名等来自宿主的数据不进 innerHTML 原文；
 * - 交互不写内联事件，只放 data-action / data-event-id / data-session-id 钩子，
 *   app.js 在根部做一次事件委托；
 * - stateFold 是对话状态的唯一归并口：durable 记录按 seq 去重升序，assistant
 *   流式帧按 (attemptId, index) 归位——同一帧重放两遍得到深度相等的状态
 *   （幂等），重连重放、整页补拉都因此安全。
 *
 * R2 裁决落点：pairingGuideView 只收 'unpaired' | 'untrusted' 两支。无效令牌
 * 在到访 shell 之前就被官方交换接管（401 页），手机侧探针只观察得到 401
 * （→ unpaired，重新扫码引导覆盖）与 403（→ untrusted），没有第三支。
 */

/** HTML 转义：&, <, >, ", ' 全量替换。 */
/** 机器显示名：有名用名，没名退回 hostId（手机上一眼看不出是哪台是最糟的）。 */
function machineLabel(name, hostId) {
  return typeof name === 'string' && name.length > 0 ? name : String(hostId ?? '')
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * rpcCall 的失败种类映射到引导分支。只有 unpaired/untrusted 两支有引导；
 * 其余（error、未知）返回 null，由调用方走错误屏而不是配对引导。
 */
export function guidanceReasonForKind(kind) {
  if (kind === 'unpaired') return 'unpaired'
  if (kind === 'untrusted') return 'untrusted'
  return null
}

/** 启动中的整屏文案。 */
export function renderLoading() {
  return '<p class="boot-loading">正在连接主机…</p>'
}

/** 启动失败（传输不通或 RPC error 类）的整屏：给原因、给重试。 */
export function renderErrorScreen(message) {
  return [
    '<section class="guide">',
    '<h1>连不上主机</h1>',
    `<p class="guide-detail">${escapeHtml(message)}</p>`,
    '<p>请检查手机与主机的 Tailscale 连接后重试。</p>',
    '<button type="button" data-action="retry-boot">重试</button>',
    '</section>',
  ].join('')
}

/**
 * 配对引导屏（两支，R2）：
 * - unpaired：没有本机凭据或凭据已失效——从桌面端的二维码入口重新扫码；
 * - untrusted：主机 403——域名不在 tailscale serve 的信任名单，查安装配置。
 */
export function pairingGuideView(reason, mode = 'machine') {
  // 中转模式下这两段文案必须换：凭据是对**中转站**的，不是对本机的，照直连那套
  // 一步步做下来会拿自己电脑上的二维码去扫——扫完手机配到那台机器上，页面变成
  // 直连模式，中转这条链路整个白走一遍，而且看上去「配对了」，最难查。
  if (mode === 'hub') {
    return [
      '<section class="guide">',
      reason === 'untrusted'
        ? '<h1>中转站还没信任你</h1>'
        : '<h1>还没跟中转站配对</h1>',
      '<p>这台手机页与<strong>中转站</strong>的凭据已经失效，'
        + (reason === 'untrusted'
          ? '或者中转站拒绝了这次访问（HTTP 403）。'
          : '或者从来没有建立过（HTTP 401）。')
        + '</p>',
      '<ol>',
      '<li>在<strong>中转站那个页面</strong>（形如 '
        + '<code>https://&lt;子域&gt;.&lt;主域&gt;/threadharbor/mobile/</code>）'
        + '上打开「手机配对」面板——在你自己电脑上的 ThreadHarbor 里打开同一个网址也行；</li>',
      '<li>出示二维码；</li>',
      '<li>用这台手机<strong>重新扫码</strong>打开本页。</li>',
      '</ol>',
      '<p class="guide-warn">别用你自己电脑上 ThreadHarbor 桌面端那个二维码：'
        + '那会把手机配到那台机器上，配完手机上打开的就不是中转页而是那台机器自己的直连页。</p>',
      '<button type="button" data-action="retry-boot">重新检测</button>',
      '</section>',
    ].join('')
  }
  return pairingGuideMachine(reason)
}

/** 直连模式的引导文案：中转分支抽走后剩下的原文，保持逐字不变。 */
function pairingGuideMachine(reason) {
  if (reason === 'untrusted') {
    return [
      '<section class="guide">',
      '<h1>这台主机还没信任你</h1>',
      '<p>主机拒绝了这次访问（HTTP 403）：当前域名不在它的信任名单里。</p>',
      '<p>请在主机上核对 <code>tailscale serve</code> 的 <code>--trusted-host</code> 配置（见安装文档），改好后回来重试。</p>',
      '<button type="button" data-action="retry-boot">重新检测</button>',
      '</section>',
    ].join('')
  }
  return [
    '<section class="guide">',
    '<h1>还没配对</h1>',
    '<p>这台页面没有本机 DSH 的访问凭据，或者凭据已经失效（HTTP 401）。</p>',
    '<ol>',
    '<li>在电脑上打开 ThreadHarbor 桌面端；</li>',
    '<li>点开「手机配对」面板，出示二维码；</li>',
    '<li>用手机<strong>重新扫码</strong>打开本页——首次配对、换手机、凭据过期都走这一步。</li>',
    '</ol>',
    '<button type="button" data-action="retry-boot">重新检测</button>',
    '</section>',
  ].join('')
}

/**
 * 主机清单屏。state：{ peers:[{dnsName,online,dsh}], error?, loading? }。
 * peers 只是展示（v1 每台机器各自伺服自己的页面，不跨域连接）；tailscale
 * 查询失败时 error 带原文，清单区提示不可用，其余功能不受影响。
 */
/**
 * 主机清单。两种模式共用这一个视图：
 * - 直连：`peers` 是本机 tailnet 里的发现结果（今天的行为，一字未改）；
 * - 中转：`machines` 是中转登记的机器清单，每行带 `hostId` 与机器名，
 *   离线的行点不动（没有会话可看）。
 *
 * `machineLabel` / `lastSeenText` 是可选的：缺省不渲染，保证直连模式的 DOM
 * 与改之前逐字相同。
 */
/**
 * 机器行上那半句「为什么进不去」。只认中转给的两条真实取值：
 * `reason === 'fingerprint-unapproved'` 是指纹没登记（要跑登记命令），
 * `credential !== 'ok'` 且原因是别的（换不到凭据，多半那台机器的 DSH 没起）。
 * 认不出的组合一律不渲染——宁可不说，也不要说错方向。
 */
function credentialHint(machine) {
  if (machine.credential === undefined || machine.credential === 'ok') return ''
  if (machine.reason === 'fingerprint-unapproved') {
    return '<span class="hint hint-warn">需先确认指纹</span>'
  }
  if (machine.reason === 'ssh-failed') {
    // ssh-failed 是**隧道没建起来**（ensure 直接失败了），跟凭据换没换到完全
    // 不是一层。写成「隧道通但凭据没换到」会把人引到完全相反的方向：他会去
    // 查凭据、反复重试，而真正要动的是 ssh 那条路（密钥、指纹、网络）。
    return '<span class="hint hint-warn">连不上那台机器，隧道没建起来</span>'
  }
  if (machine.reason === 'credential-missing') {
    return '<span class="hint hint-warn">隧道通但凭据没换到</span>'
  }
  return ''
}

export function renderHostList(state) {
  const { peers = [], machines, error, loading } = state ?? {}
  if (Array.isArray(machines)) {
    const parts = []
    if (error !== undefined) parts.push(`<p class="list-error">机器清单暂时拿不到：${escapeHtml(error)}</p>`)
    if (loading === true) parts.push('<p class="list-loading">正在获取机器清单…</p>')
    if (machines.length > 0) {
      parts.push('<ul class="host-list">')
      for (const machine of machines) {
        const online = machine.online !== false && machine.reachable !== false
        const mark = online
          ? '<span class="mark mark-online">在线</span>'
          : '<span class="mark mark-offline">离线</span>'
        const label = machineLabel(machine.name, machine.hostId)
        const hint = machine.lastSeenText === undefined ? '' : `<span class="hint">${escapeHtml(machine.lastSeenText)}</span>`
        // 中转已经算好了这台机器「登没登记指纹 / 凭据换没换到」，install 与手机
        // 文档也都写了这两种状态。以前这些字段传到了手机上却没人渲染，操作者只能
        // 点了进去看到一句「正在重连」——那句话对「指纹没登记」完全是误导：那要
        // 在中转上跑登记命令，不是等一会儿就好。
        const blocked = credentialHint(machine)
        const disabled = online ? '' : ' aria-disabled="true"'
        parts.push(
          `<li class="host"><span class="host-name">${escapeHtml(label)}</span>${mark}${hint}${blocked}`
          + `<button type="button" class="host-enter" data-action="enter-machine" data-machine-id="${escapeHtml(machine.hostId)}"${disabled}>进入</button></li>`,
        )
      }
      parts.push('</ul>')
    } else if (loading !== true && error === undefined) {
      parts.push('<p class="list-empty">中转站还没登记任何机器。</p>')
    }
    // 中转模式原来没有这个按钮（直连那支才有），于是两件事都做不到：拿不到
    // 清单时只能整个页面退出重来；一台机器刚恢复，得退出再进才知道。
    parts.push('<button type="button" class="ghost" data-action="refresh-hosts">刷新机器清单</button>')
    return parts.join('')
  }
  const parts = []
  if (error !== undefined) {
    parts.push(`<p class="list-error">本机 Tailscale 不可用：${escapeHtml(error)}</p>`)
  }
  if (loading === true) {
    parts.push('<p class="list-loading">正在获取主机清单…</p>')
  }
  if (peers.length > 0) {
    parts.push('<ul class="host-list">')
    for (const peer of peers) {
      const onlineMark = peer.online
        ? '<span class="mark mark-online">在线</span>'
        : '<span class="mark mark-offline">离线</span>'
      const dshMark = peer.dsh ? '<span class="badge">DSH</span>' : ''
      parts.push(
        `<li class="host"><span class="host-name">${escapeHtml(peer.dnsName)}</span>${onlineMark}${dshMark}</li>`,
      )
    }
    parts.push('</ul>')
  } else if (loading !== true && error === undefined) {
    parts.push('<p class="list-empty">没有在 tailnet 里发现其他机器。</p>')
  }
  parts.push('<button type="button" class="ghost" data-action="refresh-hosts">刷新主机清单</button>')
  return parts.join('')
}

/** 会话时间显示：本月的「MM-DD HH:mm」。拿不到就空串，不硬造。 */
function formatTime(timestamp) {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''
  const pad = value => String(value).padStart(2, '0')
  return `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 会话条目题头：投影标题优先，回退到 sessionId 原文。 */
function sessionTitle(item) {
  const title = item?.projections?.values?.title
  return typeof title === 'string' && title.length > 0 ? title : String(item?.sessionId ?? '')
}

/**
 * 会话列表屏。state：{ items:[SessionSummary], hasMore }。
 * hasMore 为真时渲染「加载更早」（app.js 做客户端分页，每次多亮一批）。
 */
/**
 * 会话列表。`machineLabel` 缺省不渲染——直连模式下不显示机器名（今天没有这个
 * 概念，显示一个空标签只会在每行后面多出一段空白）。
 */
export function renderSessionList(state) {
  const { items = [], hasMore = false, machineLabel = null, error = undefined } = state ?? {}
  const parts = []
  if (typeof error === 'string' && error.length > 0) {
    // 故障**先说**：列表空了是「这台机器还没有会话」，说错话比空着更像一切正常。
    // 排障提示放在这里，不在列表里堆技术细节（那句「找运维看日志」在别处）。
    // class 与空列表那句共用一条样式（app.css 里已并在一起）：两者都是「列表
    // 里没有条目」这一类，不为一句话单开一套配色。
    parts.push(`<p class="conv-error" role="alert">${escapeHtml(error)}</p>`)
  }
  if (items.length === 0) {
    // 已经说过故障了，就别再说「还没有会话」——两句互相矛盾。
    if (!(typeof error === 'string' && error.length > 0)) {
      parts.push('<p class="list-empty">还没有会话。可以在桌面端新建一个。</p>')
    }
  } else {
    parts.push('<ul class="session-list">')
    for (const item of items) {
      const runningMark = item.running ? '<span class="badge badge-running">运行中</span>' : ''
      const machine = typeof machineLabel === 'string' && machineLabel.length > 0
        ? `<span class="badge badge-machine">${escapeHtml(machineLabel)}</span>`
        : ''
      parts.push(
        '<li>'
        + `<button type="button" class="session-item" data-action="open-session" data-session-id="${escapeHtml(item.sessionId)}">`
        + machine
        + `<span class="session-title">${escapeHtml(sessionTitle(item))}</span>`
        + `<span class="session-meta">${runningMark}<time>${formatTime(item.updatedAt)}</time></span>`
        + '</button>'
        + '</li>',
      )
    }
    parts.push('</ul>')
  }
  if (hasMore) {
    parts.push('<button type="button" class="ghost" data-action="load-more-sessions">加载更早</button>')
  }
  return parts.join('')
}

/** content 块数组里的文本：只认 {type:'text',text} 一方的字段，其余不猜。 */
function textOfBlocks(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/** 一条 durable 记录 → 气泡或弱化标记；认不出的类型返回空串（协议层不猜）。 */
function renderRecord(record) {
  const event = record?.event
  if (event === null || typeof event !== 'object') return ''
  if (event.type === 'user/message') {
    return bubble('user', textOfBlocks(event.data?.content))
  }
  if (event.type === 'assistant/message') {
    return bubble('assistant', textOfBlocks(event.data?.message?.content))
  }
  if (event.type === 'agent/inbox/spliced' && Array.isArray(event.data?.inserted)) {
    // 排队后拼接进收件箱的用户消息：source.kind==='user' 的按用户气泡渲染。
    return event.data.inserted
      .filter(item => item !== null && typeof item === 'object' && item.source?.kind === 'user')
      .map(item => bubble('user', textOfBlocks(item.content)))
      .join('')
  }
  if (typeof event.type === 'string' && event.type.startsWith('tool/')) {
    return `<div class="evt-marker">⚙ ${escapeHtml(event.type)}</div>`
  }
  return ''
}

function bubble(role, text) {
  if (text.length === 0) return ''
  return `<div class="msg msg-${role}" data-role="${role}">${escapeHtml(text)}</div>`
}

/** 在流的 assistant 块：chunk 内形探针未钉死，v1 只给「正在输入」不硬猜内容。 */
function renderStream() {
  return '<div class="msg msg-assistant msg-streaming" data-role="assistant">正在输入…</div>'
}

/**
 * 对话屏。state：{ session:{sessionId,title?,running?}, conv, hasMore, loading?, error? }。
 * conv 是 stateFold 的状态（records / streams），可为 null（还没拉到首版）。
 */
export function renderConversation(state) {
  const { session, conv, hasMore = false, loading = false, error } = state ?? {}
  const records = conv?.records ?? []
  const streams = conv?.streams ?? []
  const title = typeof session?.title === 'string' && session.title.length > 0
    ? session.title
    : String(session?.sessionId ?? '')
  const parts = []
  parts.push(
    '<header class="conv-header">'
    + '<button type="button" class="ghost" data-action="back">返回</button>'
    + `<span class="conv-title">${escapeHtml(title)}</span>`
    + (session?.running === true ? '<button type="button" class="danger" data-action="stop">停止</button>' : '')
    + '</header>',
  )
  if (error !== undefined) {
    parts.push(`<p class="conv-error">${escapeHtml(error)}</p>`)
  }
  if (loading === true) {
    parts.push('<p class="conv-loading">正在加载会话…</p>')
  }
  if (hasMore) {
    parts.push('<button type="button" class="ghost" data-action="load-older">加载更早</button>')
  }
  parts.push('<div class="msg-list">')
  for (const record of records) {
    parts.push(renderRecord(record))
  }
  for (let index = 0; index < streams.length; index++) {
    parts.push(renderStream())
  }
  if (records.length === 0 && streams.length === 0 && loading !== true) {
    parts.push('<p class="list-empty">还没有消息。</p>')
  }
  parts.push('</div>')
  parts.push(
    '<form id="prompt-form" class="prompt-bar">'
    + '<input id="prompt-input" name="prompt" type="text" autocomplete="off" placeholder="发消息…">'
    + '<button type="submit">发送</button>'
    + '</form>',
  )
  return parts.join('')
}

/**
 * 待批权限横幅（可多张叠放）。每项 {eventId, toolName, displayReason?, reason?,
 * pending?}。pending 为真时该横幅的批准/拒绝禁用——应答在途，UI 不邀双击
 * （首答生效语义在宿主侧兜底，但按钮不该看起来还能按）。
 * 动作钩子只放在按钮上（data-action + data-event-id），app.js 委托后经
 * MuxConnection.answer 应答。
 */
export function renderApprovalBanners(items) {
  return (items ?? []).map(item => {
    const eventId = escapeHtml(item.eventId)
    const reason = typeof item.displayReason === 'string' && item.displayReason.length > 0
      ? item.displayReason
      : typeof item.reason === 'string' && item.reason.length > 0
        ? item.reason
        : '请求执行工具'
    const disabled = item.pending === true ? ' disabled' : ''
    // 机器名只在有值时渲染：中转模式下两台机器可能同时有待批事项，不标明来源
    //就只能靠猜。直连模式没有这个字段，DOM 与改之前逐字相同。
    const from = typeof item.machineLabel === 'string' && item.machineLabel.length > 0
      ? `<p class="approval-machine">来自 ${escapeHtml(item.machineLabel)}</p>`
      : ''
    return [
      '<div class="approval">',
      from,
      `<p class="approval-title">待批准：工具 ${escapeHtml(item.toolName)}</p>`,
      `<p class="approval-reason">${escapeHtml(reason)}</p>`,
      '<div class="approval-actions">'
      + `<button type="button"${disabled} data-action="approve" data-event-id="${eventId}">批准</button>`
      + `<button type="button"${disabled} data-action="reject" data-event-id="${eventId}">拒绝</button>`
      + '</div>',
      '</div>',
    ].join('')
  }).join('')
}

/**
 * 事件归并（纯函数，不改写入参）：返回新状态
 * `{ records, streams, hasMore }`。
 * - {kind:'append', records}：durable 记录按 seq 去重后并入并保持升序；
 * - {kind:'prepend', records, hasMore}：更早一页，归并同上，hasMore 以本页为准；
 * - {kind:'assistant-stream', frame}：start 起块 / chunk 按 index 归位（整帧
 *   存储，重放同帧深度相等）/ end 收块（durable 版本由 append 到达）。
 * 未知 kind 原样返回拷贝（协议层不猜）。
 */
export function stateFold(prev, change) {
  const state = prev === null || prev === undefined
    ? { records: [], streams: [], hasMore: false }
    : {
        records: prev.records.slice(),
        streams: prev.streams.map(stream => ({ ...stream, blocks: stream.blocks.slice() })),
        hasMore: prev.hasMore === true,
      }
  if (change === null || typeof change !== 'object') {
    return state
  }
  if (change.kind === 'append' || change.kind === 'prepend') {
    const known = new Set(state.records.map(record => record?.event?.seq))
    const fresh = []
    for (const record of change.records ?? []) {
      const seq = record?.event?.seq
      if (typeof seq !== 'number' || known.has(seq)) continue
      known.add(seq)
      fresh.push(record)
    }
    if (fresh.length > 0) state.records.push(...fresh)
    state.records.sort((a, b) => (a?.event?.seq ?? 0) - (b?.event?.seq ?? 0))
    if (change.kind === 'prepend') {
      state.hasMore = change.hasMore === true
    }
    return state
  }
  if (change.kind === 'assistant-stream') {
    const frame = change.frame
    if (frame === null || typeof frame !== 'object' || typeof frame.attemptId !== 'string') {
      return state
    }
    const index = state.streams.findIndex(stream => stream.attemptId === frame.attemptId)
    if (frame.type === 'end') {
      if (index >= 0) state.streams.splice(index, 1)
      return state
    }
    if (frame.type === 'start') {
      if (index >= 0) {
        // 同 attemptId 重开（重放）：不清已收的块，只抬 revision。
        const stream = state.streams[index]
        stream.revision = Math.max(stream.revision, frame.revision ?? 0)
      } else {
        state.streams.push({ attemptId: frame.attemptId, revision: frame.revision ?? 0, blocks: [] })
      }
      return state
    }
    if (frame.type === 'chunk') {
      let stream = state.streams[index]
      if (stream === undefined) {
        stream = { attemptId: frame.attemptId, revision: frame.revision ?? 0, blocks: [] }
        state.streams.push(stream)
      }
      if (Number.isSafeInteger(frame.index) && frame.index >= 0) {
        stream.blocks[frame.index] = frame
      }
      stream.revision = Math.max(stream.revision, frame.revision ?? 0)
      return state
    }
    return state
  }
  return state
}
