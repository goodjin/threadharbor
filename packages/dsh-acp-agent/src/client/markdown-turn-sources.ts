/**
 * 一轮结尾里的文本阅读区用的纯数据。
 *
 * 官方改动卡片、悬停对比和交付卡仍由 ui-deliverables 画，点它们仍打开右侧。
 * 这里从同一轮已经记下的产出路径、交付路径里挑文本文件（Markdown、源码、
 * 纯文本、无后缀的文本都算）。改动清单本身只留了序号，文件路径再向主机要一次
 * 摘要（和官方卡片同一条 `api/changes.summary`）。助手正文里指向本地文件的
 * 链接也算：接受规则与会话里点开文件的规则相同。路径末尾的 `:行号` 和 `#L行号`
 * 只用来定位，阅读区打开文件本身。图片、PDF、Office 和压缩包不进阅读区。打开方式走会话的桌面接口：默认应用、指定应用，或在文件管理器里显示。
 */

/** 一页工作区文本，对齐 `workspaceFiles.read` 里阅读区要用的三个字段。 */
export interface MarkdownTextPage {
  readonly text: string
  readonly lines: number
  readonly eof: boolean
}

/** 一台已注册、可以打开这个文件的应用。 */
export interface MarkdownFileApplication {
  readonly id: string
  readonly name: string
  readonly icon: string | null
  readonly default: boolean
}

/** 打开方式：系统默认应用、指定应用，或在文件管理器里显示。 */
export type MarkdownFileOpen =
  | { readonly kind: 'default' }
  | { readonly kind: 'application'; readonly id: string }
  | { readonly kind: 'reveal' }

/** 阅读区向宿主要正文、改动摘要和打开方式的口子。注册时绑上，测试里换假的。 */
export interface MarkdownTurnReaders {
  readPage(sessionId: string, path: string, offset: number, signal: AbortSignal): Promise<MarkdownTextPage>
  loadSummary(sessionId: string, seq: number, signal: AbortSignal): Promise<unknown>
  /** 在文件管理器里显示这个文件所在的文件夹。 */
  revealFile(sessionId: string, path: string): Promise<void>
  /** 主机能否把路径交给桌面。没有这个能力时文件栏不放打开按钮。 */
  canOpenFiles(): Promise<boolean>
  /**
   * 这个文件在主机上注册了哪些应用。
   * 查不到时返回 null，和一份空名单区分开：空名单表示没有应用，null 表示这次没问出来。
   */
  fileApplications(sessionId: string, path: string, signal: AbortSignal): Promise<readonly MarkdownFileApplication[] | null>
  /** 用一种打开方式打开文件。失败时抛错，由按钮自己提示。 */
  openFile(sessionId: string, path: string, action: MarkdownFileOpen): Promise<void>
  /** 把一段文本作为一条消息发给当前会话。失败时抛错，由按钮自己提示。 */
  sendToSession(sessionId: string, text: string): Promise<void>
  /**
   * 新建一个会话并返回其编号。不带 agentPreset，让主机用默认（客户端读不到
   * 当前会话的预设，故走默认，与当前会话同模型这一步交给主机默认）。失败时抛错。
   */
  createSession(): Promise<string>
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


/** 助手正文里一个本地文件链接的路径。行号后缀已经去掉。 */
const LINE_SUFFIX = /:(\d+)(?:-\d+)?$/

/**
 * 去掉模型写在路径末尾的行号（`file.py:243`、`file.py:10-20`、`file.py:10:2`）。
 * 盘符上的冒号（`C:`）留下。
 * @param path - 解码后的路径，或还没解码的链接目标。
 * @returns 去掉行号后的路径。没有行号时原样返回。
 */
function stripColonLine(path: string): string {
  let current = path
  for (;;) {
    const match = LINE_SUFFIX.exec(current)
    if (match === null) return current
    const cut = current.slice(0, match.index)
    if (cut.length === 0 || /^[a-z]:$/i.test(cut)) return current
    current = cut
  }
}

/**
 * 判断一个链接目标是不是会话里会点开的本地文件。
 *
 * 与官方 `parseFileLink` 同一套拒绝条件：查询串、控制字符、UNC、`file:` 等
 * 协议，以及不是 `L` 行号的片段。Windows 盘符保留。
 * @param value - Markdown 链接目标，不含尖括号。
 * @returns 本地路径；不是文件链接时为 undefined。
 */
function acceptFileDestination(value: string): string | undefined {
  const hash = value.indexOf('#')
  const destination = hash < 0 ? value : value.slice(0, hash)
  if (destination.includes('?')) return undefined
  let path: string
  try {
    path = decodeURIComponent(destination)
  } catch {
    return undefined
  }
  if (path.length === 0 || /[\u0000-\u001f\u007f]/.test(path)) return undefined
  if (/^[\\/]{2}/.test(path)) return undefined
  if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) return undefined
  if (hash >= 0 && !/^L[1-9]\d*(?:-L[1-9]\d*)?$/.test(value.slice(hash + 1))) return undefined
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const name = path.slice(slash + 1)
  if (name.length === 0 || name === '.' || name === '..') return undefined
  return path
}

/**
 * 从链接目标取出要打开的文件。
 *
 * 绝对路径带 `:行号` 时，点开用的字符串里含行号，读文件会落空。这里先按文件
 * 链接接受，再去掉行号。相对路径的 `:行号` 会被当成协议名，所以去掉后再认一次。
 * @param destination - Markdown 链接目标。
 * @returns 去掉行号后的本地路径；不是文件时为 undefined。
 */
function filePathFromDestination(destination: string): string | undefined {
  const direct = acceptFileDestination(destination)
  if (direct !== undefined) return stripColonLine(direct)
  const stripped = stripColonLine(destination)
  if (stripped === destination) return undefined
  return acceptFileDestination(stripped)
}

/** 代码块和行内代码的区间。里面的链接是例子，不是点开的文件。 */
function hiddenSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  const fence = /```[\s\S]*?```|```[\s\S]*$/g
  for (let match = fence.exec(text); match !== null; match = fence.exec(text)) {
    spans.push([match.index, match.index + match[0].length])
  }
  const code = /`[^`\n]*`/g
  for (let match = code.exec(text); match !== null; match = code.exec(text)) {
    const at = match.index
    const spanEnd = at + match[0].length
    if (spans.some(([start, end]) => at >= start && at < end)) continue
    spans.push([at, spanEnd])
  }
  return spans
}

function insideSpan(spans: readonly (readonly [number, number])[], index: number): boolean {
  return spans.some(([start, end]) => index >= start && index < end)
}

/** 链接文字结束的 `]`。转义的括号不算。 */
function closingBracket(source: string, open: number): number {
  for (let index = open + 1; index < source.length; index += 1) {
    if (source[index] === '\\') {
      index += 1
      continue
    }
    if (source[index] === ']') return index
  }
  return -1
}

/** 跳过可选的标题，停在链接结束的 `)` 之后。不是链接时为 undefined。 */
function finishLink(source: string, index: number): number | undefined {
  let cursor = index
  while (source[cursor] === ' ' || source[cursor] === '\t' || source[cursor] === '\n') cursor += 1
  const quote = source[cursor]
  if (quote === '"' || quote === "'") {
    cursor += 1
    while (cursor < source.length && source[cursor] !== quote) cursor += 1
    if (source[cursor] !== quote) return undefined
    cursor += 1
    while (source[cursor] === ' ' || source[cursor] === '\t' || source[cursor] === '\n') cursor += 1
  }
  if (source[cursor] !== ')') return undefined
  return cursor + 1
}

/** 读出 `](` 后面的链接目标，以及链接结束位置。 */
function readDestination(source: string, start: number): { value: string, end: number } | undefined {
  let cursor = start
  while (source[cursor] === ' ' || source[cursor] === '\n' || source[cursor] === '\t') cursor += 1
  if (source[cursor] === '<') {
    const close = source.indexOf('>', cursor + 1)
    if (close < 0) return undefined
    const end = finishLink(source, close + 1)
    if (end === undefined) return undefined
    return { value: source.slice(cursor + 1, close), end }
  }
  let endOfValue = cursor
  while (
    endOfValue < source.length
    && source[endOfValue] !== ')'
    && source[endOfValue] !== ' '
    && source[endOfValue] !== '\n'
    && source[endOfValue] !== '\t'
  ) endOfValue += 1
  if (endOfValue === cursor) return undefined
  const end = finishLink(source, endOfValue)
  if (end === undefined) return undefined
  return { value: source.slice(cursor, endOfValue), end }
}

/**
 * 从一段助手正文里取出本地文本文件链接。
 *
 * 代码块和行内代码里的链接不算。图片链接不算。同一路径只留第一次。
 * @param text - 一个 `text` 块的原文。
 * @returns 阅读区要打开的路径。
 */
export function linkedFilePathsFromText(text: string): readonly string[] {
  const spans = hiddenSpans(text)
  const paths: string[] = []
  const seen = new Set<string>()
  let index = 0
  while (index < text.length) {
    const start = text.indexOf('[', index)
    if (start < 0) break
    if (insideSpan(spans, start) || (start > 0 && (text[start - 1] === '!' || text[start - 1] === '\\'))) {
      index = start + 1
      continue
    }
    const labelEnd = closingBracket(text, start)
    if (labelEnd < 0 || text[labelEnd + 1] !== '(') {
      index = start + 1
      continue
    }
    const destination = readDestination(text, labelEnd + 2)
    if (destination === undefined) {
      index = labelEnd + 1
      continue
    }
    index = destination.end
    const path = filePathFromDestination(destination.value)
    if (path === undefined || !isInlineTextPath(path) || seen.has(path)) continue
    seen.add(path)
    paths.push(path)
  }
  return paths
}

/**
 * 从这一轮各步的助手正文里收集文件链接。
 *
 * 步骤上的 `assistant-step` 是会话已经排好的正文。推理块不在输出结果里，跳过。
 * @param turn - 轮次结尾拿到的轮次。没有步骤时返回空列表。
 * @returns 按出现顺序去重后的文本路径。
 */
export function linkedFilePathsFromTurn(turn: unknown): readonly string[] {
  if (!isRecord(turn) || !Array.isArray(turn.steps)) return []
  const paths: string[] = []
  const seen = new Set<string>()
  for (const step of turn.steps) {
    if (!isRecord(step) || !isRecord(step.data) || typeof step.data.get !== 'function') continue
    const assistant = (step.data.get as (key: string) => unknown)('assistant-step')
    if (!isRecord(assistant) || !Array.isArray(assistant.blocks)) continue
    for (const block of assistant.blocks) {
      if (!isRecord(block) || block.kind !== 'text' || typeof block.text !== 'string') continue
      for (const path of linkedFilePathsFromText(block.text)) {
        if (seen.has(path)) continue
        seen.add(path)
        paths.push(path)
      }
    }
  }
  return paths
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

/** 从 `workspaceFiles.stat` 的成功结果里取出主机上的绝对路径。 */
function absolutePathFromStat(value: unknown): string | undefined {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.value)) return undefined
  const path = value.value.absolutePath
  return typeof path === 'string' && path.length > 0 ? path : undefined
}

function applicationsFrom(value: unknown): readonly MarkdownFileApplication[] | null {
  if (!isRecord(value) || value.ok !== true || !Array.isArray(value.value)) return null
  const apps: MarkdownFileApplication[] = []
  for (const item of value.value) {
    if (!isRecord(item)) continue
    const id = item.id
    const name = item.name
    if (typeof id !== 'string' || id.length === 0 || typeof name !== 'string' || name.length === 0) continue
    const icon = item.icon
    apps.push({
      id,
      name,
      icon: typeof icon === 'string' && icon.length > 0 ? icon : null,
      default: item.default === true,
    })
  }
  return apps
}

function openRequest(absolutePath: string, action: MarkdownFileOpen): { path: string; action?: 'reveal'; application?: string } {
  if (action.kind === 'reveal') return { path: absolutePath, action: 'reveal' }
  if (action.kind === 'application') return { path: absolutePath, application: action.id }
  return { path: absolutePath }
}

/**
 * 用当下的 remote 读文件、问桌面怎么打开，并用页面同源的 fetch 读改动摘要。
 *
 * 每次调用都重新取 remote：连接换过之后，挂在旧对象上的方法会抛。
 * 桌面有没有这个能力按 remote 对象记一次，换了连接再问。
 * @param remote - 返回当前 `ctx.remote`。
 * @returns 阅读区用的读取口。
 */
export function createMarkdownTurnReaders(remote: () => unknown): MarkdownTurnReaders {
  let desktopRemote: unknown
  let desktopAnswer: Promise<boolean> | undefined

  async function openAt(sessionId: string, path: string, action: MarkdownFileOpen): Promise<void> {
    const holder = remote()
    const files = isRecord(holder) ? holder.workspaceFiles : undefined
    const stat = isRecord(files) && typeof files.stat === 'function' ? files.stat : undefined
    const session = isRecord(holder) && isRecord(holder.session) ? holder.session : undefined
    const open = session !== undefined && typeof session.openWorkspacePath === 'function'
      ? session.openWorkspacePath
      : undefined
    if (stat === undefined || open === undefined || session === undefined) {
      throw new Error('workspace file reveal is missing')
    }
    const stated: unknown = await stat.call(files, sessionId, path)
    const resolved = absolutePathFromStat(stated)
    if (resolved === undefined) throw new Error('workspace file has no absolute path')
    const opened: unknown = await open.call(session, openRequest(resolved, action))
    if (!isRecord(opened) || opened.ok !== true) {
      const error = isRecord(opened) && opened.ok === false ? opened.error : undefined
      const message = isRecord(error) && typeof error.message === 'string' && error.message.length > 0
        ? error.message
        : action.kind === 'reveal' ? 'workspace file reveal failed' : 'workspace file open failed'
      throw new Error(message)
    }
  }

  return {
    async readPage(sessionId, path, offset, signal) {
      const holder = remote()
      const files = isRecord(holder) ? holder.workspaceFiles : undefined
      const read = isRecord(files) && typeof files.read === 'function' ? files.read : undefined
      if (read === undefined) throw new Error('workspaceFiles.read is missing')
      const value: unknown = await read.call(files, sessionId, path, { offset }, signal)
      return textPageFromRead(value)
    },
    async revealFile(sessionId, path) {
      await openAt(sessionId, path, { kind: 'reveal' })
    },
    async openFile(sessionId, path, action) {
      await openAt(sessionId, path, action)
    },
    async canOpenFiles() {
      const holder = remote()
      if (desktopAnswer !== undefined && desktopRemote === holder) return desktopAnswer
      desktopRemote = holder
      desktopAnswer = (async () => {
        const session = isRecord(holder) && isRecord(holder.session) ? holder.session : undefined
        const can = session !== undefined && typeof session.canOpenWorkspacePath === 'function'
          ? session.canOpenWorkspacePath
          : undefined
        if (can === undefined || session === undefined) return false
        try {
          const result: unknown = await can.call(session)
          return isRecord(result) && result.ok === true && result.value === true
        } catch {
          return false
        }
      })()
      return desktopAnswer
    },
    async fileApplications(sessionId, path, signal) {
      try {
        const holder = remote()
        const files = isRecord(holder) ? holder.workspaceFiles : undefined
        const stat = isRecord(files) && typeof files.stat === 'function' ? files.stat : undefined
        const session = isRecord(holder) && isRecord(holder.session) ? holder.session : undefined
        const query = session !== undefined && typeof session.workspacePathApplications === 'function'
          ? session.workspacePathApplications
          : undefined
        if (stat === undefined || query === undefined || session === undefined) return null
        const stated: unknown = await stat.call(files, sessionId, path)
        if (signal.aborted) throw signal.reason
        const resolved = absolutePathFromStat(stated)
        if (resolved === undefined) return null
        const listed: unknown = await query.call(session, { path: resolved }, signal)
        if (signal.aborted) throw signal.reason
        return applicationsFrom(listed)
      } catch (error) {
        if (signal.aborted) throw error
        return null
      }
    },
    async loadSummary(sessionId, seq, signal) {
      const response = await fetch(changesSummaryUrl(sessionId, seq), { signal })
      if (!response.ok) return undefined
      return await response.json() as unknown
    },
    async sendToSession(sessionId, text) {
      const holder = remote()
      const session = isRecord(holder) && isRecord(holder.session) ? holder.session : undefined
      const prompt = session !== undefined && typeof session.prompt === 'function'
        ? session.prompt
        : undefined
      if (prompt === undefined) throw new Error('session.prompt is missing')
      const payload = {
        requestId: crypto.randomUUID(),
        sessionId,
        mode: 'queue' as const,
        content: [{ type: 'text' as const, text }],
      }
      const result: unknown = await prompt.call(session, payload)
      if (!isRecord(result) || result['ok'] !== true) {
        const error = isRecord(result) ? result['error'] : undefined
        const message = isRecord(error) && typeof error['message'] === 'string'
          ? error['message']
          : 'session.prompt failed'
        throw new Error(message)
      }
    },
    async createSession() {
      const holder = remote()
      const session = isRecord(holder) && isRecord(holder.session) ? holder.session : undefined
      const create = session !== undefined && typeof session.create === 'function'
        ? session.create
        : undefined
      if (create === undefined) throw new Error('session.create is missing')
      const value: unknown = await create.call(session, {})
      // 远端信封 {ok, value:{sessionId}} 或直接返回 sessionId，两者都接。
      if (typeof value === 'string') return value
      if (isRecord(value) && value['ok'] === true) {
        const inner = value['value']
        if (isRecord(inner) && typeof inner['sessionId'] === 'string') return inner['sessionId']
      }
      throw new Error('session.create returned no sessionId')
    },
  }
}
