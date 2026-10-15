/**
 * The left sidebar's host → project → session tree.
 *
 * Pure rendering plus dispatch: no fetching happens here (the shadow component
 * that owns polling feeds this one a ready `RollUpView`), so every row's
 * behavior is click-verifiable without network stubs. Honesty rules: an
 * undeployed host says so instead of showing an empty-but-true-looking list,
 * and a failed fetch shows its raw reason verbatim.
 */
import { useCallback, useEffect, useState } from 'react'
import type { RollUpView } from '@threadharbor/dsh-host-federation'
import { openLocalSession, startSessionInProject } from './session-actions.ts'
import type { RuntimeT } from './locales.ts'
import styles from './host-session-tree.module.css'

export type SessionActionsCtx = { get(name: string): unknown }

const EXPANDED_KEY = 'threadharbor.tree.expanded'

type Props = {
  readonly view: RollUpView
  readonly ctx: SessionActionsCtx
  /** Stage-L bridge: a remote or undeployed host row goes to its detail page. */
  readonly onOpenHostPage: (hostId: string) => void
  readonly initialExpanded?: readonly string[]
  readonly t: RuntimeT
}

function readExpanded(): string[] {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY)
    const parsed: unknown = raw === null ? undefined : JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

export function HostSessionTree({ view, ctx, onOpenHostPage, initialExpanded, t }: Props) {
  const [openFailed, setOpenFailed] = useState(false)

  const [expanded, setExpanded] = useState<readonly string[]>(() => {
    const stored = readExpanded()
    return stored.length > 0 || initialExpanded === undefined ? stored : [...initialExpanded]
  })

  useEffect(() => {
    try {
      localStorage.setItem(EXPANDED_KEY, JSON.stringify(expanded))
    } catch {
      // Expanded-state memory is a convenience; a failing store must not take the tree down.
    }
  }, [expanded])

  const toggle = useCallback((hostId: string) => {
    setExpanded(current => current.includes(hostId) ? current.filter(id => id !== hostId) : [...current, hostId])
  }, [])


  return (
    <div className={styles.tree} data-host-tree>
      {view.hosts.map(host => {
        const open = host.self || expanded.includes(host.hostId)
        return (
          <section
            key={host.hostId}
            className={host.undeployed === true ? styles.hostUndeployed : styles.host}
            data-host-node={host.hostId}
            data-undeployed={host.undeployed === true ? 'true' : undefined}
          >
            <button
              type="button"
              className={styles.hostRow}
              data-host-toggle
              onClick={() => {
                // An undeployed host has nothing to expand; its click belongs to
                // the detail page, where the deploy flow lives.
                if (host.undeployed === true) onOpenHostPage(host.hostId)
                else toggle(host.hostId)
              }}
            >
              <span className={styles.hostDot} data-host-online={host.self || host.empty === false ? 'true' : 'false'} />
              <span className={styles.hostLabel}>{host.label}</span>
              <span className={styles.hostCount}>{host.empty ? '' : host.sessionCount}</span>
            </button>
            {host.undeployed === true
              ? <p className={styles.note} data-undeployed-note>{t('panel.tree.undeployedNote')}</p>
              : null}
            {host.note !== undefined
              ? host.self
                ? <p className={styles.note} data-local-note>{host.note}</p>
                : <p className={styles.error} data-host-error>{t('panel.tree.fetchFailedTitle')}{host.note}</p>
              : null}
            {open && !host.self && host.projects.length === 0 && host.undeployed !== true
              ? <p className={styles.note}>{t('panel.tree.noSessions')}</p>
              : null}
            {open ? host.projects.map(project => (
              <div key={project.projectId} className={styles.project} data-project-group={project.projectId}>
                <div className={styles.projectRow}>
                  <span className={styles.projectLabel}>{project.label}</span>
                  {host.self
                    ? <button
                        type="button"
                        className={styles.newSession}
                        title={t('panel.tree.newSession')}
                        data-action="tree-new-session"
                        onClick={() => { startSessionInProject(ctx, project.projectId) }}
                      >
                        ＋
                      </button>
                    : null}
                </div>
                {project.sessions.map(session => (
                  <button
                    key={session.sessionId}
                    type="button"
                    className={styles.sessionRow}
                    data-session-row={session.sessionId}
                    onClick={() => {
                      if (host.self) setOpenFailed(openLocalSession(ctx, session.sessionId) === false)
                      else onOpenHostPage(host.hostId)
                    }}
                  >
                    <span className={styles.sessionTitle}>{session.title}</span>
                  </button>
                ))}
              </div>
            )) : null}
          </section>
        )
      })}
      {openFailed
        ? <p className={styles.error} data-open-failed>{t('panel.tree.openFailed')}</p>
        : null}
      {view.hosts.length === 0
        ? <p className={styles.note}>{t('panel.tree.noHosts')}</p>
        : null}
    </div>
  )
}
