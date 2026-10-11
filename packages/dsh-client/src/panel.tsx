/**
 * The panel itself: one sidebar entry's worth of screen.
 *
 * Everything that decides what the user sees is plain and tested elsewhere —
 * the verdict wording, the probe orchestration, the roll-up section. What is
 * left here is React wiring: one row per agent, the probe state per row, and a
 * div the roll-up section draws into. Looks come from `panel.module.css`, so
 * this file stays about structure and words.
 *
 * There is no restart control, on purpose. A restart ordered from this page
 * must travel through the very channel that is hung; the host drops its own
 * dead connections and rebuilds on the next turn. The panel states that policy
 * (and the probe's verdicts point at the agent's process, not at a button).
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { describeVerdict } from './verdict.ts'
import type { ProbeVerdict } from './verdict.ts'
import type { RollUpSection } from './rollup-section.ts'
import type { AgentDescriptor, GatewayResult } from './gateway.ts'
import type { ProbeOutcome } from './probe.ts'
import styles from './panel.module.css'

/** What one probe attempt is doing, as the row shows it. */
export type ProbeRunState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'running' }
  | { readonly phase: 'done'; readonly verdict: ProbeVerdict; readonly archiveNote?: string }
  | { readonly phase: 'error'; readonly message: string }

/** The agent list, as the page's context reports it. */
export type AgentListPort = {
  /** A snapshot for the first paint; taken once at mount. */
  current(): readonly AgentDescriptor[]
  /** Ask the host's model catalog again; resolves with the fresh list. */
  reload(): Promise<GatewayResult<readonly AgentDescriptor[]>>
}

/** One probe run against one preset, as the panel triggers it. */
export type ProbeStarter = (presetId: string) => Promise<ProbeOutcome>

/** What the panel reads from the page wiring. */
export type AgentPanelProps = {
  readonly agents: AgentListPort
  readonly probe: ProbeStarter
  /** The roll-up section, owned by the wiring so the panel has no setup to do. */
  readonly rollUp: RollUpSection
  /** Said instead of an empty list, so "none listed" never reads as "none configured". */
  readonly agentsNote?: string | undefined
}

/**
 * Whether the agent list has been read from the host at least once.
 *
 * The first snapshot is always empty — the port fetches nothing until asked —
 * so "empty" and "not read yet" are different states, and showing the empty
 * note for the second is how this panel used to open on a false alarm.
 */
type LoadPhase =
  | { readonly stage: 'pristine' }
  | { readonly stage: 'loading' }
  | { readonly stage: 'loaded' }
  | { readonly stage: 'failed'; readonly message: string }

/**
 * Drive one probe and report each phase.
 * @param probe - the wired probe, one preset per call.
 * @param presetId - the agent to ask.
 * @param onPhase - called with the running state and then the outcome.
 * @returns when the probe settled.
 */
export async function runProbe(probe: ProbeStarter, presetId: string, onPhase: (state: ProbeRunState) => void): Promise<void> {
  onPhase({ phase: 'running' })
  try {
    const outcome = await probe(presetId)
    onPhase({
      phase: 'done',
      verdict: outcome.verdict,
      ...(outcome.archiveNote === undefined ? {} : { archiveNote: outcome.archiveNote }),
    })
  } catch (error: unknown) {
    // The wired probe promises not to throw; a wiring that breaks its promise
    // must not take the panel with it.
    onPhase({ phase: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * One agent's row: name, the probe button, the verdict.
 *
 * The verdict is the row's payload, so it leads: a colored state word and the
 * measured number, with the advice one click away instead of printed under
 * everything. @param props - the agent, the current probe state, and the handler.
 * @returns the row.
 */
export function AgentRow(props: {
  readonly presetId: string
  readonly label: string
  readonly verdict?: ProbeRunState | undefined
  readonly onProbe: (presetId: string) => void
}): ReactNode {
  const { presetId, label, verdict } = props
  return (
    <div data-agent={presetId} className={styles.agentRow}>
      <div className={styles.agentHead}>
        <strong data-agent-name="" className={styles.agentName}>{label}</strong>
        <span className={styles.agentId}>{presetId}</span>
        <span className={styles.spacer} />
        <button
          type="button"
          data-action="probe"
          className={styles.action}
          onClick={() => { props.onProbe(presetId) }}
        >探测</button>
      </div>
      <VerdictLine state={verdict} />
    </div>
  )
}

/** The verdict line under one row: state word first, evidence second, advice folded away. */
function VerdictLine(props: {
  readonly state?: ProbeRunState | undefined
}): ReactNode {
  const { state } = props
  if (state?.phase === 'running') {
    return <p data-probe-state="running" className={styles.stateLine}>探测中……（最多等一分钟）</p>
  }
  if (state?.phase === 'error') {
    return <p data-probe-state="error" className={styles.stateBad}>探测出错：{state.message}</p>
  }
  if (state?.phase === 'done') {
    const display = describeVerdict(state.verdict)
    return (
      <div data-probe-state={display.tone} className={styles.verdictLine} data-verdict-tone={display.tone}>
        <span data-verdict-word="" className={styles.verdictWord} data-verdict-tone={display.tone}>{display.headline}</span>
        <span data-verdict-detail="" className={styles.verdictDetail}>{display.detail}</span>
        <details className={styles.verdictMore}>
          <summary className={styles.summary}>建议</summary>
          <p className={styles.verdictAdvice}>{display.advice}</p>
          {state.archiveNote === undefined ? undefined : <p data-archive-note="" className={styles.verdictAdvice}>{state.archiveNote}</p>}
        </details>
      </div>
    )
  }
  return <p data-probe-state="idle" className={styles.stateLine}>未探测</p>
}

/**
 * The panel body: the host's agents on top, the cross-host roll-up under them.
 * @param props - the injected face.
 * @returns the panel.
 */
export function AgentPanel(props: AgentPanelProps): ReactNode {
  const [agents, setAgents] = useState<readonly AgentDescriptor[]>(() => props.agents.current())
  const [load, setLoad] = useState<LoadPhase>(
    () => props.agents.current().length > 0 ? { stage: 'loaded' } : { stage: 'pristine' },
  )
  const [probes, setProbes] = useState<ReadonlyMap<string, ProbeRunState>>(new Map())
  const [hostIdDraft, setHostIdDraft] = useState('')
  const [hostTitleDraft, setHostTitleDraft] = useState('')
  const [identityRevision, setIdentityRevision] = useState(0)

  // A fresh mount reads the catalog once instead of waiting for a click: the
  // panel used to open on "没有列出任何 acp agent" for a host that was serving
  // one, purely because nobody had pressed 刷新 yet.
  useEffect(() => {
    // Runs once per mount: reloading on every phase change would cancel the
    // very read the phase change belongs to (the effect's own setLoad
    // re-triggers it), which is exactly the frozen spinner this used to be.
    let cancelled = false
    setLoad(previous => previous.stage === 'loaded' ? previous : { stage: 'loading' })
    void props.agents.reload().then(result => {
      if (cancelled) return
      if (result.ok) {
        setAgents(result.value)
        setLoad({ stage: 'loaded' })
      } else {
        setLoad({ stage: 'failed', message: result.error.message })
      }
    })
    return () => { cancelled = true }
  }, [props.agents])

  const startProbe = (presetId: string): void => {
    void runProbe(props.probe, presetId, state => {
      setProbes(previous => new Map(previous).set(presetId, state))
    })
  }
  const refreshAgents = (): void => {
    setLoad({ stage: 'loading' })
    void props.agents.reload().then(result => {
      if (result.ok) {
        setAgents(result.value)
        setLoad({ stage: 'loaded' })
      } else {
        setLoad({ stage: 'failed', message: result.error.message })
      }
    })
  }
  const saveIdentity = (): void => {
    const hostId = hostIdDraft.trim()
    const hostTitle = hostTitleDraft.trim()
    props.rollUp.setIdentity({
      ...(hostId === '' ? {} : { hostId }),
      ...(hostTitle === '' ? {} : { hostTitle }),
    })
    // The section's identity is read at render time; this bump is what makes
    // the panel show the new one.
    setIdentityRevision(revision => revision + 1)
  }

  const identity = props.rollUp.identity()
  return (
    <div data-threadharbor-panel="" className={styles.root}>
      <section data-panel-section="agents" className={styles.card}>
        <div className={styles.cardHead}>
          <h2 className={styles.title}>Agent 状态</h2>
          <span className={styles.spacer} />
          <button type="button" data-action="refresh-agents" className={styles.action} onClick={refreshAgents}>刷新</button>
        </div>
        {load.stage === 'loading'
          ? <p data-agents-loading="" className={styles.stateLine}>正在读取本机 agent……</p>
          : load.stage === 'failed'
            ? <p data-agents-failed="" className={styles.stateBad}>读取失败：{load.message}</p>
            : agents.length === 0
              ? (
                  <p data-agents-empty="" className={styles.stateLine}>
                    {props.agentsNote ?? '这台主机没有列出任何 acp agent——可能没有配置预设，或模型目录读取失败；点"刷新"再试。'}
                  </p>
                )
              : (
                  <div className={styles.agentList}>
                    {agents.map(agent => (
                      <AgentRow
                        key={agent.presetId}
                        presetId={agent.presetId}
                        label={agent.label}
                        verdict={probes.get(agent.presetId)}
                        onProbe={startProbe}
                      />
                    ))}
                  </div>
                )}
        <details data-self-heal-note="" className={styles.noteDetails}>
          <summary className={styles.summary}>连接由谁照看</summary>
          <p className={styles.note}>
            连接由主机自己照看：发现断了会自动丢弃并在下一次对话时自动重连，无需在这里操作。
          </p>
        </details>
      </section>
      <section data-panel-section="rollup" className={styles.card}>
        <div className={styles.cardHead}>
          <h2 className={styles.title}>主机汇总</h2>
          <span data-identity-line="" className={styles.identityLine}>
            {identity.hostTitle} · {identity.hostId}{identity.derived ? '（未配置，按页面来源生成）' : ''}
          </span>
        </div>
        <div ref={attachRollUp(props.rollUp)} data-rollup-host="" className={styles.rollupHost} />
        <ul data-panel-notices="" className={styles.notices}>
          {props.rollUp.notices().map(notice => <li key={notice}>{notice}</li>)}
        </ul>
        <details className={styles.noteDetails}>
          <summary className={styles.summary}>主机身份与说明</summary>
          <form
            data-identity-form=""
            className={styles.identityForm}
            onSubmit={event => {
              event.preventDefault()
              saveIdentity()
            }}
          >
            <label className={styles.field}>
              主机 id
              <input
                value={hostIdDraft}
                data-identity-host-id=""
                className={styles.input}
                onChange={event => { setHostIdDraft(event.target.value) }}
                placeholder="留空则自动生成"
              />
            </label>
            <label className={styles.field}>
              名称
              <input
                value={hostTitleDraft}
                data-identity-host-title=""
                className={styles.input}
                onChange={event => { setHostTitleDraft(event.target.value) }}
                placeholder="如：工作室主机"
              />
            </label>
            <button type="submit" data-identity-save="" className={styles.actionPrimary}>保存身份</button>
          </form>
          <p className={styles.note}>
            这里没有「添加主机」的入口，是如实呈现：同一个浏览器里打开的每个页面会自动出现在上面的汇总里，
            只要给这台主机起个名字；另一台机器的页面不在这个通道里，不会出现，也就无法在这里添加。
          </p>
        </details>
      </section>
    </div>
  )
}

/** Place the section's element; the section keeps owning it across remounts. */
function attachRollUp(section: RollUpSection): (host: HTMLDivElement | null) => void {
  return host => {
    if (host === null) return
    host.replaceChildren(section.element())
  }
}
