/**
 * Codex（ChatGPT 套餐）的额度与积分，宿主侧读取与转发。
 *
 * 数据链路（2026-11-01 对本机真实登录实测）：`~/.codex/auth.json` 存着 ChatGPT
 * OAuth 令牌（`tokens.access_token` + `tokens.account_id`），带上
 * `Authorization: Bearer` 与 `chatgpt-account-id` 头问一次
 * `GET https://chatgpt.com/backend-api/codex/usage`，就拿到账号级额度：
 *
 * - `rate_limit.primary_window` / `secondary_window`：`used_percent`、
 *   `limit_window_seconds`（5 小时窗 18000、周窗 604800，按套餐而异）、
 *   `reset_after_seconds` / `reset_at`。secondary 可能为 null（如 Pro 档只有周窗）。
 * - `credits`：`has_credits` / `balance` —— 按量付费积分，有才显示。
 * - `plan_type`：套餐档位（plus / pro / free / team …）。
 *
 * 令牌只在本进程内存里用，不落盘、不进日志；抛出的错误一律脱敏。
 * 这是官方 CLI `/status` 视图同源的只读接口；官方没承诺过字段稳定性，
 * 形状变了胶囊会整行隐藏并在日志里留原因（依赖点见 docs/upstream-sync.zh.md）。
 */

import { readFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'threadharbor-codex-quota'

/** webServer 挂路由；connection 做准入（admit）。 */
export const inject = ['webServer', 'connection']

/** exact 路由路径；浏览器侧的胶囊按这个常量取数。 */
export const QUOTA_ROUTE_PATH = '/threadharbor/codex/quota'

/** 成功应答的缓存时长；多标签页轮询时上游每半分钟最多被问一次。 */
const CACHE_TTL_MS = 30_000

/** 取数超时：挂住的上游不该把这一路接口一起挂住。 */
export const USAGE_UPSTREAM_TIMEOUT_MS = 15_000

const USAGE_URL = 'https://chatgpt.com/backend-api/codex/usage'

/**
 * UA 里的版本号：chatgpt.com 的防护拦「过于笼统」的客户端（2026-11-01 实测，
 * 裸 `codex_cli_rs` 回 403，带版本号才放行；而 `(Mac OS; arm64)` 这种没版本
 * 号的平台段又被拦，所以只拼版本）。跟随本机 CLI 的版本只是为了让请求长得
 * 像它自己发的；上游改防护时这里要跟着调。
 */
const CODEX_CLI_UA_VERSION = '0.148.0'

/** 一档已消耗的窗口；`windowSeconds` 决定客户端叫它「5小时」还是「周」。 */
export type CodexUsageWindow = {
  readonly kind: 'five-hour' | 'weekly'
  /** 已用百分比（Codex 的口径就是已用，越高越红）。 */
  readonly percent: number
  readonly windowSeconds: number
  readonly resetAt?: number
}

/** 按量付费积分余额，有才带上。 */
export type CodexCredits = {
  readonly balance: number
}

/**
 * 一次取数的答案（与宿主路由应答里的 `quota` 同形）。上游叫 primary/secondary
 * 且时长随套餐变（5 小时或一周），这里按窗口时长归一成 fiveHour / weekly 两个
 * 槽位——primary 是周窗就进 weekly（如 Pro 档），是 5 小时窗就进 fiveHour。
 */
export type CodexUsage = {
  readonly level?: string
  readonly fiveHour?: CodexUsageWindow
  readonly weekly?: CodexUsageWindow
  readonly credit?: CodexCredits
}

/** 本机凭据（测试直接注入，绕开真实文件）。 */
export type CodexCredential = {
  readonly accessToken: string
  readonly accountId: string
}

/** 取一次额度的最小面：无参进去，额度或 null 出来，失败抛错（消息已脱敏）。 */
export type CodexUsageFetch = () => Promise<CodexUsage | null>

/** 模块级可替换的取数器：生产走真凭据真网络，测试换假件。 */
let usageFetch: CodexUsageFetch | undefined

/**
 * 换取数器（测试注入假件）；传回 `undefined` 恢复真件。
 * @param next - 下一只取数器，或 `undefined` 恢复生产实现。
 */
export function swapUsageFetch(next: CodexUsageFetch | undefined): void {
  usageFetch = next
}

/** 本入口需要的宿主面（窄接口，测试立桩照这个来）。 */
export interface CodexQuotaContext {
  effect(factory: () => unknown, label?: string): unknown
  webServer: {
    register(route: {
      kind: 'exact'
      path: string
      handler(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse): void | Promise<void>
    }): (() => void) | void
  }
  connection: {
    admit(request: import('node:http').IncomingMessage): { rejection: number } | { peer: unknown }
  }
}

/** 注册时可选的注入面；生产空着，测试换缓存时长。 */
export interface CodexQuotaRouteDeps {
  /** 成功应答的缓存时长（毫秒）；缺省 30 秒。 */
  ttlMs?: number
}

/**
 * 装载入口：挂上这条 exact 路由。
 * @param ctx - 宿主上下文（effect / webServer / connection）。
 */
export function apply(ctx: CodexQuotaContext): void {
  registerCodexQuotaRoute(ctx)
}

/**
 * 注册额度路由：官方 /api 同一面准入（admit），成功应答带缓存，
 * 取数失败或形状不认识都折成 200 + `ok:false` + 原因，绝不甩 500。
 * @param ctx - 宿主上下文。
 * @param deps - 可选注入面。
 */
export function registerCodexQuotaRoute(ctx: CodexQuotaContext, deps: CodexQuotaRouteDeps = {}): void {
  const ttlMs = deps.ttlMs ?? CACHE_TTL_MS
  let cached: { at: number; usage: CodexUsage } | undefined
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: QUOTA_ROUTE_PATH,
        async handler(req, res) {
          const admission = ctx.connection.admit(req)
          if ('rejection' in admission) {
            res.writeHead(admission.rejection)
            res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
            return
          }
          if (req.method !== 'GET') {
            res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET' })
            res.end('method not allowed')
            return
          }
          if (cached !== undefined && Date.now() - cached.at < ttlMs) {
            respondJson(res, 200, JSON.stringify({ ok: true, quota: cached.usage }))
            return
          }
          const fetcher = usageFetch ?? defaultUsageFetch
          try {
            const usage = await fetcher()
            if (usage === null) {
              respondJson(res, 200, JSON.stringify({
                ok: false,
                error: 'unrecognised Codex usage answer — no rate-limit window was present',
              }))
              return
            }
            cached = { at: Date.now(), usage }
            respondJson(res, 200, JSON.stringify({ ok: true, quota: usage }))
          } catch (error) {
            respondJson(res, 200, JSON.stringify({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }))
          }
        },
      }),
    'threadharbor-codex-quota: usage route',
  )
}

/** 生产取数器：凭据、地址都在本模块内解析；自带超时信号。 */
export const defaultUsageFetch: CodexUsageFetch = () =>
  withCredential(credential => fetchCodexUsage({ credential, signal: AbortSignal.timeout(USAGE_UPSTREAM_TIMEOUT_MS) }))

/** 读本机凭据后取一次数；读不到凭据不算错——胶囊安静地不出现。 */
async function withCredential(run: (credential: CodexCredential) => Promise<CodexUsage | null>): Promise<CodexUsage | null> {
  const credential = await readCredential()
  if (credential === undefined) return null
  return run(credential)
}

/**
 * 读 `~/.codex/auth.json` 里的 ChatGPT OAuth 令牌。文件不存在或形状不对都
 * 返回 undefined（用户没装/没登录 Codex，胶囊不出现），不抛错。
 */
export async function readCredential(options: { home?: string } = {}): Promise<CodexCredential | undefined> {
  const path = join(options.home ?? homedir(), '.codex', 'auth.json')
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  const tokens = record(record(parsed)?.['tokens'])
  const accessToken = text(tokens?.['access_token'])
  const accountId = text(tokens?.['account_id'])
  if (accessToken === undefined || accountId === undefined) return undefined
  return { accessToken, accountId }
}

/** 问一次 Codex usage，把应答折成窗口与积分。 */
export async function fetchCodexUsage(request: {
  credential: CodexCredential
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}): Promise<CodexUsage | null> {
  const { credential } = request
  const headers = {
    accept: 'application/json',
    authorization: `Bearer ${credential.accessToken}`,
    'chatgpt-account-id': credential.accountId,
    // 防护会拦「过于笼统」的 UA（实测裸 `codex_cli_rs` 回 403），带版本号才放行；
    // 反而别拼平台段（实测 `(Mac OS; arm64)` 这种没版本号的平台段又被拦）。
    'user-agent': `codex_cli_rs/${CODEX_CLI_UA_VERSION}`,
    originator: 'codex_cli_rs',
  }
  // 走 node:https 而不是 fetch：chatgpt.com 的防护按 TLS 指纹拦 undici
  // （2026-11-01 A/B 实测，同一秒同一令牌，fetch 403、经典 https 栈 200）。
  const response = request.fetchImpl === undefined
    ? await httpsGet(USAGE_URL, headers, request.signal)
    : await request.fetchImpl(USAGE_URL, {
      method: 'GET',
      headers,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
  if (!response.ok) {
    const detail = scrub(await Promise.resolve(response.text()).catch(() => ''), credential.accessToken).slice(0, 300)
    throw new Error(`Codex usage request failed (${String(response.status)})${detail === '' ? '' : `: ${detail}`}`)
  }
  let body: unknown
  try {
    body = await response.json()
  } catch (error) {
    throw new Error(scrub(`Codex usage answer was not JSON: ${error instanceof Error ? error.message : String(error)}`, credential.accessToken))
  }
  return parseUsage(body)
}

/** node:https 的最小 GET：与 fetch 同形的应答面（ok / status / json() / text()）。 */
function httpsGet(url: string, headers: Record<string, string>, signal: AbortSignal | undefined): Promise<{ ok: boolean; status: number; json(): unknown; text(): string }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        resolve({
          ok: (res.statusCode ?? 500) >= 200 && (res.statusCode ?? 500) < 300,
          status: res.statusCode ?? 0,
          json() {
            return JSON.parse(body)
          },
          text() {
            return body
          },
        })
      })
    })
    req.on('error', (error) => { reject(error) })
    if (signal !== undefined) {
      const abort = (): void => {
        const aborted = new Error('The operation was aborted')
        aborted.name = 'AbortError'
        req.destroy(aborted)
        reject(aborted)
      }
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    }
    req.end()
  })
}

/** 应答 → 窗口与积分；没有主窗口就算不认识，返回 null（胶囊整行隐藏）。 */
export function parseUsage(body: unknown): CodexUsage | null {
  const root = record(body) ?? {}
  const rateLimit = record(root['rate_limit']) ?? {}
  const planType = text(root['plan_type'])
  const primary = windowOf(rateLimit['primary_window'])
  if (primary === undefined) return null
  const secondary = windowOf(rateLimit['secondary_window'])
  const slots = assignSlots(primary, secondary)
  const credit = creditsOf(record(root['credits']))
  return {
    ...(planType === undefined ? {} : { level: planType }),
    ...(slots.fiveHour === undefined ? {} : { fiveHour: slots.fiveHour }),
    ...(slots.weekly === undefined ? {} : { weekly: slots.weekly }),
    ...(credit === undefined ? {} : { credit }),
  }
}

/** primary/secondary → fiveHour/weekly 两个槽位，各按自己的窗口时长归位。 */
function assignSlots(primary: CodexUsageWindow, secondary: CodexUsageWindow | undefined): { fiveHour?: CodexUsageWindow; weekly?: CodexUsageWindow } {
  const fiveHour = primary.kind === 'five-hour' ? primary : secondary?.kind === 'five-hour' ? secondary : undefined
  const weekly = primary.kind === 'weekly' ? primary : secondary?.kind === 'weekly' ? secondary : undefined
  return {
    ...(fiveHour === undefined ? {} : { fiveHour }),
    ...(weekly === undefined ? {} : { weekly }),
  }
}

/** 一档窗口；秒数决定客户端标签（≈5 小时 → 5小时，≥3 天 → 周）。 */
function windowOf(value: unknown): CodexUsageWindow | undefined {
  const window = record(value)
  const percent = finite(window?.['used_percent'])
  const seconds = finite(window?.['limit_window_seconds'])
  if (percent === undefined || seconds === undefined || seconds <= 0) return undefined
  const resetAt = finite(window?.['reset_at'])
  return {
    kind: seconds >= 3 * 86_400 ? 'weekly' : 'five-hour',
    percent,
    windowSeconds: seconds,
    ...(resetAt === undefined ? {} : { resetAt: resetAt * 1000 }),
  }
}

/** 按量积分：has_credits 或 balance > 0 才显示。 */
function creditsOf(value: Record<string, unknown> | undefined): CodexCredits | undefined {
  const balance = finite(value?.['balance'])
  const has = value?.['has_credits'] === true
  if (!has && (balance === undefined || balance <= 0)) return undefined
  return { balance: balance ?? 0 }
}

function scrub(text: string, secret: string): string {
  if (secret.length < 8) return text
  return text.split(secret).join('[redacted]')
}

/** JSON 应答：no-store（缓存归宿主管）+ 固定长度。 */
function respondJson(res: import('node:http').ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
