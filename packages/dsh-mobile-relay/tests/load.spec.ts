import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  apply,
  Config,
  inject,
  makeRelayLogger,
  name,
  RELAY_HOSTS_PATH,
  type MobileRelayConfig,
  type RelayAssemblyDeps,
  type RelayMachineConfig,
  type RelayRouteContext,
} from '../src/index.ts'
import { Relay } from '../src/relay.ts'
import { TunnelPool } from '../src/tunnels.ts'

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
  it('导出名与注入面和组合行对齐；合法配置挂三条路由（清单 / 会话 prefix / 应答）', () => {
    // 挂几条是接线契约的一部分：少一条是功能缺失，多一条是有人复制粘贴。
    const { run, routes } = captureAppliedRoutes(VALID_CONFIG)
    run()
    expect(routes.map(route => `${route.kind} ${route.path}`)).toEqual([
      'exact /threadharbor/relay/hosts',
      // 前缀不带尾斜杠：宿主的前缀匹配是 startsWith(prefix + '/')，自带
      // 斜杠会让任何请求都不命中（登记形状错的症状是「清单 200、转发全 404」）。
      'prefix /threadharbor/relay/hosts',
      'exact /threadharbor/relay/answer',
    ])
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

describe('会话前缀的方法门槛（看与发是一组）', () => {
  /** 真机上栽过：这条前缀只放 GET，于是 prompt / cancel 在真机上是 405，
   *  而清单与历史都正常——看着像「手机端按钮没反应」。这里逐个方法过一遍。 */
  function routesFor(config: MobileRelayConfig = VALID_CONFIG) {
    const { run, routes } = captureAppliedRoutes(config)
    run()
    const prefix = routes.find(route => route.kind === 'prefix')
    if (prefix === undefined) throw new Error('没有会话前缀路由')
    return prefix
  }

  it('会话前缀对 GET 与 POST 都放行（发消息与中断是 POST）', () => {
    const route = routesFor()
    // 只断言「不因方法被拒」：真正的转发由 relay 自己判，这里验的是方法门槛。
    for (const method of ['GET', 'POST'] as const) {
      expect(call(route.handler, { method, url: '/threadharbor/relay/hosts/a/sessions' }).status).not.toBe(405)
    }
  })

  it('应答那条仍然只收 POST', () => {
    const { run, routes } = captureAppliedRoutes(VALID_CONFIG)
    run()
    const answer = routes.find(route => route.path === '/threadharbor/relay/answer')
    if (answer === undefined) throw new Error('没有应答路由')
    expect(call(answer.handler, { method: 'GET', url: '/threadharbor/relay/answer' }).status).toBe(405)
    expect(call(answer.handler, { method: 'POST', url: '/threadharbor/relay/answer' }).status).not.toBe(405)
  })
})

describe('内部故障的落点（细节不能跟着有界文案一起消失）', () => {
  it('写进 state.json 旁边那个只追加日志，带时间戳，一行一条', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-log-'))
    const log = makeRelayLogger({ statePath: join(dir, 'state.json') })
    log('转发 session/page 到 tencent01 失败（rpc-error）：缺 address')
    log('第二行')
    const text = readFileSync(join(dir, 'relay.log'), 'utf8')
    const lines = text.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('转发 session/page')
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('日志目录还不存在时现建（state.json 之前没写过也不会丢细节）', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'relay-log-')), 'not', 'created', 'yet')
    makeRelayLogger({ statePath: join(dir, 'state.json') })('一条')
    expect(readFileSync(join(dir, 'relay.log'), 'utf8')).toContain('一条')
  })

  it('写不出去时静默（处理中的请求已经出错了，不能再抛一层）', () => {
    const log = makeRelayLogger({ statePath: '/dev/null/impossible/state.json' })
    expect(() => log('写不进去')).not.toThrow()
  })
})

/** 装配用的最小 ctx：登记的路由、升级路由与 disposer 都收在这里，便于断言。 */
function assemblyCtx() {
  const upgrades = new Map<string, unknown>()
  const disposers: (() => unknown)[] = []
  const routes: { path: string; handler: (req: unknown, res: unknown) => Promise<void> }[] = []
  const ctx = {
    effect(factory: () => unknown) {
      const result = factory()
      if (typeof result === 'function') disposers.push(result as () => void)
      return result
    },
    webServer: {
      register(route: { path: string; handler: (req: unknown, res: unknown) => Promise<void> }) {
        routes.push(route as never)
        return () => {}
      },
      registerUpgrade(route: { path: string }) {
        if (upgrades.has(route.path)) throw new Error(`duplicate upgrade route "${route.path}"`)
        upgrades.set(route.path, route)
        return () => { upgrades.delete(route.path) }
      },
    },
    connection: { admit: () => ({ peer: {} }) },
  }
  return { ctx: ctx as unknown as RelayRouteContext, upgrades, disposers, routes }
}

describe('装配层的两条线（有方法不等于有人调）', () => {

  const assemblyDeps: RelayAssemblyDeps = {
    // 隧道开不出来：机器全程离线，正是「上线后要能补挂订阅」那个场景。
    ssh: { ensureTunnel: async () => 'x', readLaunchUrl: async () => undefined },
    tailscalePeers: [{ name: 'mac-a', online: true }],
    probeStatus: 200,
  }

  it('升级路由的 disposer 要登记（否则插件重载撞重复登记，整个中转起不来）', () => {
    const first = assemblyCtx()
    apply(first.ctx, VALID_CONFIG, assemblyDeps)
    expect(first.upgrades.size).toBe(1)
    // 模拟宿主卸载：跑完所有 disposer 再重载。
    for (const dispose of first.disposers.splice(0)) dispose()
    expect(first.upgrades.size).toBe(0)
    const second = assemblyCtx()
    expect(() => apply(second.ctx, VALID_CONFIG, assemblyDeps)).not.toThrow()
  })

  it('清单每算完一轮都要触发订阅对账（启动时离线的机器上线后要能补挂）', async () => {
    const { ctx, upgrades } = assemblyCtx()
    const routes: { kind: string; path: string; handler: (req: unknown, res: unknown) => Promise<void> }[] = []
    const spyCtx = {
      ...ctx,
      webServer: {
        register(route: { kind: string; path: string; handler: (req: unknown, res: unknown) => Promise<void> }) {
          routes.push(route as never)
          return () => {}
        },
        registerUpgrade: ctx.webServer.registerUpgrade,
      },
    }
    apply(spyCtx as unknown as RelayRouteContext, VALID_CONFIG, assemblyDeps)
    expect(upgrades.size).toBe(1)

    const hosts = routes.find(route => route.path === '/threadharbor/relay/hosts')
    if (hosts === undefined) throw new Error('没有清单路由')
    const seen: string[][] = []
    // 盯住 reconcile 这一层：它才是「订阅对账」真正发生的地方。
    const original = Relay.prototype.reconcile
    Relay.prototype.reconcile = function patched(hostIds?: readonly string[]) {
      seen.push([...(hostIds ?? [])])
      return original.call(this, hostIds)
    }
    try {
      // 清单那一轮是异步的：等它真的算完再断言（call 是同步的，这里另等一下）。
      await (hosts.handler as (req: unknown, res: unknown) => Promise<void>)(
        { method: 'GET', url: '/threadharbor/relay/hosts', headers: { host: 'relay.example.com' } },
        { writeHead: () => {}, end: () => {} },
      )
    } finally {
      Relay.prototype.reconcile = original
    }
    expect(seen[0]).toEqual(['gooddemacbook-pro'])
  })
})

describe('停机收尾：重载不能把上一代的隧道留在原地', () => {
  function shutdownConfig(): { config: MobileRelayConfig; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'relay-shutdown-'))
    writeFileSync(join(dir, 'known_hosts'), '')
    return {
      dir,
      config: {
        mobileOrigin: 'https://relay.example.com',
        sshKnownHostsPath: join(dir, 'known_hosts'),
        statePath: join(dir, 'state.json'),
        machines: [{ hostId: 'mac-a', target: '100.64.0.2', remotePort: 3081, logPath: '/l.log' }],
      },
    }
  }

  it('跑完卸载的 disposer 之后，SSH 隧道真的被收掉了（否则新一代抢不到固定端口）', async () => {
    const { config } = shutdownConfig()
    const shutDown: string[] = []
    const deps: RelayAssemblyDeps = {
      ssh: {
        ensureTunnel: async () => 'x',
        readLaunchUrl: async () => undefined,
        closeTunnel: () => { shutDown.push('tunnels') },
      },
      tailscalePeers: [{ name: 'mac-a', online: true }],
      probeStatus: 200,
    }
    const first = assemblyCtx()
    apply(first.ctx, config, deps)
    // 拉一次清单，让该机真的走一遍「开隧道 → 建客户端」（订阅挂在客户端上）。
    const hosts = first.routes.find(route => route.path === '/threadharbor/relay/hosts')
    if (hosts === undefined) throw new Error('没有清单路由')
    await hosts.handler(
      { method: 'GET', url: '/threadharbor/relay/hosts', headers: { host: 'relay.example.com' } },
      { writeHead: () => {}, end: () => {} },
    )
    expect(shutDown).toEqual([])

    // 模拟宿主卸载（插件热重载）：处置器是**同步调用、不等 Promise** 的
    // （宿主那边就是一句 undo()），所以这里也不能 await——await 了就看不出
    // 「收隧道」到底是在当场发生还是被推迟到了微任务之后。
    for (const dispose of first.disposers.splice(0)) dispose()
    expect(shutDown).toEqual(['tunnels'])

    // 重载不该撞重复登记——这一条本来就绿（路由都包在 effect 里）。
    const second = assemblyCtx()
    expect(() => apply(second.ctx, config, deps)).not.toThrow()
  })

  it('收尾会把该机的 SSH 隧道真正收掉（真机见过孤儿占住固定端口）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-shutdown2-'))
    const killed: string[] = []
    const pool = new TunnelPool(
      join(dir, 'state.json'),
      {
        ensureTunnel: async () => 'http://127.0.0.1:41100',
        closeTunnel: async () => { killed.push('closed') },
      },
      join(dir, 'known_hosts'),
    )
    await pool.ensure({ hostId: 'mac-a', target: '100.64.0.2', remotePort: 3081, logPath: '/l.log' })
    await pool.closeAll()
    expect(killed).toEqual(['closed'])
  })

  it('没给收尾钩子时 closeAll 只清内存句柄（这时必须说清楚它没杀进程）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-shutdown3-'))
    const pool = new TunnelPool(
      join(dir, 'state.json'),
      { ensureTunnel: async () => 'http://127.0.0.1:41100' },
      join(dir, 'known_hosts'),
    )
    await pool.ensure({ hostId: 'mac-a', target: '100.64.0.2', remotePort: 3081, logPath: '/l.log' })
    await expect(pool.closeAll()).resolves.toBeUndefined()
  })
})

describe('订阅对账那一拍必须自己接住拒绝（没人接就是一次未处理拒绝）', () => {
  it('reconcile 抛错时：一行落点记下，手机那一拍的应答不受影响', async () => {
    const { ctx, routes } = assemblyCtx()
    const dir = mkdtempSync(join(tmpdir(), 'relay-reconcile-reject-'))
    // 中转的落点文件名是定的：与 state.json 同目录的 relay.log。
    const logPath = join(dir, 'relay.log')
    const config: MobileRelayConfig = {
      mobileOrigin: 'https://relay.example.com',
      sshKnownHostsPath: join(dir, 'known_hosts'),
      statePath: join(dir, 'state.json'),
      machines: [{ hostId: 'gooddemacbook-pro', target: '100.64.0.2', remotePort: 3081, logPath: '/l.log' }],
    }
    apply(ctx, config, {
      // 让挂订阅那一步炸：onEvent 在挂上之后由客户端自己抛，是这条路上唯一的
      // 真实抛点（clientFor 那边 attachOne 已经自己接住了）。
      ssh: {
        ensureTunnel: async () => 'x',
        readLaunchUrl: async () => undefined,
      },
      tailscalePeers: [{ name: 'gooddemacbook-pro', online: true }],
      probeStatus: 200,
    })
    const hosts = routes.find(route => route.path === '/threadharbor/relay/hosts')
    if (hosts === undefined) throw new Error('没有清单路由')

    const original = Relay.prototype.reconcile
    Relay.prototype.reconcile = function failing() { return Promise.reject(new Error('挂订阅时炸了')) }
    try {
      const state = { status: 0 }
      // 应答这一拍不该被对账的失败带崩。
      await hosts.handler(
        { method: 'GET', url: '/threadharbor/relay/hosts', headers: { host: 'relay.example.com' } },
        { writeHead: (status: number) => { state.status = status }, end: () => {} },
      )
      expect(state.status).toBe(200)
    } finally {
      Relay.prototype.reconcile = original
    }
    // 失败本身要有一行落点：静默的失败最难查。
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(readFileSync(logPath, 'utf8')).toContain('挂订阅时炸了')
  })
})

