/**
 * 配对交换封装：把手机页上的带令牌到访改写成「请求路径视为根」后，
 * 委托官方 `connection.authorizeIndex` 完成令牌换 cookie。
 *
 * 官方语义（对照 DSH 参考源码 packages/client/connection/src/browser-auth.ts，
 * 2026-10-15 核对）：查询串带 token 时官方按分支处置并接管响应——GET + 根路径 +
 * 单个有效令牌 → 铸 cookie 并 303 到 `./`（相对重定向由浏览器按原请求路径解析，
 * 正好落回手机页）；GET + 根路径 + cookie 有效 → 303 到 `./`；其余（含 HEAD、
 * 无效令牌）→ 官方已写完一个最小 401。也就是说：只要查询串带 token，响应就
 * 归官方所有，因此委托后一律返回 'owned'，调用方直接返回、不再出字节。
 * 查询串不带 token 时不委托：手机页应用壳公开服务（配对状态由页面 JS 后续
 * 探测，不在这里判定）。
 *
 * 封装不接触 cookie、密钥与令牌值本身：只改写 url、原样保留 method 与 headers。
 */

/** 官方 authorizeIndex 可能写到的最小响应面；封装只透传，从不调用。 */
export interface MinimalIndexResponse {
  writeHead(status: number, headers?: Record<string, string | number | string[]>): unknown
  end(chunk?: string): unknown
}

/** 本任务用到的官方 connection 服务面：只有 authorizeIndex。 */
export interface AuthorizeIndexConnection {
  authorizeIndex(request: unknown, response: unknown): boolean
}

/** 封装结论：'owned' = 官方已接管响应，调用方直接返回；'serve' = 调用方服务应用壳。 */
export type MobileIndexOutcome = 'owned' | 'serve'

/** 官方令牌查询参数名；只判存在，不读值。 */
const TOKEN_QUERY = 'token'

/**
 * 判定手机页 index 到访的处置。
 *
 * 查询串带令牌 → 构造浅封装请求（url 改写为 `/?<原查询串>`，method 与 headers
 * 原样保留；查询串逐字节保留、不重新序列化，令牌值不会被改动）委托官方
 * authorizeIndex，无论官方走哪个分支都返回 'owned'。查询串不带令牌 →
 * 不碰 connection，直接返回 'serve'。
 *
 * @param req - 原始请求的最小面（不会被改动）。
 * @param res - 官方 authorizeIndex 可能写到的响应，原样透传。
 * @param connection - 官方 connection 服务面。
 */
export function authorizeMobileIndex(
  req: { method: string; url: string; headers: Record<string, string> },
  res: MinimalIndexResponse,
  connection: AuthorizeIndexConnection,
): MobileIndexOutcome {
  const url = new URL(req.url, 'http://threadharbor.invalid')
  if (!url.searchParams.has(TOKEN_QUERY)) return 'serve'
  connection.authorizeIndex(
    { method: req.method, headers: req.headers, url: `/${url.search}` },
    res,
  )
  return 'owned'
}
