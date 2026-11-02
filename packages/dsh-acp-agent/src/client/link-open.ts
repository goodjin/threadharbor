/**
 * 会话结果文本块里 http(s) 链接的打开方式。
 *
 * 编译包 `MarkdownText` 把 http(s) 链接渲染成普通 `<a target="_blank">`，桌面外壳
 * 会把 `_blank` 交给系统浏览器、宿主渲染层会把链接路由到右侧预览面板。这里不碰编译包，
 * 只给文本块叠一层交互：hover 时浮出「右侧打开 / 浏览器打开」两个按钮，单击链接走
 * 默认打开方式。默认打开方式存 localStorage（与文件树视图偏好同一套 `threadharbor.*` 键）。
 */

export const DEFAULT_LINK_OPEN_KEY = 'threadharbor.markdown.defaultLinkOpen'

/** 链接打开方式：右侧 = 交给宿主右侧预览面板；浏览器 = 系统浏览器新标签。 */
export type LinkOpenMode = 'right' | 'browser'

const VALID: readonly LinkOpenMode[] = ['right', 'browser']

/** 读取默认打开方式；未设置或非法值回退到「右侧」（保持现状）。 */
export function readDefaultLinkOpenMode(): LinkOpenMode {
  if (typeof localStorage === 'undefined') return 'right'
  const stored = localStorage.getItem(DEFAULT_LINK_OPEN_KEY)
  return VALID.includes(stored as LinkOpenMode) ? (stored as LinkOpenMode) : 'right'
}

/** 写入默认打开方式。 */
export function writeDefaultLinkOpenMode(mode: LinkOpenMode): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(DEFAULT_LINK_OPEN_KEY, mode)
}

/** 当前默认打开方式的便捷读取。 */
export function defaultLinkOpenMode(): LinkOpenMode {
  return readDefaultLinkOpenMode()
}

/**
 * 在系统浏览器打开一个 http(s) 链接。复用 dsh-client 既有做法（panel.tsx 里的
 * gateway 页链接）：`window.open(url, '_blank', 'noopener')`，桌面外壳会把它交给
 * `shell.openExternal`。
 */
export function openInBrowser(url: string): void {
  if (typeof window === 'undefined') return
  window.open(url, '_blank', 'noopener')
}

/** 从 href 里安全取出 http(s) 链接；非 http(s) 或非字符串返回 null。 */
export function httpLinkHref(href: unknown): string | null {
  if (typeof href !== 'string' || href.length === 0) return null
  try {
    const { protocol } = new URL(href, typeof window === 'undefined' ? 'http://localhost' : window.location.href)
    return protocol === 'http:' || protocol === 'https:' ? href : null
  } catch {
    return null
  }
}
