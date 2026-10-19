/**
 * mobile/app.js 的手写声明：与 wire.d.ts / views.d.ts / backend-hub.d.ts 同一
 * 先例——app.js 是浏览器原生 ESM（无构建链），有意不进 tsc 编译范围，本声明
 * 只服务 tests 的类型检查。改 app.js 行为时同步改这里。
 */
import type { HubBackend } from './backend-hub.js'

/**
 * bootApp 的注入面：fetchLike 是最小 fetch 形（{status, text()}，比
 * wire.d.ts 的 FetchLike 窄；wire.js 在调用点按形状消费，JS 侧无类型摩擦），
 * WebSocketCtor 测试注入假件，backend 注入替身后端（页面只有中转模式）。
 */
export interface BootDeps {
  fetchLike?: (url: string, init?: { method?: string, body?: string }) => Promise<{ status: number, text(): Promise<string> }>
  WebSocketCtor?: (new (url: string) => unknown) | undefined
  /** 注入后端（测试与嵌入页面用）；不给则 bootApp 自己造中转站客户端。 */
  backend?: HubBackend
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

/** 启动应用：建壳、拉机器清单、渲染、挂事件。boot 完成后首屏已渲染。 */
export declare function bootApp(root: HTMLElement, deps?: BootDeps): Promise<void>

/**
 * 机器最后一次被联系上的时间，说成「多久之前」；在线的机器与从未成功联系过
 * 的机器都返回 undefined（不编时间）。
 */
export declare function lastSeenTextOf(host: unknown, now?: number): string | undefined
