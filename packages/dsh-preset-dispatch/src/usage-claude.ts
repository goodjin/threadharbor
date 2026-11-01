/**
 * Claude（Anthropic 官方订阅）的额度，宿主侧读取与转发。
 *
 * 数据链路（2026-11-01 核对，形状以官方 CLI `/usage` 同源接口为准）：
 * 登录凭据是 `claudeAiOauth.accessToken`——Linux/Windows 在
 * `~/.claude/.credentials.json`，macOS 在钥匙串「Claude Code-credentials」
 * （`security find-generic-password -s 'Claude Code-credentials' -w`，只读）。
 * 带上 Bearer 与 `anthropic-beta: oauth-2025-04-20` 问一次
 * `GET https://api.anthropic.com/api/oauth/usage`，拿到：
 *
 * - `five_hour.utilization` / `seven_day.utilization`：0–100 的**已用**百分比。
 * - `five_hour.resets_at` / `seven_day.resets_at`：RFC3339 重置时刻。
 * - `extra_usage`：按量付费积分（`is_enabled` 开着才显示）。
 *
 * 两个必须守住的点：这个接口**自己有冷却**——问太勤回 429（Retry-After 约
 * 160 秒），所以宿主侧缓存默认拉长到 2 分钟；令牌只在本进程内存里用，
 * 抛出的错误一律脱敏。用户走中转站（`ANTHROPIC_BASE_URL`）没登官方 OAuth 时，
 * 凭据读不到——胶囊安静地不出现，不算错误。
 */

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

export const name = 'threadharbor-claude-quota'

/** webServer 挂路由；connection 做准入（admit）。 */
export const inject = ['webServer', 'connection']

/** exact 路由路径；浏览器侧的胶囊按这个常量取数。 */
export const QUOTA_ROUTE_PATH = '/threadharbor/claude/quota'

/**
 * 成功应答的缓存时长。上游接口自带冷却（429，Retry-After 约 160 秒），
 * 缓存按 2 分钟起步，多标签页轮询也顶不到冷却线。
 */
const CACHE_TTL_MS = 120_000

/** 取数超时：挂住的上游不该把这一路接口一起挂住。 */
export const USAGE_UPSTREAM_TIMEOUT_MS = 15_000

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const KEYCHAIN_SERVICE = 'Claude Code-credentials'

/** 一档已消耗窗口。 */
export type ClaudeUsageWindow = {
  readonly kind: 'five-hour' | 'weekly'
  /** 已用百分比（Claude 的口径是已用，越高越红）。 */
  readonly percent: number
  readonly resetAt?: number
}

/** 按量付费积分，开着才显示。 */
export type ClaudeExtraUsage = {
  readonly used: number
  readonly limit?: number
}

/** 一次取数的答案（与宿主路由应答里的 `quota` 同形）。 */
export type ClaudeUsage = {
  readonly level?: string
  readonly fiveHour?: ClaudeUsageWindow
  readonly weekly?: ClaudeUsageWindow
  readonly credit?: ClaudeExtraUsage
}

/** 本机凭据（测试直接注入，绕开真实文件与钥匙串）。 */
export type ClaudeCredential = {
  readonly accessToken: string
}

/** 取一次额度的最小面：无参进去，额度或 null 出来，失败抛错（消息已脱敏）。 */
export type ClaudeUsageFetch = () => Promise<ClaudeUsage | null>

/** 模块级可替换的取数器：生产走真凭据真网络，测试换假件。 */
let usageFetch: ClaudeUsageFetch | undefined

/**
 * 换取数器（测试注入假件）；传回 `undefined` 恢复真件。
 * @param next - 下一只取数器，或 `undefined` 恢复生产实现。
 */
export function swapUsageFetch(next: ClaudeUsageFetch | undefined): void {
  usageFetch = next
}

/** 测试注入面：换钥匙串读取实现（生产用 `security`）。 */
export type KeychainReader = () => Promise<string | undefined>

let keychainReader: KeychainReader | undefined

/**
 * 换钥匙串读取实现（测试注入假件）；传回 `undefined` 恢复生产实现。
 * @param next - 下一只读取器，或 `undefined` 恢复生产实现。
 */
export function swapKeychainReader(next: KeychainReader | undefined): void {
  keychainReader = next
}

/** 本入口需要的宿主面（窄接口，测试立桩照这个来）。 */
export interface ClaudeQuotaContext {
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
export interface ClaudeQuotaRouteDeps {
  /** 成功应答的缓存时长（毫秒）；缺省 2 分钟（上游接口自带冷却）。 */
  ttlMs?: number
}

/**
 * 装载入口：挂上这条 exact 路由。
 * @param ctx - 宿主上下文（effect / webServer / connection）。
 */
export function apply(ctx: ClaudeQuotaContext): void {
  registerClaudeQuotaRoute(ctx)
}

/**
 * 注册额度路由：官方 /api 同一面准入（admit），成功应答带缓存，
 * 取数失败或形状不认识都折成 200 + `ok:false` + 原因，绝不甩 500。
 * @param ctx - 宿主上下文。
 * @param deps - 可选注入面。
 */
export function registerClaudeQuotaRoute(ctx: ClaudeQuotaContext, deps: ClaudeQuotaRouteDeps = {}): void {
  const ttlMs = deps.ttlMs ?? CACHE_TTL_MS
  let cached: { at: number; usage: ClaudeUsage } | undefined
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
                error: 'unrecognised Claude usage answer — no five-hour or weekly window was present',
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
    'threadharbor-claude-quota: usage route',
  )
}

/** 生产取数器：凭据、地址都在本模块内解析；自带超时信号。 */
export const defaultUsageFetch: ClaudeUsageFetch = () =>
  withCredential(credential => fetchClaudeUsage({ credential, signal: AbortSignal.timeout(USAGE_UPSTREAM_TIMEOUT_MS) }))

/** 读本机凭据后取一次数；读不到凭据不算错——胶囊安静地不出现。 */
async function withCredential(run: (credential: ClaudeCredential) => Promise<ClaudeUsage | null>): Promise<ClaudeUsage | null> {
  const credential = await readCredential()
  if (credential === undefined) return null
  return run(credential)
}

/**
 * 读本机 Claude OAuth 令牌：先看 `~/.claude/.credentials.json`（文件优先），
 * 没有再读 macOS 钥匙串。都没有 → undefined（用户没登官方 OAuth，比如走
 * 中转站），胶囊不出现，不抛错。只读，绝不刷新或回写凭据。
 */
export async function readCredential(options: { home?: string } = {}): Promise<ClaudeCredential | undefined> {
  const fromFile = await readCredentialFile(options.home ?? homedir())
  if (fromFile !== undefined) return fromFile
  return readCredentialKeychain()
}

/** 文件凭据：`{"claudeAiOauth":{"accessToken":…}}`。 */
async function readCredentialFile(home: string): Promise<ClaudeCredential | undefined> {
  let raw: string
  try {
    raw = await readFile(join(home, '.claude', '.credentials.json'), 'utf8')
  } catch {
    return undefined
  }
  return credentialOf(raw)
}

/** 钥匙串凭据：`security find-generic-password -s 'Claude Code-credentials' -w`。 */
async function readCredentialKeychain(): Promise<ClaudeCredential | undefined> {
  const reader = keychainReader ?? defaultKeychainReader
  const raw = await reader()
  if (raw === undefined) return undefined
  return credentialOf(raw)
}

async function defaultKeychainReader(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileP('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], { timeout: 5_000 })
    return stdout.trim() === '' ? undefined : stdout
  } catch {
    // 钥匙串没有这一项、或用户拒绝访问：当没登录处理。
    return undefined
  }
}

/** 凭据 JSON → accessToken；没有就 undefined。 */
function credentialOf(raw: string): ClaudeCredential | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  const accessToken = text(record(record(parsed)?.['claudeAiOauth'])?.['accessToken'])
  if (accessToken === undefined) return undefined
  return { accessToken }
}

/** 问一次 Claude usage，把应答折成两档窗口与按量积分。 */
export async function fetchClaudeUsage(request: {
  credential: ClaudeCredential
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}): Promise<ClaudeUsage | null> {
  const { credential } = request
  const fetchImpl = request.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchImpl(USAGE_URL, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${credential.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
      },
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    throw new Error(scrub(error instanceof Error ? error.message : String(error), credential.accessToken))
  }
  if (!response.ok) {
    const detail = scrub(await response.text().catch(() => ''), credential.accessToken).slice(0, 300)
    throw new Error(`Claude usage request failed (${String(response.status)})${detail === '' ? '' : `: ${detail}`}`)
  }
  let body: unknown
  try {
    body = await response.json()
  } catch (error) {
    throw new Error(scrub(`Claude usage answer was not JSON: ${error instanceof Error ? error.message : String(error)}`, credential.accessToken))
  }
  return parseUsage(body)
}

/** 应答 → 两档窗口与按量积分；两档都没有就算不认识，返回 null。 */
export function parseUsage(body: unknown): ClaudeUsage | null {
  const root = record(body) ?? {}
  const fiveHour = windowOf(root['five_hour'], 'five-hour')
  const weekly = windowOf(root['seven_day'], 'weekly')
  if (fiveHour === undefined && weekly === undefined) return null
  const extra = record(root['extra_usage'])
  const credit = extra?.['is_enabled'] === true
    ? {
        used: finite(extra['used_credits']) ?? 0,
        ...(finite(extra['monthly_limit']) === undefined ? {} : { limit: finite(extra['monthly_limit']) as number }),
      }
    : undefined
  return {
    ...(fiveHour === undefined ? {} : { fiveHour }),
    ...(weekly === undefined ? {} : { weekly }),
    ...(credit === undefined ? {} : { credit }),
  }
}

/** 一档窗口；utilization 是已用百分比，resets_at 是 RFC3339。 */
function windowOf(value: unknown, kind: 'five-hour' | 'weekly'): ClaudeUsageWindow | undefined {
  const window = record(value)
  const percent = finite(window?.['utilization'])
  if (percent === undefined) return undefined
  const resetsAt = text(window?.['resets_at'])
  const resetAt = resetsAt === undefined ? undefined : Date.parse(resetsAt)
  return {
    kind,
    percent,
    ...(resetAt === undefined || Number.isNaN(resetAt) ? {} : { resetAt }),
  }
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
