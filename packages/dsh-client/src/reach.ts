/**
 * Whether another host's address answers at all, asked the only way a browser
 * may ask.
 *
 * A page on one origin cannot read another origin's responses — no CORS header,
 * no shared cookie — so "can this page reach that host?" has exactly one
 * honest form here: a `no-cors` fetch, which resolves with an opaque response
 * on any HTTP answer and rejects on a network-layer failure. What that buys is
 * real and narrow: it separates 「地址错了 / 没监听 / 网络不通」 from 「端口上
 * 有东西应答」. It cannot confirm the answer came from DSH, and it cannot check
 * the token — the wording everywhere around this probe says so.
 *
 * The wording itself lives in the locale dictionary (`locales.ts`) like every
 * other piece of product copy; this module cannot call `t` on its own, so the
 * caller's seat rides in as a parameter, and a failure reason names the
 * address and port that were actually tried.
 */

import { fallbackT } from './locales.ts'
import type { RuntimeT } from './locales.ts'

/** How one reachability attempt ended. */
export type ReachOutcome =
  | { readonly kind: 'reachable'; readonly ms: number }
  | { readonly kind: 'timeout'; readonly ms: number }
  | { readonly kind: 'unreachable'; readonly reason: string }

/** The fetch face this probe needs, so tests can stand one in. */
export type ReachFetch = (input: string, init: RequestInit) => Promise<unknown>

/**
 * The target a probe will actually hit, port included. A browser fetch of an
 * origin without a port lands on the scheme's default — http 80, https 443 —
 * so the text spells that port out instead of leaving the operator to guess
 * it. An address whose scheme has no such default (or that cannot be parsed
 * at all) yields no `defaultPort`: the caller then falls back to the sentence
 * that asserts no port rather than naming one that would not be hit.
 * @param address - the origin to ask for.
 * @returns the target as actually probed, whether the address named a port itself, and the implied default port when there is one.
 */
export function describeProbeTarget(address: string): {
  readonly text: string
  readonly hasPort: boolean
  /** 地址没写端口时按 scheme 补的默认端口（http 80、https 443）；说不出默认端口时没有。 */
  readonly defaultPort: number | undefined
} {
  let parsed: URL
  try {
    parsed = new URL(address)
  } catch {
    // 读不出来的地址说不好默认端口：text 照抄，让原因走不做端口断言的那句话。
    return { text: address, hasPort: false, defaultPort: undefined }
  }
  if (parsed.port !== '') return { text: address, hasPort: true, defaultPort: undefined }
  const scheme = parsed.protocol.replace(/:$/, '')
  const defaultPort = scheme === 'http' ? 80 : scheme === 'https' ? 443 : undefined
  return {
    text: defaultPort === undefined ? address : `${parsed.protocol}//${parsed.host}:${defaultPort}`,
    hasPort: false,
    defaultPort,
  }
}

/**
 * Probe one address once.
 * @param fetcher - the fetch implementation to use.
 * @param address - the origin to ask for; only its reachability is observed.
 * @param timeoutMs - how long to wait before calling it a timeout.
 * @param t - reads the unreachable reasons in the active language; absent
 * (tests, no locale service) it falls back to the dictionary's source text.
 * @returns one of the three outcomes; never throws.
 */
export async function probeReach(fetcher: ReachFetch, address: string, timeoutMs: number, t: RuntimeT = fallbackT): Promise<ReachOutcome> {
  const controller = new AbortController()
  const started = Date.now()
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  try {
    await fetcher(address, {
      method: 'GET',
      mode: 'no-cors',
      cache: 'no-store',
      signal: controller.signal,
    })
    return { kind: 'reachable', ms: Date.now() - started }
  } catch (error: unknown) {
    const elapsed = Date.now() - started
    if (controller.signal.aborted) return { kind: 'timeout', ms: elapsed }
    const name = error instanceof Error ? error.name : String(error)
    if (name !== 'TypeError') return { kind: 'unreachable', reason: t('panel.reach.requestFailed', { name }) }
    // 网络层失败按检测目标选话：地址带了端口（或说不出默认端口）沿用不猜
    // 原因的那句；没写端口的把实际地址和按 scheme 补出来的默认端口说出来。
    const target = describeProbeTarget(address)
    if (target.hasPort || target.defaultPort === undefined) {
      return { kind: 'unreachable', reason: t('panel.reach.networkFailure') }
    }
    return { kind: 'unreachable', reason: t('panel.reach.defaultPort', { url: address, port: target.defaultPort }) }
  } finally {
    clearTimeout(timer)
  }
}
