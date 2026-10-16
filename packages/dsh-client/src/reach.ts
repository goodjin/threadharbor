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

import { fallbackT, type RuntimeT } from './locales.ts'

/** How one reachability attempt ended. */
export type ReachOutcome =
  | { readonly kind: 'reachable'; readonly ms: number }
  | { readonly kind: 'timeout'; readonly ms: number }
  | { readonly kind: 'unreachable'; readonly reason: string }

/** The fetch face this probe needs, so tests can stand one in. */
export type ReachFetch = (input: string, init: RequestInit) => Promise<unknown>

/**
 * The target a probe will actually hit, port included. A browser fetch of an
 * origin without a port lands on the plain-http default, so the text spells
 * that port out instead of leaving the operator to guess it.
 * @param address - the origin to ask for.
 * @returns the target as actually probed, and whether the address named a port itself.
 */
export function describeProbeTarget(address: string): { readonly text: string; readonly hasPort: boolean } {
  let parsed: URL
  try {
    parsed = new URL(address)
  } catch {
    // 读不出来的地址说不好默认端口：text 照抄，让原因走不做端口断言的那句话。
    return { text: address, hasPort: true }
  }
  if (parsed.port !== '') return { text: address, hasPort: true }
  return { text: `${parsed.protocol}//${parsed.host}:80`, hasPort: false }
}

/**
 * Probe one address once.
 * @param fetcher - the fetch implementation to use.
 * @param address - the origin to ask for; only its reachability is observed.
 * @param timeoutMs - how long to wait before calling it a timeout.
 * @param t - the caller's locale seat; the wording lives in the dictionary.
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
    // 网络层失败按检测目标选话：地址带了端口沿用不猜原因的那句；没带端口把
    // 实际地址和补出来的默认端口说出来，别让操作者猜探的是哪个端口。
    const { hasPort } = describeProbeTarget(address)
    return {
      kind: 'unreachable',
      reason: hasPort
        ? t('panel.reach.networkLayer')
        : t('panel.reach.defaultPort', { url: address }),
    }
  } finally {
    clearTimeout(timer)
  }
}
