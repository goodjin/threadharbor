/**
 * 中转的状态文档：凭据、端口分配同住 statePath 指向的同一份 JSON 文件。
 *
 * 为什么是一份文档而不是凭据、端口分配各一份文件：凭据层与隧道池都要往
 * statePath 写，若各自按「整份 JSON」各写各的文件，两份文件之间没有任何
 * 原子性可言——一次崩溃或一次交错写入就会留下「凭据换了、端口分配还是
 * 旧的」这类半写状态，而云主机重启后端口漂移正是凭据集体失效的根因，两
 * 份文件会把这对账本拆到没人能一起改。单份文档 + 整份读-改-写让每个写
 * 者都从盘上最新的一份出发（StateStore 不缓存，每次都读盘），配合同目录
 * 临时文件改名落盘（同一文件系统上 rename 是原子的），文件任意时刻要么
 * 是旧版要么是新版，不会出现半份。写者必须走 StateStore.update，不得绕
 * 开它直接写路径。
 *
 * 并发前提：中转在云主机上是单实例进程，单进程内的写入全是同步调用，不
 * 会交错；跨进程同时写不做互斥（最后写者赢），由部署侧保证单实例。
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 一台机器的凭据。cookie 存的是 Set-Cookie 首对的 `name=value` 逐字（名字
 * 含每实例随机后缀），转发时原样作为 Cookie 请求头；obtainedAt 只作审计
 * （何时换的），有效期以服务端 401 为信号，不本地掐表。
 */
export interface StoredCredential {
  readonly hostId: string
  readonly cookie: string
  readonly obtainedAt: number
}

/** statePath 文件的形状。tunnels 段归隧道池（Task 5），这里只留槽位。 */
export interface RelayStateDocument {
  readonly version: 1
  readonly credentials: readonly StoredCredential[]
  readonly tunnels: Readonly<Record<string, unknown>>
  /**
   * 每台机器最后一次**真的联系上**的时刻（epoch 毫秒）。机器离线时手机上
   * 要能说清「它最后一次有动静是什么时候」——不然「离线」和「从配好到现在
   * 都没成功过」在界面上长得一模一样。
   */
  readonly lastSeen: Readonly<Record<string, number>>
}

function emptyDocument(): RelayStateDocument {
  return { version: 1, credentials: [], tunnels: {}, lastSeen: {} }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseCredential(value: unknown): StoredCredential | undefined {
  if (!isRecord(value)) return undefined
  const { hostId, cookie, obtainedAt } = value
  if (typeof hostId !== 'string' || hostId === '') return undefined
  if (typeof cookie !== 'string' || cookie === '') return undefined
  if (typeof obtainedAt !== 'number' || !Number.isFinite(obtainedAt)) return undefined
  return { hostId, cookie, obtainedAt }
}

/**
 * 结构校验：任何一段看不懂（版本不认识、段缺失、条目形状不对）就整份作
 * 废，由调用方按「全无」处理。不做局部修剪——留下看得懂的那一半等于静
 * 默使用半份数据，半份凭据比没有凭据更难排查。
 */
function normalizeDocument(value: unknown): RelayStateDocument {
  if (!isRecord(value)) throw new Error('状态文档不是 JSON 对象')
  if (value['version'] !== 1) throw new Error('状态文档版本不认识')
  if (!Array.isArray(value['credentials'])) throw new Error('credentials 段不是数组')
  if (!isRecord(value['tunnels'])) throw new Error('tunnels 段不是对象')
  // lastSeen 允许整段缺失（升级前的文档没有它）：缺了当作「都没见过」，
  // 这是可安全补齐的默认值，不该把已有的凭据与隧道分配一起作废。
  const lastSeen: Record<string, number> = {}
  if (value['lastSeen'] !== undefined) {
    if (!isRecord(value['lastSeen'])) throw new Error('lastSeen 段不是对象')
    for (const [hostId, at] of Object.entries(value['lastSeen'])) {
      if (typeof at !== 'number' || !Number.isFinite(at)) throw new Error('lastSeen 条目形状不对')
      lastSeen[hostId] = at
    }
  }
  const credentials: StoredCredential[] = []
  for (const entry of value['credentials'] as unknown[]) {
    const parsed = parseCredential(entry)
    if (parsed === undefined) throw new Error('credentials 条目形状不对')
    credentials.push(parsed)
  }
  return { version: 1, credentials, tunnels: value['tunnels'], lastSeen }
}

/**
 * statePath 的读-改-写面：凭据层与隧道池各持一个实例也安全，因为 update
 * 每次都从盘上现读，改哪段都带着另一段的最新账。
 */
export class StateStore {
  private readonly path: string

  constructor(path: string) {
    this.path = path
  }

  /**
   * 读整份文档。文件不存在（首次使用）与内容损坏（截断、手改坏、版本不
   * 认识）同归一处：按全空文档处理，让上层走重新换取/重新分配，绝不静
   * 默使用半份数据。
   */
  read(): RelayStateDocument {
    let raw: string
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch {
      return emptyDocument()
    }
    try {
      return normalizeDocument(JSON.parse(raw))
    } catch {
      return emptyDocument()
    }
  }

  /**
   * 整份读-改-写：mutate 收到当前文档、返回新文档，同步落盘后原样返回。
   * mutate 抛错时不落盘，文档保持原样。mutate 里不要再做 I/O——它拿到
   * 的快照一旦落盘就可能已过时。
   */
  /** 记下「这台机器刚刚真的联系上了」，返回记下的时刻（供调用方直接回给手机）。 */
  markSeen(hostId: string, at = Date.now()): number {
    this.update(doc => ({ ...doc, lastSeen: { ...doc.lastSeen, [hostId]: at } }))
    return at
  }

  /** 某台机器最后一次联系上的时刻；从来没有过就是 undefined。 */
  lastSeenOf(hostId: string): number | undefined {
    return this.read().lastSeen[hostId]
  }

  update(mutate: (doc: RelayStateDocument) => RelayStateDocument): RelayStateDocument {
    const next = mutate(this.read())
    this.write(next)
    return next
  }

  /**
   * 原子落盘：0600 文件、0700 目录。mode 只在创建时生效，目录和文件都可
   * 能带着旧权限已存在（或上次崩溃留下了宽权限的临时文件），所以写入后
   * 各纠一次权限。临时文件放在同目录再 rename——跨目录的 rename 不保证
   * 原子。
   */
  private write(doc: RelayStateDocument): void {
    const dir = dirname(this.path)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
    const tmp = `${this.path}.tmp-${process.pid}`
    writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.path)
    chmodSync(this.path, 0o600)
  }
}
