/**
 * Agent + model picker for the remote composer.
 *
 * One control, two decisions: which Agent answers, and which model it uses.
 * They live together because they are the same choice in practice — a model
 * only exists inside the Agent that offers it, and the Agent cannot change
 * inside a live session. Picking a different Agent therefore continues the
 * conversation on a new session with its history carried over, while picking a
 * model inside the current Agent just switches it.
 *
 * The Agent list is rendered from the host inventory, which is already loaded
 * and free. The model list is not: an Agent publishes its models once, when a
 * session opens, so another Agent's models are fetched only when the user opens
 * that Agent — probing every installed Agent up front would start every Agent
 * on the remote for a menu the user may scroll past. A live probe keeps itself
 * current because the Agent pushes changes to whoever is listening, so the
 * refresh button is a manual "check again", not the mechanism that keeps this
 * honest.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  IconCheckOutline16,
  IconChevronDownOutline14,
  IconDataOutline16,
  IconRefreshOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { RemoteAgentBackend } from '@threadharbor/protocol'
import css from './RemoteSurface.module.css'

export interface PickerModel {
  readonly value: string
  readonly name: string
  readonly description?: string | undefined
}

export interface PickerAgent {
  readonly backend: RemoteAgentBackend
  /** False when the host has the Agent installed but not signed in. */
  readonly ready: boolean
  /** Human-readable reason when `ready` is false. */
  readonly detail?: string | undefined
}

export interface AgentModelPickerProps {
  /** Agent running the current session. */
  readonly currentBackend: RemoteAgentBackend
  /** Model currently selected on that Agent. */
  readonly currentModel: string
  /** Models the current Agent has published. */
  readonly currentModels: readonly PickerModel[]
  /** Every Agent installed on this host. */
  readonly agents: readonly PickerAgent[]
  /** Fetch one Agent's models. Resolves empty when it has none to report. */
  readonly loadModels: (backend: RemoteAgentBackend) => Promise<readonly PickerModel[]>
  /** Continue this conversation on another Agent. */
  readonly onSwitchAgent: (backend: RemoteAgentBackend) => void
  /** Switch model inside the current Agent. */
  readonly onSelectModel: (value: string) => void
  readonly disabled?: boolean | undefined
}

interface AgentEntry {
  readonly backend: RemoteAgentBackend
  readonly ready: boolean
  readonly detail?: string | undefined
  /** 'idle' before it is ever opened, 'loading' while probing, then 'ready'. */
  readonly state: 'idle' | 'loading' | 'ready' | 'empty'
  readonly models: readonly PickerModel[]
}

export function AgentModelPicker({
  currentBackend,
  currentModel,
  currentModels,
  agents,
  loadModels,
  onSwitchAgent,
  onSelectModel,
  disabled,
}: AgentModelPickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  /** Per-agent fetch state. The current Agent starts ready — its list is here. */
  const [loaded, setLoaded] = useState<Record<string, { state: AgentEntry['state']; models: readonly PickerModel[] }>>({})
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const requestSeq = useRef(0)
  const id = useId()

  // Seed the current Agent's entry from what the session already published, so
  // opening the menu never re-asks for the list we are already holding.
  useEffect(() => {
    setLoaded(previous => previous[currentBackend] === undefined
      ? {
        ...previous,
        [currentBackend]: { state: currentModels.length > 0 ? 'ready' : 'empty', models: currentModels },
      }
      : previous)
  }, [currentBackend, currentModels])

  const currentLabel = useMemo(() => {
    const match = currentModels.find(model => model.value === currentModel)
    if (match === undefined) return currentModel === 'default' ? '默认' : currentModel
    const separator = match.name.indexOf(' · ')
    return separator >= 0 ? match.name.slice(separator + 3) : match.name
  }, [currentModel, currentModels])

  const entries: readonly AgentEntry[] = useMemo(() => agents.map(agent => {
    const state = loaded[agent.backend]
    return {
      ...agent,
      state: state?.state ?? 'idle',
      models: state?.models ?? [],
    }
  }), [agents, loaded])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle === '') return entries
    return entries
      .map(entry => ({
        ...entry,
        models: entry.models.filter(model => model.name.toLowerCase().includes(needle)),
      }))
      .filter(entry => entry.backend.includes(needle) || entry.models.length > 0)
  }, [entries, query])

  // Positioned from the trigger's viewport rect (the composer is at the bottom,
  // so the menu opens upward). Fixed rather than portalled: this bundle has no
  // react-dom, and no ancestor of the composer creates a containing block.
  const [menuStyle, setMenuStyle] = useState<{ left: number; bottom: number; maxHeight: number } | undefined>(undefined)
  const reposition = (): void => {
    const rect = buttonRef.current?.getBoundingClientRect()
    if (rect === undefined) return
    setMenuStyle({
      left: rect.left,
      bottom: window.innerHeight - rect.top + 6,
      maxHeight: Math.min(380, Math.max(180, rect.top - 8)),
    })
  }

  useEffect(() => {
    if (!open) return undefined
    reposition()
    const onScroll = (): void => reposition()
    const onResize = (): void => reposition()
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node | null
      if (target === null) return
      if (buttonRef.current?.contains(target) === true || menuRef.current?.contains(target) === true) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    setQuery('')
    const timer = window.setTimeout(() => searchRef.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [open])

  /** Probe one Agent, at most one in flight per Agent. */
  const ensure = (backend: RemoteAgentBackend): void => {
    const existing = loaded[backend]
    if (existing !== undefined && existing.state !== 'idle') return
    const seq = ++requestSeq.current
    setLoaded(previous => ({ ...previous, [backend]: { state: 'loading', models: [] } }))
    void loadModels(backend).then(models => {
      // A newer request for the same Agent already answered; that answer wins.
      if (seq !== requestSeq.current && loaded[backend] !== undefined) return
      setLoaded(previous => ({
        ...previous,
        [backend]: { state: models.length > 0 ? 'ready' : 'empty', models },
      }))
    }).catch(() => {
      setLoaded(previous => ({ ...previous, [backend]: { state: 'empty', models: [] } }))
    })
  }

  const refresh = (backend: RemoteAgentBackend): void => {
    const seq = ++requestSeq.current
    setLoaded(previous => ({ ...previous, [backend]: { state: 'loading', models: previous[backend]?.models ?? [] } }))
    void loadModels(backend).then(models => {
      if (seq !== requestSeq.current && loaded[backend] !== undefined) return
      setLoaded(previous => ({ ...previous, [backend]: { state: models.length > 0 ? 'ready' : 'empty', models } }))
    }).catch(() => {
      setLoaded(previous => ({ ...previous, [backend]: { state: 'empty', models: [] } }))
    })
  }

  const chooseAgent = (backend: RemoteAgentBackend): void => {
    if (backend === currentBackend) {
      setOpen(false)
      return
    }
    setOpen(false)
    onSwitchAgent(backend)
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={css.modelSelectButton}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        title="选择 Agent 与模型"
        onClick={() => { setOpen(value => !value) }}
      >
        <IconDataOutline16 className={css.modelSelectIcon} />
        <span className={css.modelSelectLabel}>{currentLabel}</span>
        <span className={css.modelSelectAgent}>{currentBackend}</span>
        <IconChevronDownOutline14 className={`${css.modelSelectChevron} ${open ? css.modelSelectChevronOpen : ''}`} />
      </button>
      {open && menuStyle !== undefined && (
        <div
          ref={menuRef}
          className={css.modelMenu}
          role="menu"
          id={`${id}-menu`}
          style={{ left: menuStyle.left, bottom: menuStyle.bottom, maxHeight: menuStyle.maxHeight }}
        >
          <input
            ref={searchRef}
            className={css.modelMenuSearch}
            type="text"
            value={query}
            placeholder="搜索 Agent 或模型"
            onChange={(event) => { setQuery(event.target.value) }}
            onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false) } }}
          />
          <div className={css.modelMenuList}>
            {visible.length === 0 && <div className={css.modelMenuEmpty}>无匹配项</div>}
            {visible.map(entry => (
              <div key={entry.backend} className={css.modelMenuGroup}>
                <div className={css.modelMenuAgentRow}>
                  <button
                    type="button"
                    role="menuitem"
                    className={`${css.modelMenuAgent} ${entry.backend === currentBackend ? css.modelMenuItemActive : ''}`}
                    title={entry.detail ?? (entry.backend === currentBackend ? '当前 Agent' : `切换到 ${entry.backend}`)}
                    disabled={!entry.ready}
                    onClick={() => { chooseAgent(entry.backend) }}
                  >
                    <span className={css.modelMenuAgentName}>{entry.backend}</span>
                    {entry.ready
                      ? entry.backend === currentBackend
                        ? <IconCheckOutline16 className={css.modelMenuCheck} />
                        : null
                      : <span className={css.modelMenuAgentState}>{entry.detail ?? '不可用'}</span>}
                  </button>
                  {entry.ready && (
                    <button
                      type="button"
                      className={css.modelMenuRefresh}
                      title={`重新获取 ${entry.backend} 的模型列表`}
                      aria-label={`刷新 ${entry.backend} 的模型列表`}
                      disabled={entry.state === 'loading'}
                      onClick={() => { refresh(entry.backend) }}
                    >
                      <IconRefreshOutline16 className={entry.state === 'loading' ? css.modelMenuSpinning : undefined} />
                    </button>
                  )}
                </div>
                {entry.state === 'loading' && entry.models.length === 0 && (
                  <div className={css.modelMenuEmpty}>正在获取模型列表…</div>
                )}
                {entry.state === 'ready' && entry.models.length === 0 && (
                  <div className={css.modelMenuEmpty}>该 Agent 没有公布模型</div>
                )}
                {entry.models.map(model => (
                  <button
                    key={`${entry.backend}:${model.value}`}
                    type="button"
                    role="menuitem"
                    className={`${css.modelMenuItem} ${entry.backend === currentBackend && model.value === currentModel ? css.modelMenuItemActive : ''}`}
                    title={model.description ?? model.name}
                    disabled={!entry.ready}
                    onClick={() => {
                      if (entry.backend !== currentBackend) { chooseAgent(entry.backend); return }
                      setOpen(false)
                      if (model.value !== currentModel) onSelectModel(model.value)
                    }}
                  >
                    <span className={css.modelMenuItemName}>{model.name}</span>
                    {entry.backend === currentBackend && model.value === currentModel
                      ? <IconCheckOutline16 className={css.modelMenuCheck} />
                      : null}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}