/**
 * Drawing the roll-up into a container.
 *
 * Plain DOM on purpose: this is the one part of the roll-up that has to survive
 * whatever the surrounding page does, and a hand-built tree is the version that
 * is easiest to read and to check. Re-rendering replaces the container's
 * children wholesale, which is cheap at this size and removes a whole class of
 * "the list still shows yesterday's hosts" bugs.
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
    container.append(build(read()))
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

function build(view: RollUpView): Node {
  const root = element('div', { 'data-rollup': '' })
  if (view.empty) {
    root.append(element('p', { 'data-empty': '' }, '没有其他主机在运行。'))
    return root
  }
  for (const host of view.hosts) root.append(hostSection(host))
  return root
}

function hostSection(host: RollUpView['hosts'][number]): Node {
  const section = element('section', { 'data-host-section': host.hostId })
  section.append(element('h3', { 'data-self': String(host.self) }, host.label))
  if (host.empty) {
    section.append(element('p', { 'data-host-empty': '' }, '还没有发布会话。'))
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
