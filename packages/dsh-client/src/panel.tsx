/**
 * The panel itself: one sidebar entry's worth of screen.
 *
 * Everything that decides what the user sees is plain and tested elsewhere —
 * the verdict wording, the probe orchestration, the roll-up section. What is
 * left here is React wiring: one row per agent, the probe state per row, and a
 * div the roll-up section draws into.
 *
 * There is no restart control, on purpose. A restart ordered from this page
 * must travel through the very channel that is hung; the host drops its own
 * dead connections and rebuilds on the next turn. The panel states that policy
 * (and the probe's verdicts point at the agent's process, not at a button).
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { describeVerdict } from './verdict.ts'
import type { ProbeVerdict } from './verdict.ts'
import type { RollUpSection } from './rollup-section.ts'
import type { AgentDescriptor, GatewayResult } from './gateway.ts'
import type { ProbeOutcome } from './probe.ts'

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
 * @param props - the agent, the current probe state, and the handler.
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
    <div data-agent={presetId} style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 0', borderTop: '1px solid var(--dsh-border, #e5e5e5)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong data-agent-name="">{label}</strong>
        <span style={{ opacity: 0.6 }}>{presetId}</span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          data-action="probe"
          onClick={() => { props.onProbe(presetId) }}
        >探测</button>
      </div>
      <VerdictLine state={verdict} />
    </div>
  )
}

/** The verdict line under one row: what the probe found, and what to do. */
function VerdictLine(props: {
  readonly state?: ProbeRunState | undefined
}): ReactNode {
  const { state } = props
  if (state?.phase === 'running') {
    return <p data-probe-state="running" style={{ margin: 0, opacity: 0.7 }}>探测中……（最多等一分钟）</p>
  }
  if (state?.phase === 'error') {
    return <p data-probe-state="error" style={{ margin: 0 }}>探测出错：{state.message}</p>
  }
  if (state?.phase === 'done') {
    const display = describeVerdict(state.verdict)
    return (
      <p data-probe-state={display.tone} style={{ margin: 0 }}>
        {`${display.headline} · ${display.detail} —— ${display.advice}`}
        {state.archiveNote === undefined ? undefined : <span data-archive-note=""> {state.archiveNote}</span>}
      </p>
    )
  }
  return <p data-probe-state="idle" style={{ margin: 0, opacity: 0.6 }}>尚未探测。</p>
}

/**
 * The panel body: the host's agents on top, the cross-host roll-up under them.
 * @param props - the injected face.
 * @returns the panel.
 */
export function AgentPanel(props: AgentPanelProps): ReactNode {
  const [agents, setAgents] = useState<readonly AgentDescriptor[]>(() => props.agents.current())
  const [probes, setProbes] = useState<ReadonlyMap<string, ProbeRunState>>(new Map())
  const [hostIdDraft, setHostIdDraft] = useState('')
  const [hostTitleDraft, setHostTitleDraft] = useState('')
  const [identityRevision, setIdentityRevision] = useState(0)

  const startProbe = (presetId: string): void => {
    void runProbe(props.probe, presetId, state => {
      setProbes(previous => new Map(previous).set(presetId, state))
    })
  }
  const refreshAgents = (): void => {
    void props.agents.reload().then(result => {
      if (result.ok) setAgents(result.value)
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
    <div data-threadharbor-panel="" style={{ padding: 16, overflow: 'auto', height: '100%', boxSizing: 'border-box' }}>
      <section data-panel-section="agents">
        <h2 style={{ margin: '0 0 4px' }}>Agent 探测</h2>
        <p data-self-heal-note="" style={{ margin: '0 0 8px', opacity: 0.75 }}>
          连接由主机自己照看：发现断了会自动丢弃并在下一次对话时自动重连，无需在这里操作。
        </p>
        {agents.length === 0
          ? (
              <p data-agents-empty="" style={{ margin: 0 }}>
                {props.agentsNote ?? '这台主机没有列出任何 acp agent——可能没有配置预设，或模型目录读取失败；点"刷新"再试。'}
              </p>
            )
          : agents.map(agent => (
              <AgentRow
                key={agent.presetId}
                presetId={agent.presetId}
                label={agent.label}
                verdict={probes.get(agent.presetId)}
                onProbe={startProbe}
              />
            ))}
        <button type="button" data-action="refresh-agents" onClick={refreshAgents} style={{ marginTop: 8 }}>刷新</button>
      </section>
      <section data-panel-section="rollup" style={{ marginTop: 16 }}>
        <h2 style={{ margin: '0 0 4px' }}>跨主机汇总</h2>
        <p data-identity-line="" style={{ margin: '0 0 8px', opacity: 0.8 }}>
          本机身份：{identity.hostTitle}（id {identity.hostId}{identity.derived ? '，未配置，按页面来源生成' : ''}）
        </p>
        <form
          data-identity-form=""
          style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 8 }}
          onSubmit={event => {
            event.preventDefault()
            saveIdentity()
          }}
        >
          <label>
            主机 id{' '}
            <input
              value={hostIdDraft}
              data-identity-host-id=""
              onChange={event => { setHostIdDraft(event.target.value) }}
              placeholder="留空则自动生成"
              size={16}
            />
          </label>
          <label>
            名称{' '}
            <input
              value={hostTitleDraft}
              data-identity-host-title=""
              onChange={event => { setHostTitleDraft(event.target.value) }}
              placeholder="如：工作室主机"
              size={16}
            />
          </label>
          <button type="submit" data-identity-save="">保存身份</button>
        </form>
        <div ref={attachRollUp(props.rollUp)} data-rollup-host="" />
        <ul data-panel-notices="" style={{ margin: '8px 0 0', paddingLeft: 18, opacity: 0.75 }}>
          {props.rollUp.notices().map(notice => <li key={notice}>{notice}</li>)}
        </ul>
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
