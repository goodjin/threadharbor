import { describe, expect, it } from 'vitest'
import { authorizeMobileIndex } from '../src/pairing.ts'

/** 收下官方 authorizeIndex 对响应生命周期的处置（303 / 401 都在这里显形）。 */
function fakeRes() {
  const state = { status: 0, headers: {} as Record<string, unknown>, body: '' }
  const res = {
    writeHead(status: number, headers?: Record<string, string | number | string[]>) {
      state.status = status
      Object.assign(state.headers, headers ?? {})
    },
    end(chunk?: string) {
      state.body = chunk ?? ''
    },
  }
  return { state, res }
}

/**
 * fake connection 实现官方 authorizeIndex 的带令牌分支语义（对照 DSH 参考源码
 * packages/client/connection/src/browser-auth.ts：查询串带 token 时——
 * GET + 根路径 + 令牌值等于 launchToken → 铸 cookie 并 303 到 `./`，返回 false；
 * 其余带令牌（含 HEAD、无效令牌、空值令牌）→ 最小 401，返回 false。
 * 两种分支都接管响应。无令牌分支官方虽存在，但封装契约规定无令牌不得委托：
 * 到达即抛错，让测试大声失败。
 */
function fakeConnection(options: { launchToken: string }) {
  const calls: Array<{ request: unknown; response: unknown }> = []
  const connection = {
    authorizeIndex(request: unknown, response: unknown): boolean {
      calls.push({ request, response })
      const req = request as { method?: string; url?: string }
      const res = response as ReturnType<typeof fakeRes>['res']
      const url = new URL(req.url ?? '/', 'http://dsh.invalid')
      const tokens = url.searchParams.getAll('token')
      if (tokens.length > 0) {
        if (req.method === 'GET' && url.pathname === '/' && tokens.join('') === options.launchToken) {
          res.writeHead(303, { location: './', 'set-cookie': 'dsh-session=fake-cookie' })
          res.end()
          return false
        }
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('dsh web authentication required\n')
        return false
      }
      throw new Error('封装在无令牌时调用了 connection（应返回 serve 且不碰 connection）')
    },
  }
  return { calls, connection }
}

describe('authorizeMobileIndex（配对交换封装）', () => {
  it('带令牌：url 改写为 /?原查询串 委托，官方接管响应（303+cookie），返回 owned', () => {
    const { calls, connection } = fakeConnection({ launchToken: 'abc123' })
    const { state, res } = fakeRes()
    const headers = { host: 'mac1.example.ts.net', 'user-agent': 'test' }
    const req = { method: 'GET', url: '/threadharbor/mobile/?token=abc123&x=1', headers }

    const outcome = authorizeMobileIndex(req, res, connection)

    expect(outcome).toBe('owned')
    expect(calls).toHaveLength(1)
    const seen = calls[0]!.request as { method: string; url: string; headers: Record<string, string> }
    expect(seen.url).toBe('/?token=abc123&x=1')
    expect(seen.method).toBe('GET')
    expect(seen.headers).toBe(headers)
    expect(seen.headers['host']).toBe('mac1.example.ts.net')
    expect(calls[0]!.response).toBe(res)
    expect(req.url).toBe('/threadharbor/mobile/?token=abc123&x=1')
    expect(state.status).toBe(303)
    expect(state.headers['location']).toBe('./')
    expect(state.headers['set-cookie']).toContain('dsh-session=fake-cookie')
  })

  it('带无效令牌：同样委托到 /?原查询串，官方写 401 接管，仍返回 owned', () => {
    const { calls, connection } = fakeConnection({ launchToken: 'abc123' })
    const { state, res } = fakeRes()

    const outcome = authorizeMobileIndex(
      { method: 'GET', url: '/threadharbor/mobile/?token=expired', headers: { host: 'h' } },
      res,
      connection,
    )

    expect(outcome).toBe('owned')
    expect(calls).toHaveLength(1)
    expect((calls[0]!.request as { url: string }).url).toBe('/?token=expired')
    expect(state.status).toBe(401)
    expect(state.body).toContain('authentication required')
  })

  it('无令牌：返回 serve 且绝不调用 connection，响应不被触碰', () => {
    const { calls, connection } = fakeConnection({ launchToken: 'abc123' })
    const { state, res } = fakeRes()

    for (const url of ['/threadharbor/mobile/', '/threadharbor/mobile', '/threadharbor/mobile/?v=1']) {
      const outcome = authorizeMobileIndex({ method: 'GET', url, headers: {} }, res, connection)
      expect(outcome, url).toBe('serve')
    }

    expect(calls).toHaveLength(0)
    expect(state.status).toBe(0)
    expect(state.body).toBe('')
  })

  it('HEAD 带令牌：照样委托（官方按非 GET 不交换、写 401），返回 owned', () => {
    const { calls, connection } = fakeConnection({ launchToken: 'abc123' })
    const { state, res } = fakeRes()

    const outcome = authorizeMobileIndex(
      { method: 'HEAD', url: '/threadharbor/mobile/?token=abc123', headers: { host: 'h' } },
      res,
      connection,
    )

    expect(outcome).toBe('owned')
    expect(calls).toHaveLength(1)
    expect((calls[0]!.request as { url: string }).url).toBe('/?token=abc123')
    expect(state.status).toBe(401)
  })

  it('空值令牌（?token=）也算带令牌：委托官方处置，与官方存在性判定一致', () => {
    const { calls, connection } = fakeConnection({ launchToken: 'abc123' })
    const { state, res } = fakeRes()

    const outcome = authorizeMobileIndex(
      { method: 'GET', url: '/threadharbor/mobile/?token=', headers: {} },
      res,
      connection,
    )

    expect(outcome).toBe('owned')
    expect(calls).toHaveLength(1)
    expect((calls[0]!.request as { url: string }).url).toBe('/?token=')
    expect(state.status).toBe(401)
  })
})
