import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  apply,
  Config,
  inject,
  name,
  RELAY_HOSTS_PATH,
  type MobileRelayConfig,
  type RelayMachineConfig,
  type RelayRouteContext,
} from '../src/index.ts'

/**
 * 骨架装载用例：中转包要作为组合行装载，装载器读到的是 `name` / `inject` /
 * `Config` / `apply` 四件套；配置坏不坏在装载期见分晓。宿主面在单测里拿不到，
 * 用最小桩捕获注册调用（照 dsh-mobile-entry 的 pair-url.spec.ts 同款写法）。
 */
describe('Config 的形状校验（schemastery，装载第一道门）', () => {
  it('合法配置解析后字段原样保留', () => {
    const config = {
      mobileOrigin: 'https://relay.example.com',
      sshKnownHostsPath: '/home/relay/.ssh/known_hosts',
      statePath: '/home/relay/.threadharbor-relay/state.json',
      machines: [{ hostId: 'gooddemacbook-pro', target: '100.64.0.2', remotePort: 3081, logPath: '/var/log/dsh.log' }],
    }
    expect(Config(config)).toEqual(config)
  })

  it('可选字段全部缺省也通过（顶层四项与机器的 hostId/target/remotePort/logPath 必填，其余可缺）', () => {
    const config = { mobileOrigin: 'https://relay.example.com', sshKnownHostsPath: '/k', statePath: '/s', machines: [] }
    expect(Config(config)).toEqual(config)
  })

  it('机器的 port/user/identityFile 缺省也通过', () => {
    const config = {
      mobileOrigin: 'https://relay.example.com',
      sshKnownHostsPath: '/k',
      statePath: '/s',
      machines: [{ hostId: 'mac-a', target: '100.64.0.2', remotePort: 3081, logPath: '/l.log' }],
    }
    expect(Config(config)).toEqual(config)
  })

  it.each([
    ['http 明文 origin', 'http://relay.example.com'],
    ['origin 带路径', 'https://relay.example.com/x'],
  ])('mobileOrigin 形状坏值（%s）解析抛错', (_label, value) => {
    expect(() =>
      Config({ mobileOrigin: value, sshKnownHostsPath: '/k', statePath: '/s', machines: [] }),
    ).toThrow()
  })

  it.each([
    ['hostId 为空字符串', { hostId: '', target: '100.64.0.2', remotePort: 3081, logPath: '/var/log/dsh.log' }],
    ['hostId 含空白', { hostId: 'good macbook', target: '100.64.0.2', remotePort: 3081, logPath: '/var/log/dsh.log' }],
    ['target 为空字符串', { hostId: 'gooddemacbook-pro', target: '', remotePort: 3081, logPath: '/var/log/dsh.log' }],
    ['target 含空白', { hostId: 'gooddemacbook-pro', target: '100.64.0.2 -J jump', remotePort: 3081, logPath: '/var/log/dsh.log' }],
    ['remotePort 为 0', { hostId: 'gooddemacbook-pro', target: '100.64.0.2', remotePort: 0 }],
    ['remotePort 越界 65536', { hostId: 'gooddemacbook-pro', target: '100.64.0.2', remotePort: 65536 }],
    ['remotePort 非整数', { hostId: 'gooddemacbook-pro', target: '100.64.0.2', remotePort: 3081.5 }],
  ])('machines 逐项坏值（%s）解析抛错', (_label, machine) => {
    expect(() =>
      Config({
        sshKnownHostsPath: '/k',
        statePath: '/s',
        machines: [machine as RelayMachineConfig],
      }),
    ).toThrow()
  })

  it.each([
    ['sshKnownHostsPath 为空', { sshKnownHostsPath: '', statePath: '/s', machines: [] }],
    ['statePath 为空', { sshKnownHostsPath: '/k', statePath: '', machines: [] }],
  ])('%s解析抛错', (_label, config) => {
    expect(() => Config(config as unknown as MobileRelayConfig)).toThrow()
  })
})

/** apply 需要的宿主面在单测里拿不到，用最小桩捕获注册调用。 */
type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
interface CapturedRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: RouteHandler
}

const FAKE_PEER = { role: 'operator' }

interface RelayConnectionOptions {
  rejection?: 401 | 403
}

function fakeRelayConnection(options: RelayConnectionOptions = {}) {
  const calls = { admit: [] as Array<{ headers?: Record<string, string> }> }
  const connection = {
    admit(request: { headers?: Record<string, string> }) {
      calls.admit.push(request)
      return options.rejection === undefined ? { peer: FAKE_PEER } : { rejection: options.rejection }
    },
  }
  return { calls, connection }
}

/** 跑一遍 apply，捕获挂上的全部路由；装载抛错由用例自己断言。 */
function captureAppliedRoutes(config: MobileRelayConfig | undefined, options: RelayConnectionOptions = {}) {
  const routes: CapturedRoute[] = []
  const { calls, connection } = fakeRelayConnection(options)
  const ctx = {
    effect(factory: () => unknown, _label?: string) {
      factory()
    },
    webServer: {
      register(route: CapturedRoute) {
        routes.push(route)
        return () => {}
      },
    },
    connection,
  }
  return {
    run: () => apply(ctx as unknown as RelayRouteContext, config),
    routes,
    calls,
  }
}

/**
 * 真实装配会构造 SSH 管理器，它在装载期就要把 known_hosts 的目录建出来——所以
 * 这里的路径必须可写（临时目录），别用 `/home/relay` 这种装起来必然失败的值。
 */
const VALID_CONFIG: MobileRelayConfig = {
  mobileOrigin: 'https://relay.example.com',
  sshKnownHostsPath: join(mkdtempSync(join(tmpdir(), 'relay-load-')), 'known_hosts'),
  statePath: join(mkdtempSync(join(tmpdir(), 'relay-load-state-')), 'state.json'),
  machines: [{ hostId: 'gooddemacbook-pro', target: '100.64.0.2', remotePort: 3081, logPath: '/var/log/dsh.log' }],
}

describe('apply 的装载行为', () => {
  it('导出名与注入面和组合行对齐；合法配置只挂 /threadharbor/relay/hosts 一条路由', () => {
    expect(name).toBe('threadharbor-mobile-relay')
    expect(inject).toContain('webServer')
    expect(inject).toContain('connection')
    const { run, routes } = captureAppliedRoutes(VALID_CONFIG)
    expect(run).not.toThrow()
    expect(routes).toHaveLength(1)
    expect(routes[0]?.kind).toBe('exact')
    expect(routes[0]?.path).toBe(RELAY_HOSTS_PATH)
    expect(RELAY_HOSTS_PATH).toBe('/threadharbor/relay/hosts')
  })

  it('mobileOrigin 非规范化（大写 authority）：形状门放行，装载抛错且一条路由都不注册', () => {
    const { run, routes } = captureAppliedRoutes({ ...VALID_CONFIG, mobileOrigin: 'https://Example.COM' })
    expect(run).toThrow(/规范化/)
    expect(routes).toHaveLength(0)
  })

  it('两台机器 hostId 重复：装载抛错且一条路由都不注册', () => {
    const config: MobileRelayConfig = {
      ...VALID_CONFIG,
      machines: [
        { hostId: 'gooddemacbook-pro', target: '100.64.0.2', remotePort: 3081, logPath: '/var/log/dsh.log' },
        { hostId: 'gooddemacbook-pro', target: '100.64.0.3', remotePort: 3082, logPath: '/var/log/dsh.log' },
      ],
    }
    const { run, routes } = captureAppliedRoutes(config)
    expect(run).toThrow(/重复/)
    expect(routes).toHaveLength(0)
  })

  it.each([
    ['含大写字母', 'GoodMacBook-Pro'],
    ['含尾点', 'gooddemacbook-pro.'],
    ['含空白', 'good macbook'],
  ])('hostId %s：装载抛错且一条路由都不注册', (_label, hostId) => {
    const { run, routes } = captureAppliedRoutes({ ...VALID_CONFIG, machines: [{ hostId, target: '100.64.0.2', remotePort: 3081, logPath: '/var/log/dsh.log' }] })
    expect(run).toThrow()
    expect(routes).toHaveLength(0)
  })

  it('mobileOrigin 缺省：装载抛错且一条路由都不注册（没有 origin 就没法做 origin 绑定）', () => {
    const { run, routes } = captureAppliedRoutes({ ...VALID_CONFIG, mobileOrigin: undefined as unknown as string })
    expect(run).toThrow(/mobileOrigin/)
    expect(routes).toHaveLength(0)
  })

  it.each(['sshKnownHostsPath', 'statePath', 'machines'] as const)(
    '%s 缺省：装载抛错说清缺哪个字段，且一条路由都不注册',
    key => {
      // 缺 statePath 时旧代码是「装载成功、之后每拍在 dirname(undefined) 处炸、
      // 被 allSettled 吃掉」——方向是静默的：全机永远不可达且清单里没有 error。
      const { run, routes } = captureAppliedRoutes({ ...VALID_CONFIG, [key]: undefined } as MobileRelayConfig)
      expect(run).toThrow(new RegExp(key))
      expect(routes).toHaveLength(0)
    },
  )

  it('配置块整个没给：装载抛错并说清缺配置，而不是一个 dirname(undefined)', () => {
    const { run, routes } = captureAppliedRoutes(undefined)
    expect(run).toThrow(/缺配置/)
    expect(routes).toHaveLength(0)
    const { run: runNull, routes: routesNull } = captureAppliedRoutes(null as unknown as MobileRelayConfig)
    expect(runNull).toThrow(/缺配置/)
    expect(routesNull).toHaveLength(0)
  })

  it.each([
    ['user 含 shell 元字符', { user: 'hello; rm -rf /' }],
    ['identityFile 含 shell 元字符', { identityFile: '/k; touch /tmp/pwn' }],
    ['identityFile 含反引号', { identityFile: '`id`' }],
  ])('%s：装载抛错且一条路由都不注册', (_label, extra) => {
    const { run, routes } = captureAppliedRoutes({
      ...VALID_CONFIG,
      machines: [{ hostId: 'gooddemacbook-pro', target: '100.64.0.2', remotePort: 3081, logPath: '/l.log', ...extra } as RelayMachineConfig],
    })
    expect(run).toThrow()
    expect(routes).toHaveLength(0)
  })

  it.each([
    ['port 为 0', 0],
    ['port 越界 65536', 65536],
    ['port 非整数', 2222.5],
  ])('%s：形状门就拒（评审 I4：SSH 端口取值不当装载放过、首拍才以难懂错误失败）', (_label, port) => {
    expect(() =>
      Config({
        mobileOrigin: 'https://relay.example.com',
        sshKnownHostsPath: '/k',
        statePath: '/s',
        machines: [{ hostId: 'gooddemacbook-pro', target: '100.64.0.2', remotePort: 3081, logPath: '/l.log', port }],
      }),
    ).toThrow()
  })

  it.each(['sshKnownHostsPath', 'statePath', 'machines'] as const)('顶层 %s 缺省：形状门就拒', key => {
    expect(() =>
      Config({ mobileOrigin: 'https://relay.example.com', sshKnownHostsPath: '/k', statePath: '/s', machines: [], [key]: undefined }),
    ).toThrow()
  })

  it('logPath 缺省：形状门就拒（每台的启动日志路径不统一，不给默认值猜）', () => {
    expect(() =>
      Config({
        mobileOrigin: 'https://relay.example.com',
        sshKnownHostsPath: '/k',
        statePath: '/s',
        machines: [{ hostId: 'gooddemacbook-pro', target: '100.64.0.2', remotePort: 3081 }],
      }),
    ).toThrow()
  })

  it('sshKnownHostsPath 含 shell 元字符：装载抛错', () => {
    const { run, routes } = captureAppliedRoutes({ ...VALID_CONFIG, sshKnownHostsPath: '/k; touch /tmp/pwn' })
    expect(run).toThrow()
    expect(routes).toHaveLength(0)
  })
})

/** 直接调用 handler，收下它对响应生命周期的完整处置。 */
function call(handler: RouteHandler, req: { method?: string; url?: string; headers?: Record<string, string> }) {
  const state = { status: 0, headers: {} as Record<string, string | number | string[] | undefined>, body: '' }
  const res = {
    writeHead(status: number, headers?: Record<string, string | number | string[]>) {
      state.status = status
      Object.assign(state.headers, headers ?? {})
    },
    end(chunk?: string) {
      state.body = chunk ?? ''
    },
  }
  handler(req as IncomingMessage, res as unknown as ServerResponse)
  return state
}

describe('/threadharbor/relay/hosts 的准入与方法处置（骨架契约，装配行为在 assemble.spec.ts）', () => {
  function hostsHandlerOf(config: MobileRelayConfig | undefined = VALID_CONFIG, options: RelayConnectionOptions = {}) {
    const { run, routes } = captureAppliedRoutes(config, options)
    run()
    const route = routes.find(entry => entry.path === RELAY_HOSTS_PATH)
    if (route === undefined) throw new Error('hosts 路由未挂上')
    return route.handler
  }

  it('admit 拒绝 401 → 短体 unauthorized（官方写法）', () => {
    const state = call(hostsHandlerOf(VALID_CONFIG, { rejection: 401 }), {
      method: 'GET',
      url: RELAY_HOSTS_PATH,
      headers: {},
    })
    expect(state.status).toBe(401)
    expect(state.body).toBe('unauthorized')
  })

  it('admit 拒绝 403 → 短体 forbidden（官方写法）', () => {
    const state = call(hostsHandlerOf(VALID_CONFIG, { rejection: 403 }), {
      method: 'GET',
      url: RELAY_HOSTS_PATH,
      headers: {},
    })
    expect(state.status).toBe(403)
    expect(state.body).toBe('forbidden')
  })

  it('已准入的非 GET → 405', () => {
    const state = call(hostsHandlerOf(), { method: 'POST', url: RELAY_HOSTS_PATH, headers: {} })
    expect(state.status).toBe(405)
    expect(state.headers['allow']).toBe('GET')
  })
})
