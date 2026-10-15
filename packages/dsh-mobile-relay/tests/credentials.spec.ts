import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CredentialResolveOutcome } from '../src/credentials.ts'
import { CredentialStore, exchangeLaunchToken, MachineCredentials } from '../src/credentials.ts'
import { StateStore, type StoredCredential } from '../src/state.ts'

/**
 * 凭据层用例：换 cookie（启动令牌 → 整对 name=value）、持久化（0600 状态
 * 文档、与隧道段互不抹账）、失效自愈（401 → 判脏 → 重换一次）。测试替身
 * 照 peers.ts / load.spec.ts 的既有做法：fetch 与 readLaunchUrl 由用例传入
 * 假件，状态文件落 mkdtemp 临时目录；令牌与 cookie 用 canary 常量，错误
 * 路径上扫描结果文本，钉住「凭据不进任何返回文本」的纪律。
 */

const HOST = 'gooddemacbook-pro'
/** 换取锚点（隧道本机侧 origin）；与 launchUrl 里的地址刻意不同，钉住「令牌重新锚到 origin」。 */
const ORIGIN = 'http://127.0.0.1:41001'
const TOKEN = 'canary-launch-token-0123456789abcdef'
/** cookie 名带每实例随机后缀（阶段 0 实测三次三个名字），所以整对逐字存。 */
const COOKIE_NAME = 'dsh-auth-vEq2NloGx0VO3K1YJUG3Py20ZyCaokxDweB3K6Dx2pA'
const COOKIE_VALUE = 'canary-cookie-value-abcdefgh1234567890abcdefgh1234567890'
const FULL_SET_COOKIE = `${COOKIE_NAME}=${COOKIE_VALUE}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict`
const STORED_COOKIE = `${COOKIE_NAME}=${COOKIE_VALUE}`

/** 状态文件放临时目录；中间一层目录不预先建，让被测代码自己按 0700 建。 */
function statePathInTemp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'relay-credentials-'))
  return join(dir, 'state', 'state.json')
}

/** 完整 DSH 启动网址（生产 readLaunchUrl 的形态：含 ?token= 的完整 URL）。 */
const readLaunchUrlOf = async (): Promise<string> => `http://127.0.0.1:3082/?token=${TOKEN}`

/** 错误路径共用：返回值序列化后不得出现令牌或 cookie 值。 */
function expectNoSecrets(value: unknown): void {
  const text = JSON.stringify(value)
  expect(text).toBeDefined()
  expect(text).not.toContain(TOKEN)
  expect(text).not.toContain(COOKIE_VALUE)
}

interface FetchCall {
  url: string
  init: RequestInit | undefined
}

/**
 * fetch 假件：按队列逐个应答，Error 项表示传输抛错；队列空了还来请求
 * 说明实现多发了一次，直接抛错让用例红。
 */
function fetchFake(...responses: Array<Response | Error>): { calls: FetchCall[]; fetchLike: typeof fetch } {
  const calls: FetchCall[] = []
  const fetchLike: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init })
    const next = responses.shift()
    if (next === undefined) throw new Error('假件队列已空，不该再发请求')
    if (next instanceof Error) throw next
    return next
  }
  return { calls, fetchLike }
}

/** 带 Set-Cookie 的最小应答；用真 Headers（getSetCookie 行为与生产一致）。 */
function responseWith(setCookie: readonly string[], status = 303): Response {
  const headers = new Headers()
  for (const value of setCookie) headers.append('set-cookie', value)
  return { headers, status } as unknown as Response
}

const NO_COOKIE_RESPONSE = responseWith([])
/** 令牌被对端拒了：状态码不同，现场处置完全不同，必须能一眼分开。 */
const REJECTED_RESPONSE = responseWith([], 401)

describe('CredentialStore（整对 cookie 的持久化）', () => {
  it('put 后 get/list 原样读回；同 hostId 再 put 是覆盖不是追加；forget 只删指定的', () => {
    const store = new CredentialStore(statePathInTemp())
    const first: StoredCredential = { hostId: HOST, cookie: STORED_COOKIE, obtainedAt: 1000 }
    const second: StoredCredential = { hostId: 'host-b', cookie: 'dsh-auth-bb=cc', obtainedAt: 2000 }
    store.put(first)
    store.put(second)
    expect(store.get(HOST)).toEqual(first)
    expect(store.list()).toEqual([first, second])
    const updated: StoredCredential = { hostId: HOST, cookie: 'dsh-auth-new=dd', obtainedAt: 3000 }
    store.put(updated)
    expect(store.list()).toEqual([second, updated])
    store.forget('host-b')
    store.forget('不存在也不抛')
    expect(store.list()).toEqual([updated])
    expect(store.get('host-b')).toBeUndefined()
  })

  it('凭据跨实例持久化：新开的 store 读到同一份', () => {
    const path = statePathInTemp()
    new CredentialStore(path).put({ hostId: HOST, cookie: STORED_COOKIE, obtainedAt: 7 })
    expect(new CredentialStore(path).get(HOST)?.cookie).toBe(STORED_COOKIE)
  })

  it('随机后缀 cookie 名逐字落盘：文件里存的是整对 name=value，转发时原样当 Cookie 头', () => {
    const path = statePathInTemp()
    new CredentialStore(path).put({ hostId: HOST, cookie: STORED_COOKIE, obtainedAt: 7 })
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { credentials: Array<{ cookie: string }> }
    expect(parsed.credentials).toHaveLength(1)
    expect(parsed.credentials[0]?.cookie).toBe(STORED_COOKIE)
  })

  it('文件 0600、目录 0700（目录由被测代码自己创建）', () => {
    const path = statePathInTemp()
    new CredentialStore(path).put({ hostId: HOST, cookie: STORED_COOKIE, obtainedAt: 7 })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700)
  })

  it('put 空 cookie 直接拒掉：空值一旦落盘就会被原样发进 Cookie 头', () => {
    const store = new CredentialStore(statePathInTemp())
    expect(() => store.put({ hostId: HOST, cookie: '', obtainedAt: 7 })).toThrow(/cookie/)
  })

  it.each([
    ['JSON 解析失败', '{oops'],
    ['version 不认识', '{"version":99,"credentials":[],"tunnels":{}}'],
    ['credentials 不是数组', '{"version":1,"credentials":"junk","tunnels":{}}'],
    ['条目形状不对', `{"version":1,"credentials":[{"hostId":1,"cookie":"x","obtainedAt":"y"}],"tunnels":{}}`],
  ])('状态文件%j：按凭据全无处理，不静默用半份；之后 put 能把文件治好', (_label, raw) => {
    const path = statePathInTemp()
    const healthy = new CredentialStore(path)
    healthy.put({ hostId: HOST, cookie: STORED_COOKIE, obtainedAt: 7 })
    writeFileSync(path, raw, 'utf8')
    const broken = new CredentialStore(path)
    expect(broken.get(HOST)).toBeUndefined()
    expect(broken.list()).toEqual([])
    // 治好：重新换取后照常落盘读回
    broken.put({ hostId: HOST, cookie: 'dsh-auth-healed=ok', obtainedAt: 9 })
    expect(new CredentialStore(path).get(HOST)?.cookie).toBe('dsh-auth-healed=ok')
  })
})

describe('StateStore（凭据与端口分配共用一份状态文档）', () => {
  it('新文件读出初始文档：version 1、两段皆空', () => {
    expect(new StateStore(statePathInTemp()).read()).toEqual({ version: 1, credentials: [], tunnels: {}, lastSeen: {} })
  })

  it('两段同住一份文档，先后写入互不抹账（凭据与端口分配共存，谁也不吃掉谁的账）', () => {
    const path = statePathInTemp()
    const state = new StateStore(path)
    // 隧道池（Task 5）的写法预演：update 里只动 tunnels 段
    state.update(doc => ({ ...doc, tunnels: { ...doc.tunnels, [HOST]: { port: 41234 } } }))
    new CredentialStore(path).put({ hostId: HOST, cookie: STORED_COOKIE, obtainedAt: 7 })
    // 反向再来一次：凭据落定后隧道段继续写
    state.update(doc => ({ ...doc, tunnels: { ...doc.tunnels, 'host-b': { port: 41235 } } }))
    expect(new StateStore(path).read()).toEqual({
      version: 1,
      credentials: [{ hostId: HOST, cookie: STORED_COOKIE, obtainedAt: 7 }],
      tunnels: { [HOST]: { port: 41234 }, 'host-b': { port: 41235 } },
      lastSeen: {},
    })
  })

  it('mutator 抛错时不落盘：文档保持原样，不出现半写状态', () => {
    const path = statePathInTemp()
    const state = new StateStore(path)
    new CredentialStore(path).put({ hostId: HOST, cookie: STORED_COOKIE, obtainedAt: 7 })
    expect(() =>
      state.update(() => {
        throw new Error('算一半失败')
      }),
    ).toThrow('算一半失败')
    expect(new StateStore(path).read().credentials).toHaveLength(1)
  })
})

describe('exchangeLaunchToken（启动令牌换 cookie）', () => {
  it('GET origin/?token=令牌：请求锚在 origin（不是 launchUrl 的地址），redirect manual，返回整对 name=value', async () => {
    const { calls, fetchLike } = fetchFake(responseWith([FULL_SET_COOKIE]))
    const result = await exchangeLaunchToken(ORIGIN, `http://127.0.0.1:3082/?token=${TOKEN}`, fetchLike)
    expect(result).toEqual({ cookie: STORED_COOKIE })
    expect(calls).toHaveLength(1)
    const sent = calls[0]
    if (sent === undefined) throw new Error('unreachable')
    const url = new URL(sent.url)
    expect(url.origin).toBe(ORIGIN)
    expect(url.searchParams.get('token')).toBe(TOKEN)
    expect(sent.init?.redirect).toBe('manual')
  })

  it('应答没有 Set-Cookie → { error }（不抛），且错误文本不带令牌', async () => {
    const { fetchLike } = fetchFake(NO_COOKIE_RESPONSE)
    const result = await exchangeLaunchToken(ORIGIN, `http://127.0.0.1:3082/?token=${TOKEN}`, fetchLike)
    expect('error' in result && result.error.length > 0).toBe(true)
    expect('cookie' in result).toBe(false)
    expectNoSecrets(result)
  })

  it('fetch 传输抛错 → { error }（不抛、不外带原始错误），令牌不出现在任何返回文本', async () => {
    const { fetchLike } = fetchFake(new Error(`boom for ${`http://x/?token=${TOKEN}`}`))
    const result = await exchangeLaunchToken(ORIGIN, `http://127.0.0.1:3082/?token=${TOKEN}`, fetchLike)
    expect('error' in result).toBe(true)
    expectNoSecrets(result)
  })

  it.each([
    ['缺 token 参数', 'http://127.0.0.1:3082/?other=1'],
    ['不是合法 URL', 'not a url'],
    ['scheme 不是 http(s)', `ftp://127.0.0.1/?token=${TOKEN}`],
  ])('launchUrl 坏（%s）→ { error }，launchUrl 原文（含令牌）不进错误文本', async (_label, launchUrl) => {
    const { fetchLike } = fetchFake(responseWith([FULL_SET_COOKIE]))
    const result = await exchangeLaunchToken(ORIGIN, launchUrl, fetchLike)
    expect('error' in result).toBe(true)
    expectNoSecrets(result)
  })

  it('origin 非 http(s) → { error }，一次请求都不发', async () => {
    const { calls, fetchLike } = fetchFake(responseWith([FULL_SET_COOKIE]))
    const result = await exchangeLaunchToken('file:///etc', `http://127.0.0.1:3082/?token=${TOKEN}`, fetchLike)
    expect('error' in result).toBe(true)
    expect(calls).toHaveLength(0)
  })
})

describe('MachineCredentials.resolve（取 cookie 与失效自愈一次）', () => {
  it('① 已存 cookie：不发任何请求直接返回', async () => {
    const store = new CredentialStore(statePathInTemp())
    store.put({ hostId: HOST, cookie: STORED_COOKIE, obtainedAt: 7 })
    const { calls, fetchLike } = fetchFake(responseWith([FULL_SET_COOKIE]))
    let readLaunchCalls = 0
    const result = await new MachineCredentials(store, fetchLike).resolve(HOST, ORIGIN, async () => {
      readLaunchCalls += 1
      return readLaunchUrlOf()
    })
    expect(result).toEqual({ ok: true, cookie: STORED_COOKIE })
    expect(calls).toHaveLength(0)
    expect(readLaunchCalls).toBe(0)
  })

  it('② 无 cookie：读启动网址 → 换取 → 返回并记住（换到的整对 cookie 落盘）', async () => {
    const path = statePathInTemp()
    const { calls, fetchLike } = fetchFake(responseWith([FULL_SET_COOKIE]))
    const result = await new MachineCredentials(new CredentialStore(path), fetchLike).resolve(HOST, ORIGIN, readLaunchUrlOf)
    expect(result).toEqual({ ok: true, cookie: STORED_COOKIE })
    expect(calls).toHaveLength(1)
    expect(new CredentialStore(path).get(HOST)?.cookie).toBe(STORED_COOKIE)
  })

  it('③ readLaunchUrl 返回 undefined → { ok:false, reason:missing-launch-url }，一次网络请求都不发', async () => {
    const { calls, fetchLike } = fetchFake(responseWith([FULL_SET_COOKIE]))
    const result = await new MachineCredentials(new CredentialStore(statePathInTemp()), fetchLike).resolve(
      HOST,
      ORIGIN,
      async () => undefined,
    )
    expect(result).toEqual({ ok: false, reason: 'missing-launch-url' })
    expect(calls).toHaveLength(0)
  })

  it('④ 交换应答没有 Set-Cookie → { ok:false, reason:no-cookie }', async () => {
    const { calls, fetchLike } = fetchFake(NO_COOKIE_RESPONSE)
    const result = await new MachineCredentials(new CredentialStore(statePathInTemp()), fetchLike).resolve(
      HOST,
      ORIGIN,
      readLaunchUrlOf,
    )
    expect(result).toEqual({ ok: false, reason: 'no-cookie', detail: 'HTTP 303' })
    expect(calls).toHaveLength(1)
    expectNoSecrets(result)
  })

  it('fetch 传输失败 → { ok:false, reason:unreachable }（不抛）', async () => {
    const { fetchLike } = fetchFake(new Error('tunnel down'))
    const result = await new MachineCredentials(new CredentialStore(statePathInTemp()), fetchLike).resolve(
      HOST,
      ORIGIN,
      readLaunchUrlOf,
    )
    expect(result).toEqual({ ok: false, reason: 'unreachable' })
  })

  it('readLaunchUrl 抛错（SSH 失败一类）→ { ok:false, reason:unreachable }（不抛）', async () => {
    const { calls, fetchLike } = fetchFake(responseWith([FULL_SET_COOKIE]))
    const result = await new MachineCredentials(new CredentialStore(statePathInTemp()), fetchLike).resolve(
      HOST,
      ORIGIN,
      async () => {
        throw new Error('ssh failed')
      },
    )
    expect(result).toEqual({ ok: false, reason: 'unreachable' })
    expect(calls).toHaveLength(0)
  })

  it('⑤ 转发吃到 401 → invalidate 判脏 → 第二次 resolve 重换成功，旧 cookie 被换新', async () => {
    const path = statePathInTemp()
    const store = new CredentialStore(path)
    store.put({ hostId: HOST, cookie: 'dsh-auth-stale=old', obtainedAt: 7 })
    const mc = new MachineCredentials(store, fetchFake(responseWith([FULL_SET_COOKIE])).fetchLike)
    expect(await mc.resolve(HOST, ORIGIN, readLaunchUrlOf)).toEqual({ ok: true, cookie: 'dsh-auth-stale=old' })
    // 旧 cookie 被服务端拒（401）：调用方判脏，清掉后重取
    mc.invalidate(HOST)
    expect(store.get(HOST)).toBeUndefined()
    const healed = await mc.resolve(HOST, ORIGIN, readLaunchUrlOf)
    expect(healed).toEqual({ ok: true, cookie: STORED_COOKIE })
    expect(new CredentialStore(path).get(HOST)?.cookie).toBe(STORED_COOKIE)
  })

  it('⑤b 重换仍失败（这次没有 Set-Cookie）→ { ok:false, reason:no-cookie }，旧 cookie 不复活', async () => {
    const store = new CredentialStore(statePathInTemp())
    store.put({ hostId: HOST, cookie: 'dsh-auth-stale=old', obtainedAt: 7 })
    const { fetchLike } = fetchFake(NO_COOKIE_RESPONSE)
    const mc = new MachineCredentials(store, fetchLike)
    expect(await mc.resolve(HOST, ORIGIN, readLaunchUrlOf)).toEqual({ ok: true, cookie: 'dsh-auth-stale=old' })
    mc.invalidate(HOST)
    const second = await mc.resolve(HOST, ORIGIN, readLaunchUrlOf)
    expect(second).toEqual({ ok: false, reason: 'no-cookie', detail: 'HTTP 303' })
    expect(store.get(HOST)).toBeUndefined()
  })
})

  it('令牌被拒（HTTP 401）与「应答没 cookie」要能分开（处置完全相反）', async () => {
    const rejected = await new MachineCredentials(new CredentialStore(statePathInTemp()), fetchFake(REJECTED_RESPONSE).fetchLike)
      .resolve(HOST, ORIGIN, readLaunchUrlOf)
    expect(rejected).toEqual({ ok: false, reason: 'no-cookie', detail: 'HTTP 401' })

    const unparsed = await new MachineCredentials(new CredentialStore(statePathInTemp()), fetchFake(NO_COOKIE_RESPONSE).fetchLike)
      .resolve(HOST, ORIGIN, readLaunchUrlOf)
    const detailOf = (outcome: CredentialResolveOutcome): string =>
      outcome.ok ? '' : (outcome.detail ?? '')
    expect(detailOf(rejected)).toBe('HTTP 401')
    expect(detailOf(unparsed)).not.toBe(detailOf(rejected))
  })

describe('并发换取同一台机器的凭据', () => {
  it('同一 hostId 的并发 resolve 只换一次令牌（启动令牌只能用一次）', async () => {
    let exchanges = 0
    const response = responseWith(['dsh-auth-abc=v1.token; Path=/'])
    const fetchLike = (async () => {
      exchanges += 1
      return response
    }) as unknown as typeof fetch

    const creds = new MachineCredentials(new CredentialStore(statePathInTemp()), fetchLike)
    const [first, second] = await Promise.all([
      creds.resolve(HOST, ORIGIN, readLaunchUrlOf),
      creds.resolve(HOST, ORIGIN, readLaunchUrlOf),
    ])

    expect(exchanges).toBe(1)
    expect(first).toEqual(second)
    expect(first.ok).toBe(true)
  })

  it('不同 hostId 各换各的（去重不能跨机器）', async () => {
    let exchanges = 0
    const response = responseWith(['dsh-auth-abc=v1.token; Path=/'])
    const fetchLike = (async () => { exchanges += 1; return response }) as unknown as typeof fetch
    const creds = new MachineCredentials(new CredentialStore(statePathInTemp()), fetchLike)
    await Promise.all([
      creds.resolve(HOST, ORIGIN, readLaunchUrlOf),
      creds.resolve('other-host', ORIGIN, readLaunchUrlOf),
    ])
    expect(exchanges).toBe(2)
  })
})
