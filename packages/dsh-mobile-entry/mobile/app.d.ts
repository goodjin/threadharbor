/**
 * mobile/app.js 的手写声明：与 wire.d.ts / views.d.ts 同一先例——app.js 是
 * 浏览器原生 ESM（无构建链），有意不进 tsc 编译范围，本声明只服务
 * tests/app.spec.ts 的类型检查。改 app.js 行为时同步改这里。
 */

/** socketFactory 交给界面的事件通知（断线/构造失败）。 */
export interface SocketNotice {
  kind: 'socket-closed' | 'construct-error'
  message?: string
}

/** MuxConnection 依赖的最小 socket 形（真 WebSocket 的子集）。 */
export interface WireSocketLike {
  send(data: string): void
  close(): void
  onopen: (() => void) | null
  onmessage: ((data: string) => void) | null
  onclose: (() => void) | null
}

/**
 * 造一个 socketFactory：构造失败在工厂内吞掉（返回立即断开的死 socket 并
 * 通知界面），绝不向调用方抛——错误不能逃进 MuxConnection 的重连定时器。
 * 连接侧（app.js）传给工厂的 url 一律是字符串，所以这里的构造签名收 string。
 */
export declare function makeSocketFactory(
  onNotice: (notice: SocketNotice) => void,
  WebSocketCtor?: new (url: string) => unknown,
): (url: string | URL) => WireSocketLike

/**
 * bootApp 的注入面：fetchLike 是最小 fetch 形（{status, text()}，比
 * wire.d.ts 的 FetchLike 窄；wire.js 在调用点按形状消费，JS 侧无类型摩擦），
 * WebSocketCtor 测试注入假件。
 */
export interface BootDeps {
  fetchLike?: (url: string, init?: { method?: string, body?: string }) => Promise<{ status: number, text(): Promise<string> }>
  WebSocketCtor?: (new (url: string) => unknown) | undefined
  /** 注入后端（测试与嵌入页面用）；不给则按 mode 选。 */
  backend?: MobileBackend
  /** 页面模式；不给则读 index.html 注入的全局，再不给就是直连。 */
  mode?: 'machine' | 'hub'
}

/** 滚动锚点：上一次渲染的消息列表的阅读位与高度。 */
export interface ScrollAnchor {
  top: number
  height: number
}

/**
 * 滚动决策（纯函数，导出仅为测试）：restore（「加载更早」prepend）按高度差
 * 补偿锚点，keep 原样，bottom 贴新高；anchor 为 null 或未知意图一律贴新高；
 * 负值钳到 0。
 */
export declare function nextScrollTop(
  mode: 'bottom' | 'keep' | 'restore',
  anchor: ScrollAnchor | null,
  newHeight: number,
): number

/** 启动应用：建壳、探测配对、渲染、挂事件。boot 完成后首屏已渲染。 */
export declare function bootApp(root: HTMLElement, deps?: BootDeps): Promise<void>

