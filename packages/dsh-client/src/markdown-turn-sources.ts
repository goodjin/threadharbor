/**
 * 一轮结尾里的文本阅读区用的纯数据。
 *
 * 官方改动卡片、悬停对比和交付卡仍由 ui-deliverables 画，点它们仍打开右侧。
 * 这里从同一轮已经记下的产出路径、交付路径里挑文本文件（Markdown、源码、
 * 纯文本、无后缀的文本都算）。改动清单本身只留了序号，文件路径再向主机要一次
 * 摘要（和官方卡片同一条 `api/changes.summary`）。图片、PDF、Office 和压缩包
 * 不进阅读区。
 */

/** 一页工作区文本，对齐 `workspaceFiles.read` 里阅读区要用的三个字段。 */
export interface MarkdownTextPage {
  readonly text: string
  readonly lines: number
  readonly eof: boolean
}

/** 阅读区向宿主要正文和改动摘要的两个口子。注册时绑上，测试里换假的。 */
export interface MarkdownTurnReaders {
  readPage(sessionId: string, path: string, offset: number, signal: AbortSignal): Promise<MarkdownTextPage>
  loadSummary(sessionId: string, seq: number, signal: AbortSignal): Promise<unknown>
}

/** 一轮里已经能确定的文本路径，外加改动摘要的序号（有的话）。 */
export interface MarkdownTurnSources {
  readonly paths: readonly string[]
  /** `workspace/changes` 宣告的序号。摘要回来之前，改动里的文本还不在 `paths` 里。 */
  readonly changesSeq?: number
}

/** 拼起来的正文超过这么多行就停下，并标明只显示了前面一部分。 */
export const MARKDOWN_READ_LINE_CAP = 20000

const MARKDOWN_EXTENSION = /\.(md|markdown)$/i

/**
 * 字节读不出来的后缀。对齐官方文档预览：打不开的容器、位图、PDF。
 * SVG、CSV、HTML 和没有后缀的文件留在文本这边。
 */
const BINARY_EXTENSIONS: readonly string[] = [
  'mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv', 'm4v',
  'mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'wma', 'opus',
  'zip', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar', 'tar', 'jar',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'pages', 'numbers',
  'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'class', 'pyc', 'wasm',
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  'dmg', 'iso', 'img', 'sqlite', 'db',
  'psd', 'ai', 'sketch', 'tiff', 'tif', 'heic', 'heif', 'avif',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico',
  'pdf',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 去掉目录和查询串之后的文件名，用来对后缀。 */
function fileName(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const base = slash === -1 ? path : path.slice(slash + 1)
  return (base.split('?')[0]?.split('#')[0] ?? base).toLowerCase()
}

/**
 * 路径是不是 Markdown。阅读区用它决定要不要按 Markdown 排版。
 * @param path - 工作区相对路径或绝对路径。
 * @returns 文件名以 `.md` 或 `.markdown` 结尾时为 true。
 */
export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXTENSION.test(fileName(path))
}

/**
 * 路径是不是可以在会话区展开的文本。
 *
 * 没有后缀的文件（Makefile、Dockerfile）算文本。已知二进制后缀不算。
 * @param path - 工作区相对路径或绝对路径。
 * @returns 应当放进阅读区时为 true。
 */
export function isInlineTextPath(path: string): boolean {
  const name = fileName(path)
  if (name.length === 0) return false
  return !BINARY_EXTENSIONS.some(extension => name.endsWith(`.${extension}`))
}

function addTextPath(paths: string[], seen: Set<string>, path: unknown): void {
  if (typeof path !== 'string' || !isInlineTextPath(path) || seen.has(path)) return
  seen.add(path)
  paths.push(path)
}

function pathsFromList(value: unknown, paths: string[], seen: Set<string>): void {
  if (!Array.isArray(value)) return
  for (const item of value) {
    if (isRecord(item)) addTextPath(paths, seen, item.path)
  }
}

/**
 * 从一轮的 `deliverables` 数据里取出文本路径。
 *
 * 产出和交付的路径就在这份数据里。改动清单只有序号，调用方再用
 * {@link markdownPathsFromSummary} 把摘要里的文本补上。
 * @param data - `turn.data.get('deliverables')` 的原值。
 * @returns 有路径或有改动序号时的来源；形状不对或两边都空时为 null。
 */
export function markdownSources(data: unknown): MarkdownTurnSources | null {
  if (!isRecord(data)) return null
  const paths: string[] = []
  const seen = new Set<string>()
  pathsFromList(data.produced, paths, seen)
  pathsFromList(data.presented, paths, seen)
  const changes = data.changes
  const seq = isRecord(changes) && Number.isSafeInteger(changes.seq) && (changes.seq as number) >= 0
    ? changes.seq as number
    : undefined
  if (paths.length === 0 && seq === undefined) return null
  return seq === undefined ? { paths } : { paths, changesSeq: seq }
}

/**
 * 从改动摘要里取出文本路径。标记为二进制的文件，以及已知二进制后缀，都跳过。
 * @param value - `api/changes.summary` 的 JSON。
 * @returns 路径列表；摘要不是 `{ files: [] }` 时为 `'invalid'`。
 */
export function markdownPathsFromSummary(value: unknown): readonly string[] | 'invalid' {
  if (!isRecord(value) || !Array.isArray(value.files)) return 'invalid'
  const paths: string[] = []
  const seen = new Set<string>()
  for (const file of value.files) {
    if (!isRecord(file) || file.binary === true) continue
    addTextPath(paths, seen, file.path)
  }
  return paths
}

/**
 * 把摘要里新出现的路径接在已有路径后面，同一路径只留第一次。
 * @param base - 产出和交付里已经挑出的路径。
 * @param extra - 摘要里的路径。
 * @returns 合并后的路径。
 */
export function mergeMarkdownPaths(base: readonly string[], extra: readonly string[]): readonly string[] {
  if (extra.length === 0) return base
  const seen = new Set(base)
  const out = [...base]
  for (const path of extra) {
    if (seen.has(path)) continue
    seen.add(path)
    out.push(path)
  }
  return out
}

/**
 * 官方改动摘要的文档相对地址。
 * @param sessionId - 当前会话。
 * @param seq - `workspace/changes` 事件序号。
 * @returns `api/changes.summary?...`。
 */
export function changesSummaryUrl(sessionId: string, seq: number): string {
  return `api/changes.summary?${new URLSearchParams({ sessionId, seq: String(seq) })}`
}

function isTextPage(value: unknown): value is MarkdownTextPage {
  return isRecord(value)
    && typeof value.text === 'string'
    && Number.isSafeInteger(value.lines)
    && (value.lines as number) >= 0
    && typeof value.eof === 'boolean'
}

/**
 * 按页把一篇 Markdown 读完。
 *
 * 每一页的正文不含末尾换行，页与页之间补一个换行。到达文件末尾，或累计行数
 * 到达 `capLines`，就停下。
 * @param readPage - 从 1 起的行号读一页。
 * @param capLines - 最多累计多少行。
 * @returns 拼好的正文，以及是否因为行数上限没读完。
 */
export async function readMarkdownText(
  readPage: (offset: number) => Promise<MarkdownTextPage>,
  capLines: number,
): Promise<{ text: string, truncated: boolean }> {
  const parts: string[] = []
  let offset = 1
  let lines = 0
  for (;;) {
    const page = await readPage(offset)
    if (page.lines <= 0) return { text: parts.join('\n'), truncated: false }
    parts.push(page.text)
    lines += page.lines
    if (page.eof || lines >= capLines) {
      return { text: parts.join('\n'), truncated: !page.eof && lines >= capLines }
    }
    offset += page.lines
  }
}

/**
 * 用当下的 remote 读文件，用页面同源的 fetch 读改动摘要。
 *
 * 每次调用都重新取 remote：连接换过之后，挂在旧对象上的方法会抛。
 * @param remote - 返回当前 `ctx.remote`。
 * @returns 阅读区用的两个口子。
 */

/**
 * 从 `workspaceFiles.read` 的返回值里取出正文页。
 *
 * 客户端远程方法不直接给页，而是 `{ ok: true, value }` 或 `{ ok: false, error }`。
 * 把信封当成页会让每篇文档都读失败。
 * @param value - 远程调用的返回值。
 * @returns 正文页。
 * @throws 调用失败，或成功结果里没有正文页时。
 */
function textPageFromRead(value: unknown): MarkdownTextPage {
  if (isRecord(value) && value.ok === true && isTextPage(value.value)) return value.value
  const error = isRecord(value) && value.ok === false ? value.error : undefined
  const message = isRecord(error) && typeof error.message === 'string' && error.message.length > 0
    ? error.message
    : 'workspaceFiles.read returned an unexpected page'
  throw new Error(message)
}

export function createMarkdownTurnReaders(remote: () => unknown): MarkdownTurnReaders {
  return {
    async readPage(sessionId, path, offset, signal) {
      const holder = remote()
      const files = isRecord(holder) ? holder.workspaceFiles : undefined
      const read = isRecord(files) && typeof files.read === 'function' ? files.read : undefined
      if (read === undefined) throw new Error('workspaceFiles.read is missing')
      const value: unknown = await read.call(files, sessionId, path, { offset }, signal)
      return textPageFromRead(value)
    },
    async loadSummary(sessionId, seq, signal) {
      const response = await fetch(changesSummaryUrl(sessionId, seq), { signal })
      if (!response.ok) return undefined
      return await response.json() as unknown
    },
  }
}
