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
 */

/** How one reachability attempt ended. */
export type ReachOutcome =
  | { readonly kind: 'reachable'; readonly ms: number }
  | { readonly kind: 'timeout'; readonly ms: number }
  | { readonly kind: 'unreachable'; readonly reason: string }

/** The fetch face this probe needs, so tests can stand one in. */
export type ReachFetch = (input: string, init: RequestInit) => Promise<unknown>

/**
 * Probe one address once.
 * @param fetcher - the fetch implementation to use.
 * @param address - the origin to ask for; only its reachability is observed.
 * @param timeoutMs - how long to wait before calling it a timeout.
 * @returns one of the three outcomes; never throws.
 */
export async function probeReach(fetcher: ReachFetch, address: string, timeoutMs: number): Promise<ReachOutcome> {
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
    return {
      kind: 'unreachable',
      reason: name === 'TypeError'
        ? '网络层失败：地址不可达、端口没有监听，或浏览器拦下了这个请求'
        : `请求失败：${name}`,
    }
  } finally {
    clearTimeout(timer)
  }
}
