#!/usr/bin/env node
/**
 * 手机入口中转方案 · 阶段 0 真机探针（Task 1）。
 *
 * 在「云主机视角」实测中转方案的承重链路：SSH 本地转发 → 读远端启动日志取
 * 令牌 → 经隧道换 cookie → 带 cookie 调 RPC → 带 Cookie 头升级 WS 订阅
 * $events → tailscale 对端发现。每条结论一行 JSON，供证据文档逐条引用。
 *
 * 用法：
 *   node scripts/probe-relay-wire.mjs --machine <ssh目标> --port <远端DSH端口>
 *                                     [--remote-log <远端日志路径>]
 *                                     [--ws-from <含 ws 包的目录>]
 *                                     [--self-test]
 *
 * --machine   SSH 目标（~/.ssh/config 的别名或 user@host）。
 * --port      远端机器上 DSH 监听的回环端口。
 * --remote-log 远端 DSH 启动日志绝对路径；缺省依次尝试生产部署的候选路径。
 * --ws-from   额外的 ws 包解析目录（缺省从本机 DSH 安装解析）。
 * --self-test 只跑离线自测（夹具断言），不碰网络与 SSH。
 *
 * 安全纪律：任何输出不得包含 cookie 值、启动令牌原文；只允许出现
 * 「是否取到、长度、名字、属性名」。脚本对令牌/cookie 值做金丝雀扫描自证。
 */

import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'

// Node 24 的 fetch 在 NODE_USE_ENV_PROXY=1 时会吃代理环境变量，把指向
// 127.0.0.1 与 *.ts.net 的请求劫持到本地代理上（已知的 TLS 失败陷阱）。
// 探针只访问回环与 tailnet，启动即剥离全部代理变量，自证清白。
for (const key of Object.keys(process.env)) {
  if (/proxy/i.test(key)) delete process.env[key]
}

// ---------------------------------------------------------------------------
// 纯逻辑（可离线自测）
// ---------------------------------------------------------------------------

/** 构造 SSH 本地转发参数（与 DshSshManager.ensureTunnel 同形态）。 */
export function buildSshTunnelArgs({ machine, localPort, remotePort }) {
  return [
    '-N',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    machine,
  ]
}

/** 构造远端读日志命令：只输出目标标记行，取最后一行（生产 readLaunchUrl 语义）。 */
export function remoteLogReadCommand(candidates, marker) {
  const pattern = marker === 'LAUNCH_URL' ? '^LAUNCH_URL=' : '^dsh web: '
  const list = candidates.map((candidate) => `'${candidate}'`).join(' ')
  return `for f in ${list}; do if [ -f "$f" ]; then grep -h '${pattern}' "$f"; fi; done | tail -1`
}

/** 解析单行标记：LAUNCH_URL= 行取等号后的值；dsh web: 行剥前缀取网址。 */
export function parseLaunchMarkerLine(line, marker) {
  const prefix = marker === 'LAUNCH_URL' ? 'LAUNCH_URL=' : 'dsh web: '
  if (!line.startsWith(prefix)) return undefined
  const value = line.slice(prefix.length).trim()
  return value === '' ? undefined : value
}

/** 多行里取最后一个非空标记值；没有则 undefined（取不到不是致命事）。 */
export function pickLastMarker(stdout, marker) {
  let last
  for (const line of stdout.split(/\r?\n/)) {
    const value = parseLaunchMarkerLine(line, marker)
    if (value !== undefined) last = value
  }
  return last
}

/** 从启动网址提取令牌；无 token 参数返回 undefined。 */
export function extractToken(launchUrl) {
  try {
    return new URL(launchUrl).searchParams.get('token') ?? undefined
  } catch {
    return undefined
  }
}

/**
 * cookie 报告：每条 Set-Cookie 输出名字、值长度与属性（含过期属性），
 * 绝不含 cookie 值本身。
 */
export function cookieReport(setCookieHeaders) {
  return setCookieHeaders.map((header) => {
    const [pair, ...attributeSegments] = header.split(';').map((segment) => segment.trim())
    const eq = pair.indexOf('=')
    const name = eq === -1 ? pair : pair.slice(0, eq)
    const value = eq === -1 ? '' : pair.slice(eq + 1)
    const attributes = {}
    for (const segment of attributeSegments) {
      const atEq = segment.indexOf('=')
      const attributeName = (atEq === -1 ? segment : segment.slice(0, atEq)).toLowerCase()
      const attributeValue = atEq === -1 ? true : segment.slice(atEq + 1)
      if (attributeName === 'max-age') attributes.maxAge = Number(attributeValue)
      else if (attributeName === 'expires') attributes.expires = attributeValue
      else if (attributeName === 'samesite') attributes.sameSite = attributeValue
      else if (attributeName === 'path') attributes.path = attributeValue
      else if (attributeName === 'httponly') attributes.httpOnly = true
      else if (attributeName === 'secure') attributes.secure = true
    }
    return { name, valueLength: value.length, attributes }
  })
}

/** 会话列表 RPC 信封：与浏览器 carrier 逐字段一致（Task 1 brief 指定形态）。 */
export function sessionListEnvelope(rpcId) {
  return { type: 'client-request', rpcId, method: 'session/list', payload: { args: {} } }
}

/** mux open 帧：订阅 $events，payload 恰为 {args:{}}。 */
export function muxOpenFrame(streamId) {
  return { type: 'open', streamId, endpoint: '$events', payload: { args: {} } }
}

/**
 * 泄密扫描：报告对象序列化后不得含任何机密原文。返回泄漏的机密列表（空 = 干净）。
 */
export function leakedSecrets(emitted, secrets) {
  const serialized = JSON.stringify(emitted)
  return secrets.filter((secret) => secret !== '' && serialized.includes(secret))
}

/** 解析 ws 包：import 失败则从 --ws-from 或本机 DSH 安装目录解析。 */
export async function resolveWs(wsFrom) {
  const attempts = []
  try {
    const mod = await import('ws')
    return { WebSocket: mod.WebSocket ?? mod.default, from: "import('ws')" }
  } catch (error) {
    attempts.push(`import('ws') → ${error.code ?? error.message}`)
  }
  const candidates = []
  if (wsFrom !== undefined) candidates.push(wsFrom)
  try {
    // /usr/local/bin/node 这类软链要还原成真实路径，才能拿到全局 node_modules 前缀。
    const prefix = path.dirname(path.dirname(realpathSync(process.execPath)))
    candidates.push(path.join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh'))
    candidates.push(path.join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'))
  } catch {
    // execPath 不可解析时跳过该候选
  }
  for (const candidate of candidates) {
    try {
      const require = createRequire(path.join(candidate, 'index.js'))
      const mod = require('ws')
      return { WebSocket: mod.WebSocket ?? mod.default ?? mod, from: candidate }
    } catch (error) {
      attempts.push(`${candidate} → ${error.code ?? error.message}`)
    }
  }
  throw new Error(`无法解析 ws 包；请用 --ws-from 指向含 ws 的目录（或先安装 DSH）。尝试过：${attempts.join('；')}`)
}

// ---------------------------------------------------------------------------
// 自测（离线，夹具驱动；先红后绿的「测试」部分）
// ---------------------------------------------------------------------------

const CANARY_TOKEN = 'CANARY-LAUNCH-TOKEN-0123456789abcdef'
const CANARY_COOKIE = 'CANARY_COOKIE_VALUE_DO_NOT_LEAK'

function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${label}: 期望 ${b}，实际 ${a}`)
}

function assertTrue(condition, label) {
  if (condition !== true) throw new Error(`${label}: 条件不成立`)
}

function selfTests() {
  return [
    ['SSH 隧道参数含 ExitOnForwardFailure 与回环映射', () => {
      const args = buildSshTunnelArgs({ machine: 'tencent01-root', localPort: 41235, remotePort: 3080 })
      assertTrue(args.includes('-N'), '应有 -N（只转发不开 shell）')
      assertTrue(args.includes('-o') && args.includes('ExitOnForwardFailure=yes'), '应有 ExitOnForwardFailure=yes')
      assertTrue(args.includes('-L') && args.includes('127.0.0.1:41235:127.0.0.1:3080'), '应有回环到回环的 -L 转发')
      assertTrue(args.includes('tencent01-root'), '应带目标机')
    }],
    ['日志读取命令按标记 grep 且取最后一行', () => {
      const cmd = remoteLogReadCommand(['/root/x/dsh-web.log'], 'LAUNCH_URL')
      assertTrue(cmd.includes("grep -h '^LAUNCH_URL='"), '应 grep LAUNCH_URL 标记')
      assertTrue(cmd.includes('tail -1'), '应取最后一行')
      const cmd2 = remoteLogReadCommand(['/Users/good/.dsh/web.log'], 'dsh-web')
      assertTrue(cmd2.includes("grep -h '^dsh web: '"), '应 grep dsh web: 行')
    }],
    ['标记解析：两行取最后一行', () => {
      const stdout = 'LAUNCH_URL=http://a/?token=first\nLAUNCH_URL=http://b/?token=second\n'
      assertEqual(pickLastMarker(stdout, 'LAUNCH_URL'), 'http://b/?token=second', '应取最后一行')
    }],
    ['标记解析：无标记与空输入得 undefined', () => {
      assertEqual(pickLastMarker('ALREADY_RUNNING=1\n', 'LAUNCH_URL'), undefined, '只有其他行应为 undefined')
      assertEqual(pickLastMarker('', 'LAUNCH_URL'), undefined, '空输入应为 undefined')
    }],
    ['dsh web: 行剥前缀取网址', () => {
      assertEqual(
        parseLaunchMarkerLine('dsh web: http://127.0.0.1:3081/?token=abc', 'dsh-web'),
        'http://127.0.0.1:3081/?token=abc',
        '应剥掉 dsh web: 前缀',
      )
    }],
    ['LAUNCH_URL= 行取等号后的值', () => {
      assertEqual(
        parseLaunchMarkerLine(`LAUNCH_URL=http://127.0.0.1:3080/?token=${CANARY_TOKEN}`, 'LAUNCH_URL'),
        `http://127.0.0.1:3080/?token=${CANARY_TOKEN}`,
        '应取等号后整段',
      )
      assertEqual(parseLaunchMarkerLine('LAUNCH_URL=', 'LAUNCH_URL'), undefined, '空值应为 undefined')
    }],
    ['令牌提取：有则取、无则 undefined', () => {
      assertEqual(extractToken(`http://127.0.0.1:3080/?token=${CANARY_TOKEN}`), CANARY_TOKEN, '应取出 token')
      assertEqual(extractToken('http://127.0.0.1:3080/'), undefined, '无 token 应为 undefined')
    }],
    ['cookie 报告：名字、值长度与过期属性，绝不含值', () => {
      const header = `dsh_session=${CANARY_COOKIE}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax`
      const report = cookieReport([header])
      assertEqual(report.length, 1, '应有一条')
      assertEqual(report[0].name, 'dsh_session', '应取 cookie 名')
      assertEqual(report[0].valueLength, CANARY_COOKIE.length, '应只给值长度')
      assertEqual(report[0].attributes.maxAge, 2592000, '应给 Max-Age')
      assertEqual(report[0].attributes.httpOnly, true, '应给 HttpOnly')
      assertEqual(report[0].attributes.sameSite, 'Lax', '应给 SameSite')
      const leaks = leakedSecrets([report], [CANARY_COOKIE, CANARY_TOKEN])
      assertEqual(leaks, [], '报告不得泄漏 cookie 值')
    }],
    ['会话列表信封逐字段一致', () => {
      assertEqual(sessionListEnvelope('p1'), {
        type: 'client-request', rpcId: 'p1', method: 'session/list', payload: { args: {} },
      }, '信封形态应为 brief 指定形态')
    }],
    ['mux open 帧 payload 恰为 {args:{}}', () => {
      const frame = muxOpenFrame('stream-1')
      assertEqual(frame, { type: 'open', streamId: 'stream-1', endpoint: '$events', payload: { args: {} } }, 'open 帧形态')
      assertEqual(Object.keys(frame.payload), ['args'], 'payload 键集合恰为 args')
    }],
    ['泄密扫描能抓到泄漏', () => {
      const leaks = leakedSecrets([{ note: `token=${CANARY_TOKEN}` }], [CANARY_TOKEN])
      assertEqual(leaks, [CANARY_TOKEN], '应报出泄漏的机密')
    }],
    ['全链路输出金丝雀扫描（令牌与 cookie 均不外泄）', () => {
      const url = `http://127.0.0.1:3080/?token=${CANARY_TOKEN}`
      const emitted = [
        { tag: 'launchUrl', tokenLength: CANARY_TOKEN.length, got: true },
        { tag: 'auth.exchange', cookies: cookieReport([`dsh_session=${CANARY_COOKIE}; Path=/`]) },
        { tag: 'rpc', envelope: sessionListEnvelope('p1') },
        { tag: 'mux', frame: muxOpenFrame('s') },
      ]
      // 模拟实现层可能的疏漏：把原文混进输出时应被扫出；正常报告必须干净。
      assertEqual(leakedSecrets(emitted, [CANARY_TOKEN, CANARY_COOKIE]), [], '正常报告必须干净')
      assertTrue(leakedSecrets([{ raw: url }], [CANARY_TOKEN]).length === 1, '混入原文必须被抓到')
    }],
  ]
}

function runSelfTests() {
  const failures = []
  for (const [name, fn] of selfTests()) {
    try {
      fn()
      console.log(`PASS ${name}`)
    } catch (error) {
      failures.push({ name, message: error.message })
      console.log(`FAIL ${name}\n     ${error.message}`)
    }
  }
  console.log(failures.length === 0
    ? `self-test: 全部通过（${selfTests().length} 条）`
    : `self-test: ${failures.length}/${selfTests().length} 条失败`)
  return failures.length === 0 ? 0 : 1
}

// ---------------------------------------------------------------------------
// 实测链路
// ---------------------------------------------------------------------------

function emit(tag, data) {
  console.log(JSON.stringify({ tag, ...data }))
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 借一个空闲回环端口。 */
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/** 开 SSH 本地转发并等它站住（350 秒窗口语义同 ensureTunnel，改为毫秒）。 */
async function openTunnel({ machine, remotePort, requestTimeoutMs }) {
  const localPort = await pickFreePort()
  const args = buildSshTunnelArgs({ machine, localPort, remotePort })
  const child = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-2048) })
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), 350)
    child.once('exit', (code) => { clearTimeout(timer); resolve(code) })
    child.once('error', () => { clearTimeout(timer); resolve(-1) })
  })
  if (exited !== undefined) throw new Error(`SSH 隧道未能建立（退出码 ${exited}）：${stderr.trim()}`)
  return { child, localPort }
}

/** 轮询隧道口直到有 HTTP 应答（任何状态码都算可达，401 即未认证但活着）。 */
async function waitReachable(localPort, deadlineMs) {
  const deadline = Date.now() + deadlineMs
  let lastError = ''
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${localPort}/`, { redirect: 'manual' })
      return { status: response.status }
    } catch (error) {
      lastError = error?.cause?.code ?? error?.message ?? String(error)
      await sleep(400)
    }
  }
  throw new Error(`隧道口 ${localPort} 不可达（最后错误：${lastError}）`)
}

/** 经独立 SSH 通道读远端启动日志最后一行标记（生产 readLaunchUrl 语义）。 */
function readRemoteLaunchUrl({ machine, remoteLog }) {
  const candidates = remoteLog !== undefined
    ? [remoteLog]
    : [
        '~/.local/state/threadharbor/stable/dsh-web.log',
        '~/.local/state/threadharbor/test/dsh-web.log',
        '~/.dsh-threadharbor/dsh-web.log',
        '~/.dsh/web.log',
      ]
  const read = (marker) => {
    const result = spawnSync('ssh', [machine, remoteLogReadCommand(candidates, marker)],
      { encoding: 'utf8', timeout: 20_000 })
    if (result.status !== 0 && result.error === undefined && (result.stdout ?? '') === '') return undefined
    return pickLastMarker(result.stdout ?? '', marker)
  }
  const fromMarker = read('LAUNCH_URL')
  if (fromMarker !== undefined) return { url: fromMarker, marker: 'LAUNCH_URL' }
  const fromWebLine = read('dsh-web')
  if (fromWebLine !== undefined) return { url: fromWebLine, marker: 'dsh-web' }
  return { url: undefined, marker: undefined }
}

/** 用启动令牌换会话 cookie（GET /?token= → 303 + Set-Cookie）。 */
async function exchangeTokenForCookie(base, token) {
  const response = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
  const setCookies = response.headers.getSetCookie()
  const pairs = setCookies.map((cookie) => cookie.split(';', 1)[0])
  return { status: response.status, location: response.headers.get('location'), report: cookieReport(setCookies), pairs }
}

/**
 * 带 cookie 调会话列表。实测（2026-10-16，tencent01）：传输层要求 payload 恰有
 * 一个平面对象字段 args；描述符层要求 args 内含 `_request` 字段——即最终形态
 * `payload:{args:{_request:{}}}`。先按 brief 信封 `{args:{}}` 发，被描述符拒绝
 * 后在 args 内补字段重试一次，并把两层事实都如实记入输出。
 */
async function rpcSessionList(base, cookieHeader) {
  const post = async (payload) => {
    const response = await fetch(`${base}/api/session/list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieHeader },
      body: JSON.stringify({ ...sessionListEnvelope('p1'), payload }),
    })
    const body = await response.json().catch(() => undefined)
    return { status: response.status, result: body?.result }
  }
  const missingField = (result) => {
    const error = result?.error
    if (error?.code !== 'gateway/arguments-invalid') return undefined
    return /missing "([^"]+)"/.exec(error?.message ?? '')?.[1]
  }
  const first = await post({ args: {} })
  let adaptation
  let outcome = first
  const missing = missingField(first.result)
  if (missing !== undefined) {
    const inner = missing === 'args' ? {} : { [missing]: {} }
    outcome = await post({ args: inner })
    adaptation = {
      briefEnvelope: 'payload:{args:{}}',
      serverDescriptorWants: missing === 'args' ? 'payload.args 本身' : `payload.args.${missing}`,
      finalEnvelope: 'payload:{args:{_request:{}}}',
      firstError: `${first.result?.error?.code ?? ''}: ${first.result?.error?.message ?? ''}`,
    }
  }
  const result = outcome.result
  return {
    status: outcome.status,
    resultOk: result?.ok === true,
    itemCount: result?.ok === true ? (result.value?.items ?? []).length : undefined,
    ...(adaptation !== undefined ? { adaptation } : {}),
    ...(result?.ok === true || adaptation !== undefined
      ? {}
      : { error: result?.error === undefined ? '响应缺 result' : `${result.error.code ?? ''}: ${result.error.message ?? JSON.stringify(result.error).slice(0, 240)}` }),
    ...(result?.ok === true || adaptation === undefined
      ? {}
      : { retryError: result?.error === undefined ? '响应缺 result' : `${result.error?.code ?? ''}: ${result.error?.message ?? ''}` }),
  }
}

/** 连一条 mux WS 并等 $events 的 ready 帧；顺带实测内置 WebSocket 能否带自定义头。 */
function probeMux(base, cookieHeader, wsModule, requestTimeoutMs) {
  return new Promise((resolveDone) => {
    const wsUrl = `${base.replace(/^http/, 'ws')}/api/remote.mux`
    const streamId = crypto.randomUUID()
    const ws = new wsModule.WebSocket(wsUrl, { headers: { cookie: cookieHeader } })
    const out = { upgraded: false, readyFrameType: undefined, hasClientId: false, clientIdLength: 0, closeReason: undefined }
    const finish = (extra) => { try { ws.close() } catch {} resolveDone({ ...out, ...extra }) }
    const timer = setTimeout(() => finish({ closeReason: 'timeout' }), requestTimeoutMs)
    ws.on('error', (error) => { clearTimeout(timer); finish({ closeReason: `error: ${error.message}` }) })
    ws.on('open', () => {
      out.upgraded = true
      ws.send(JSON.stringify(muxOpenFrame(streamId)))
    })
    ws.on('message', (data) => {
      let frame
      try { frame = JSON.parse(String(data)) } catch { return }
      if (frame?.streamId !== streamId) return
      clearTimeout(timer)
      out.readyFrameType = frame.type
      out.hasClientId = typeof frame.value?.clientId === 'string' && frame.value.clientId.length > 0
      out.clientIdLength = out.hasClientId ? frame.value.clientId.length : 0
      finish({})
    })
    ws.on('close', (code) => {
      if (!out.upgraded || out.readyFrameType === undefined) {
        clearTimeout(timer)
        finish({ closeReason: out.closeReason ?? `closed code=${code}` })
      }
    })
  })
}

/**
 * 实测 Node 内置 WebSocket 能否带自定义头。设计 §15 的前提是「不能」，本条
 * 以「升级后能否用该连接拿到 $events ready 帧」判定 cookie 是否真的随自定义
 * 头送达——只判定前提是否成立（premiseHeld），测量本身完成即 ok。
 */
async function probeBuiltinWebSocket(base, cookieHeader, timeoutMs) {
  const BuiltinWebSocket = globalThis.WebSocket
  if (typeof BuiltinWebSocket !== 'function') {
    return { available: false, measured: false, premiseHeld: undefined, verdict: '本 Node 无内置 WebSocket，无法实测' }
  }
  const wsUrl = `${base.replace(/^http/, 'ws')}/api/remote.mux`
  const streamId = crypto.randomUUID()
  try {
    const ws = new BuiltinWebSocket(wsUrl, { headers: { cookie: cookieHeader } })
    const outcome = await new Promise((resolve) => {
      let settled = false
      const done = (value) => { if (!settled) { settled = true; resolve(value) } }
      const timer = setTimeout(() => done({ phase: 'timeout', gotReady: false }), timeoutMs)
      ws.addEventListener('open', () => {
        try { ws.send(JSON.stringify(muxOpenFrame(streamId))) } catch (error) { clearTimeout(timer); done({ phase: 'send-error', gotReady: false, note: error.message }) }
      }, { once: true })
      ws.addEventListener('message', (event) => {
        try {
          const frame = JSON.parse(String(event.data))
          if (frame?.streamId === streamId && frame?.value?.clientId !== undefined) { clearTimeout(timer); done({ phase: 'ready', gotReady: true }) }
        } catch { /* 非 JSON 帧忽略 */ }
      })
      ws.addEventListener('error', () => { clearTimeout(timer); done({ phase: 'upgrade-error', gotReady: false }) })
    })
    try { ws.close() } catch {}
    const carriedCookie = outcome.gotReady === true
    return {
      available: true,
      measured: true,
      acceptsHeadersOption: true,
      carriedCookie,
      premiseHeld: !carriedCookie,
      phase: outcome.phase,
      verdict: carriedCookie
        ? '与设计预期相反：内置 WebSocket 不但接受 {headers}，cookie 也真随升级头送达（拿到 ready 帧）——「必须用 ws」的前提在本 Node 版本被推翻'
        : '构造与升级走了 {headers}，但未拿到 ready 帧（cookie 未必随自定义头送达）——前提部分成立',
    }
  } catch (error) {
    return {
      available: true,
      measured: true,
      acceptsHeadersOption: false,
      carriedCookie: false,
      premiseHeld: true,
      verdict: `构造即拒绝（${error.constructor?.name ?? 'Error'}: ${error.message}）——内置 WebSocket 不能带自定义头，前提成立，须用 ws`,
    }
  }
}

/** tailscale 对端发现（在本机执行；云主机视角即云主机的发现能力）。 */
function probeTailscale() {
  const result = spawnSync('tailscale', ['status', '--json'], { encoding: 'utf8', timeout: 15_000 })
  if (result.error !== undefined || result.status !== 0) {
    return { available: false, peerCount: 0, note: result.error?.code === 'ENOENT' ? 'tailscale 不在 PATH' : `退出码 ${result.status}` }
  }
  try {
    const status = JSON.parse(result.stdout)
    const peers = status.Peer ?? {}
    return { available: true, peerCount: Object.keys(peers).length, selfOnline: status.Self?.Online }
  } catch {
    return { available: false, peerCount: 0, note: 'status --json 输出不可解析' }
  }
}

async function runLive(options) {
  const { machine, port, remoteLog, wsFrom, requestTimeoutMs } = options
  const results = []
  const premiseInversions = []
  const record = (name, ok, detail) => { results.push({ name, ok, detail }); emit(`check.${name}`, { ok, ...detail }) }

  // 1. SSH 本地转发 + 隧道口可达
  let tunnel
  try {
    tunnel = await openTunnel({ machine, remotePort: port, requestTimeoutMs })
    const base = `http://127.0.0.1:${tunnel.localPort}`
    const { status } = await waitReachable(tunnel.localPort, requestTimeoutMs)
    record('tunnel', true, { machine, remotePort: port, localPort: tunnel.localPort, httpStatus: status })

    // 2. 经 SSH 读远端启动日志最后一行标记，取令牌（只报长度）
    const { url, marker } = readRemoteLaunchUrl({ machine, remoteLog })
    const token = url !== undefined ? extractToken(url) : undefined
    record('launchUrl', token !== undefined && token.length > 0,
      { marker, urlLength: url?.length, tokenGot: token !== undefined, tokenLength: token?.length })

    // 3. 令牌换 cookie（只报名字/长度/属性）
    if (token === undefined) throw new Error('无令牌，后续链路无法实测')
    const exchange = await exchangeTokenForCookie(base, token)
    const cookieHeader = exchange.pairs.join('; ')
    record('authExchange', exchange.status === 303 && exchange.pairs.length > 0,
      { status: exchange.status, location: exchange.location, cookies: exchange.report })
    if (cookieHeader === '') throw new Error('未取得 cookie，后续链路无法实测')

    // 4. 带 cookie 调会话列表
    const list = await rpcSessionList(base, cookieHeader)
    record('rpcSessionList', list.status === 200 && list.resultOk === true, list)

    // 5. ws 库带 Cookie 头升级 + 内置 WebSocket 对照
    const wsModule = await resolveWs(wsFrom)
    emit('ws.module', { resolvedFrom: wsModule.from })
    const mux = await probeMux(base, cookieHeader, wsModule, requestTimeoutMs)
    record('wsMuxReady', mux.upgraded === true && mux.readyFrameType !== undefined && mux.hasClientId === true, mux)
    const builtin = await probeBuiltinWebSocket(base, cookieHeader, Math.min(requestTimeoutMs, 5_000))
    // 测量完成即计 ok；「内置 WebSocket 不能带自定义头」这一设计前提是否成立
    // 单独以 premiseHeld 暴露——被推翻时如实计入 premiseInversions，不改写链路结论。
    record('builtinWebSocketHeaders', builtin.measured === true, builtin)
    if (builtin.measured === true && builtin.premiseHeld === false) premiseInversions.push('builtin-websocket-custom-headers')
  } catch (error) {
    record('chain', false, { error: error.message })
  } finally {
    tunnel?.child?.kill('SIGTERM')
  }

  // 6. tailscale 对端发现
  const tailscale = probeTailscale()
  record('tailscalePeers', tailscale.available === true && tailscale.peerCount > 0, tailscale)

  const failed = results.filter((item) => !item.ok)
  emit('summary', {
    ok: failed.length === 0,
    passed: results.length - failed.length,
    failed: failed.length,
    failures: failed.map((item) => item.name),
    premiseInversions,
    note: '全部条目均为实测；证据文档另有「源码钉死 + 出处」条目',
  })
  return failed.length === 0 ? 0 : 1
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { requestTimeoutMs: 20_000 }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--self-test') options.selfTest = true
    else if (arg === '--machine') options.machine = argv[++index]
    else if (arg === '--port') options.port = Number(argv[++index])
    else if (arg === '--remote-log') options.remoteLog = argv[++index]
    else if (arg === '--ws-from') options.wsFrom = argv[++index]
    else if (arg === '--request-timeout') options.requestTimeoutMs = Number(argv[++index])
    else { console.error(`未知参数：${arg}`); process.exit(2) }
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
if (options.selfTest === true) process.exit(runSelfTests())
if (options.machine === undefined || !Number.isInteger(options.port) || options.port <= 0) {
  console.error('用法：node scripts/probe-relay-wire.mjs --machine <ssh目标> --port <远端DSH端口> [--remote-log <路径>] [--ws-from <目录>] [--self-test]')
  process.exit(2)
}
process.exit(await runLive(options))
