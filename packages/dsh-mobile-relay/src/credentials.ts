/**
 * 凭据层：把各台机器 DSH 的「启动令牌」换成操作 cookie，存进共用状态文
 * 档（state.ts），并在失效时自愈一次。
 *
 * 官方准入只认 cookie（阶段 0 真机实测，docs/research/2026-10-16-relay-spike.md）：
 * 启动令牌不能直接调 API，换 cookie 的唯一入口是 `GET /?token=<令牌>`，
 * 成功应答 303 + Set-Cookie。cookie 名带每实例不同的随机后缀（实测三次三
 * 个名字），所以存的是 Set-Cookie 首对的 `name=value` 逐字，转发时原样当
 * Cookie 请求头——不解析出名字另存，名字怎么拆这件事只在这里实现一次。
 *
 * 失败方向必须安全：读不到启动网址、SSH 失败、应答没有 Set-Cookie、
 * fetch 传输失败、状态文件损坏，全部折成 `{error}` / `{ok:false}`，绝不抛
 * 出、绝不当成成功。令牌与 cookie 不进任何日志、错误消息或返回文本——错
 * 误里只有原因码（fetch 的原始错误可能带请求 URL，所以连 message 都不外
 * 带）。
 */

import { StateStore } from './state.ts'
import type { StoredCredential } from './state.ts'

export type { StoredCredential }

/** resolve 的失败原因；面向调用方的分类，具体细节在各自函数的注释里。 */
export type CredentialResolveFailure = 'missing-launch-url' | 'no-cookie' | 'unreachable'

/**
 * resolve 的结果。失败时带一句**人话细节**给运维：同一个 `no-cookie` 可能是
 * 「令牌被对端拒了」（HTTP 401/403，要人重新配对）和「应答解析不出来」
 * （HTTP 200/303，代码问题）——两者的处置完全相反，不带状态码就只能靠猜。
 */
export type CredentialResolveOutcome =
  | { ok: true; cookie: string }
  | { ok: false; reason: CredentialResolveFailure; detail?: string }

function parseHttpUrl(value: string): URL | undefined {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return undefined
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : undefined
}

/** 启动网址（生产形态是 `http://127.0.0.1:PORT/?token=…` 整条）里取令牌；取不到不算失败，只算「没有令牌」。 */
function tokenOfLaunchUrl(launchUrl: string): string | undefined {
  const parsed = parseHttpUrl(launchUrl.trim())
  if (parsed === undefined) return undefined
  const token = parsed.searchParams.get('token')
  return token !== null && token !== '' ? token : undefined
}

/**
 * 从应答取 Set-Cookie 首对的 `name=value` 逐字。优先 getSetCookie()（多枚
 * set-cookie 时不会被 `get` 的逗号拼接弄坏 Expires 日期），取不到再退回
 * `get('set-cookie')` 兼容非标准 fetch 假件。名字/值有一侧为空都算没有。
 */
function cookiePairOf(response: Response): string | undefined {
  const headers = response.headers as { getSetCookie?: () => string[]; get(name: string): string | null }
  const raw = typeof headers.getSetCookie === 'function' ? (headers.getSetCookie()[0] ?? null) : headers.get('set-cookie')
  if (raw === null) return undefined
  const pair = (raw.split(';')[0] ?? '').trim()
  const eq = pair.indexOf('=')
  if (eq <= 0 || eq === pair.length - 1) return undefined
  return pair
}

/**
 * 用启动令牌换一枚 cookie：`GET <origin>/?token=<令牌>`，成功返回整对
 * `name=value`。origin 必须是 http(s)——请求锚在 origin（隧道本机侧），
 * 不用 launchUrl 里的地址（那是机器上的回环地址，中转够不着）；令牌只出
 * 现在这一次请求的 URL 里。
 *
 * redirect 用 manual：实测 Node 24 的 undici 在 manual 下返回 303 本体、
 * Set-Cookie 可读；follow 会把 Set-Cookie 留在被跟随的重定向应答里，最后
 * 拿到的是无 cookie 的落点页。manual 同时保证令牌网址不会被重定向带去别
 * 的源。
 */
/** 换凭据这一步的预算：与读启动日志同档（3s），压在整份清单的 10s 之内。 */
const EXCHANGE_TIMEOUT_MS = 3_000

export async function exchangeLaunchToken(
  origin: string,
  launchUrl: string,
  fetchLike?: typeof fetch,
): Promise<{ cookie: string } | { error: string; detail?: string }> {
  const doFetch = fetchLike ?? globalThis.fetch
  const originUrl = parseHttpUrl(origin)
  if (originUrl === undefined) return { error: 'bad-origin' }
  const token = tokenOfLaunchUrl(launchUrl)
  if (token === undefined) return { error: 'bad-launch-url' }
  let response: Response
  // 显式超时：这一步是「隧道活着但远端 DSH 挂起」形态下唯一无界的调用——
  // 隧道能建、端口在听、远端 accept 之后不答，于是永远挂着。挂着时这一机在
  // 清单里既不算可达、也不产生 error（被上面的 allSettled 静默吃掉），整份
  // 清单只能被路由层的 10s 兜成空。3s 是本机内各步预算里最长的一档，压得住。
  const abort = AbortSignal.timeout(EXCHANGE_TIMEOUT_MS)
  try {
    response = await doFetch(new URL(`/?token=${encodeURIComponent(token)}`, originUrl), {
      redirect: 'manual',
      signal: abort,
    })
  } catch {
    // 传输失败不外带原始错误：它的文本可能包含完整请求 URL（即令牌）。
    return { error: 'unreachable' }
  }
  const cookie = cookiePairOf(response)
  // 细节只带状态码：令牌的任何片段都不进这里（它是凭据），它去哪儿都会跟着
  // 机器清单进手机。真要查令牌读没读对，去机器的启动日志上核对。
  if (cookie === undefined) return { error: 'no-cookie', detail: `HTTP ${response.status}` }
  return { cookie }
}

/**
 * 凭据的家：statePath 状态文档的 credentials 段。文件以 0600 写、目录以
 * 0700 建（StateStore 负责）；内容损坏按凭据全无处理（走重新换取）。
 */
export class CredentialStore {
  private readonly state: StateStore

  constructor(path: string) {
    this.state = new StateStore(path)
  }

  list(): readonly StoredCredential[] {
    return this.state.read().credentials
  }

  get(hostId: string): StoredCredential | undefined {
    return this.list().find(entry => entry.hostId === hostId)
  }

  /**
   * 写入/覆盖一台机器的凭据。空值在写入口拒掉：空 cookie 落盘后会被原样
   * 发进 Cookie 头；错误消息只带 hostId 与字段名，不带值。
   */
  put(entry: StoredCredential): void {
    if (entry.hostId === '') throw new TypeError('凭据 hostId 不能为空')
    if (entry.cookie === '') throw new TypeError(`凭据 cookie 不能为空（hostId=${entry.hostId}）`)
    if (!Number.isFinite(entry.obtainedAt)) {
      throw new TypeError(`凭据 obtainedAt 必须是有限数值（hostId=${entry.hostId}）`)
    }
    this.state.update(doc => ({
      ...doc,
      credentials: [...doc.credentials.filter(existing => existing.hostId !== entry.hostId), { ...entry }],
    }))
  }

  forget(hostId: string): void {
    this.state.update(doc => ({
      ...doc,
      credentials: doc.credentials.filter(entry => entry.hostId !== hostId),
    }))
  }
}

/**
 * 各机凭据的取用面。缓存语义：拿到过就直给——不发请求也不探活，每笔真
 * 实的转发请求本身就是一次校验。调用方在转发应答吃到 401 时调
 * {@link MachineCredentials.invalidate} 判脏，下一次 resolve 重换一次（自
 * 愈）；若重换出来的 cookie 再吃 401，调用方应按持续故障停下处置——自愈
 * 只有一次，循环重换等于把启动令牌当无限凭据刷，也会把对端日志刷爆。
 */
export class MachineCredentials {
  private readonly store: CredentialStore
  private readonly fetchLike: typeof fetch
  /** 进程内缓存：省掉每笔转发前的读盘；invalidate 时与盘上条目一起清。 */
  private readonly cache = new Map<string, string>()
  /**
   * 同一台机器在途的换取：并发调用共用一笔。
   *
   * 启动令牌**只能用一次**。清单层与转发层会在同一轮里各要一次凭据（一个是
   * 自报状态，一个是拿 cookie 去连），没有这份去重时它们各换一次：先到的拿到
   * 凭据，后到的吃一个 401，于是「凭据明明换到了」与「换凭据失败」会同时出现，
   * 现场看起来像随机的网络故障。
   */
  private readonly pending = new Map<string, Promise<CredentialResolveOutcome>>()

  constructor(store: CredentialStore, fetchLike?: typeof fetch) {
    this.store = store
    this.fetchLike = fetchLike ?? globalThis.fetch
  }

  async resolve(
    hostId: string,
    origin: string,
    readLaunchUrl: () => Promise<string | undefined>,
  ): Promise<CredentialResolveOutcome> {
    const inFlight = this.pending.get(hostId)
    if (inFlight !== undefined) return await inFlight
    const run = this.resolveOnce(hostId, origin, readLaunchUrl)
    this.pending.set(hostId, run)
    try {
      return await run
    } finally {
      this.pending.delete(hostId)
    }
  }

  private async resolveOnce(
    hostId: string,
    origin: string,
    readLaunchUrl: () => Promise<string | undefined>,
  ): Promise<CredentialResolveOutcome> {
    const known = this.cache.get(hostId) ?? this.store.get(hostId)?.cookie
    if (known !== undefined) {
      this.cache.set(hostId, known)
      return { ok: true, cookie: known }
    }
    let launchUrl: string | undefined
    try {
      launchUrl = await readLaunchUrl()
    } catch {
      // 读启动网址本身失败（SSH 断、命令挂）：按不可达处置，不往上抛。
      return { ok: false, reason: 'unreachable' }
    }
    if (launchUrl === undefined) return { ok: false, reason: 'missing-launch-url' }
    const exchanged = await exchangeLaunchToken(origin, launchUrl, this.fetchLike)
    if ('error' in exchanged) {
      const detail = 'detail' in exchanged ? String(exchanged.detail) : ''
      return detail === ''
        ? { ok: false, reason: resolveReasonOf(exchanged.error) }
        : { ok: false, reason: resolveReasonOf(exchanged.error), detail }
    }
    const entry: StoredCredential = { hostId, cookie: exchanged.cookie, obtainedAt: Date.now() }
    this.cache.set(hostId, entry.cookie)
    this.store.put(entry)
    return { ok: true, cookie: entry.cookie }
  }

  /** 调用方判脏的入口（转发吃到 401 时调）：缓存与盘上条目一起清，下次 resolve 重换。 */
  invalidate(hostId: string): void {
    this.cache.delete(hostId)
    this.store.forget(hostId)
    // 在途的那笔没有跟着作废的义务：它换到的是有效 cookie，落盘后下次直接用。
    // 真正需要作废的是**下一笔**——所以不 cancel 在途，只让它正常收尾。
  }
}

/** 交换层的错误码折成 resolve 的失败原因；配置类坏值（bad-origin）同样按不可达处置。 */
function resolveReasonOf(error: string): CredentialResolveFailure {
  if (error === 'no-cookie') return 'no-cookie'
  if (error === 'bad-launch-url') return 'missing-launch-url'
  return 'unreachable'
}
