/**
 * Drawing the roll-up into a container.
 *
 * Plain DOM on purpose: this is the one part of the roll-up that has to survive
 * whatever the surrounding page does, and a hand-built tree is the version that
 * is easiest to read and to check. Re-rendering replaces the container's
 * children wholesale, which is cheap at this size and removes a whole class of
 * "the list still shows yesterday's hosts" bugs.
 *
 * The tree is host → project → session, and the host row is where status lives:
 * a badge (本机 / 在线), a one-line count, and — folded into a `<details>` — the
 * id, the last-seen age, and whatever note the owner supplies. Session rows
 * carry none of that: a conversation is a title, nothing else.
 *
 * Every id a click needs is on the row as a data attribute, so a host that
 * renders this into its own framework can delegate without walking the tree.
 */

import type { RollUpView, SessionView } from './rollup-view.ts'

export type SessionTarget = { sessionId: string; projectId: string; hostId: string }

export type RollUpMountOptions = {
  /** Called with the row's session and the machine that holds it. */
  onSelect?(target: SessionTarget): void
  /** Called when a project heading is chosen; absent means it is not clickable. */
  onSelectProject?(target: { projectId: string; hostId: string }): void
  /** The clock behind "最近心跳 N 秒前"; defaults to the real one. */
  now?(): number
  /**
   * One plain-language note per host, shown folded inside that host's details —
   * why its rows may be empty, what its presence means. Absent means the host
   * gets no details block at all.
   */
  hostNote?(host: RollUpView['hosts'][number]): string | undefined
}

export type RollUpMount = {
  /** Draw the current view. Safe to call as often as the data changes. */
  render(): void
  dispose(): void
}

export function mountRollUp(
  container: HTMLElement,
  read: () => RollUpView,
  options: RollUpMountOptions = {},
): RollUpMount {
  let disposed = false

  const render = (): void => {
    if (disposed) return
    // Wholesale rather than reconciled: at a handful of rows this is cheaper
    // than the bookkeeping, and it cannot leave a stale host behind.
    container.replaceChildren()
    container.append(build(read(), options))
  }

  const detach = onRollUpClick(container, read, options)
  render()
  return {
    render,
    dispose: () => {
      disposed = true
      // The listener outlives the nodes it reads, so it has to go too — a stale
      // click would resolve against a view that is no longer on screen.
      detach()
      container.replaceChildren()
    },
  }
}

function build(view: RollUpView, options: RollUpMountOptions): Node {
  const root = element('div', { 'data-rollup': '' })
  if (view.empty) {
    root.append(element('p', { 'data-empty': '' }, '现在没有任何主机在线——包括本页自己。刷新页面，或检查这个面板是否已启用。'))
    return root
  }
  for (const host of view.hosts) root.append(hostSection(host, options))
  return root
}

function hostSection(host: RollUpView['hosts'][number], options: RollUpMountOptions): Node {
  const section = element('section', {
    'data-host-section': host.hostId,
    'data-host-self': String(host.self),
  })
  const head = element('div', { 'data-host-head': '' })
  head.append(element('h3', { 'data-host-name': '' }, host.label))
  head.append(element('span', {
    'data-host-badge': host.self ? 'self' : 'online',
  }, host.self ? '本机' : '在线'))
  head.append(element('span', { 'data-host-count': '' }, host.empty
    ? '没有会话'
    : `${host.projects.length} 个项目 · ${host.sessionCount} 个会话`))
  section.append(head)

  const note = options.hostNote?.(host)
  if (note !== undefined || !host.self) {
    const details = element('details', { 'data-host-details': '' })
    details.append(element('summary', { 'data-host-details-summary': '' }, '说明'))
    if (note !== undefined) details.append(element('p', { 'data-host-note': '' }, note))
    if (!host.self) {
      details.append(element('p', { 'data-host-seen': '' }, `主机标识 ${host.hostId} · 最近心跳 ${ageOf(host.lastSeen, options.now)}`))
    }
    // A details block with a single empty paragraph would be an empty shell.
    if (details.childElementCount > 1) section.append(details)
  }

  if (host.empty) {
    section.append(element('p', { 'data-host-empty': '' }, host.self
      ? '本机还没有会话。'
      : '这台主机没有发布任何会话。'))
    return section
  }
  for (const project of host.projects) section.append(projectBlock(project, host.hostId))
  return section
}

function projectBlock(
  project: RollUpView['hosts'][number]['projects'][number],
  hostId: string,
): Node {
  const block = element('div', { 'data-project-block': project.projectId })
  const heading = element('h4', { 'data-project': project.projectId }, project.label)
  // The same name on two hosts is two projects (§8.3): when the view qualified
  // the label, say so on the row, not only in the text.
  if (project.sharedName) heading.setAttribute('data-project-shared', '')
  block.append(heading)
  for (const session of project.sessions) block.append(sessionRow(session))
  return block
}

function sessionRow(session: SessionView): HTMLElement {
  const row = element('button', {
    'data-session': session.sessionId,
    'data-project': session.projectId,
    'data-host': session.hostId,
    'data-own': String(session.own),
    type: 'button',
  }, session.title)
  return row
}

/** Whole seconds since `at`, phrased for a status line. */
function ageOf(at: number, now?: () => number): string {
  const seconds = Math.max(0, Math.round(((now ?? Date.now)() - at) / 1000))
  if (seconds < 60) return `${seconds} 秒前`
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`
  return `${Math.round(seconds / 3600)} 小时前`
}

/** Click handling, kept apart so the renderer stays free of listeners. */
export function onRollUpClick(
  container: HTMLElement,
  read: () => RollUpView,
  options: RollUpMountOptions,
): () => void {
  const listener = (event: Event): void => {
    const target = event.target as HTMLElement | null
    const sessionRow = target?.closest<HTMLElement>('[data-session]')
    if (sessionRow !== null && sessionRow !== undefined && container.contains(sessionRow)) {
      const sessionId = sessionRow.dataset['session'] ?? ''
      const found = findSession(read(), sessionId)
      options.onSelect?.({
        sessionId,
        projectId: sessionRow.dataset['project'] ?? '',
        hostId: found?.hostId ?? sessionRow.dataset['host'] ?? '',
      })
      return
    }
    const projectBlock = target?.closest<HTMLElement>('[data-project-block]')
    if (projectBlock !== null && projectBlock !== undefined && container.contains(projectBlock)) {
      const projectId = projectBlock.dataset['projectBlock'] ?? ''
      const hostId = findProjectHost(read(), projectId)
      options.onSelectProject?.({ projectId, hostId })
    }
  }
  container.addEventListener('click', listener)
  return () => { container.removeEventListener('click', listener) }
}

function findSession(view: RollUpView, sessionId: string): SessionView | undefined {
  for (const host of view.hosts) {
    for (const project of host.projects) {
      const found = project.sessions.find(session => session.sessionId === sessionId)
      if (found !== undefined) return found
    }
  }
  return undefined
}

function findProjectHost(view: RollUpView, projectId: string): string {
  for (const host of view.hosts) {
    if (host.projects.some(project => project.projectId === projectId)) return host.hostId
  }
  return ''
}

function element(tag: string, attributes: Record<string, string>, content?: string): HTMLElement {
  const node = document.createElement(tag)
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value)
  if (content !== undefined) node.textContent = content
  return node
}
