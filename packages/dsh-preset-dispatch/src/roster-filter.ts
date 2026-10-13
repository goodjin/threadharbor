/**
 * Keeping the ACP presets out of the preset picker.
 *
 * Why they are registered at all: the whole switching machine runs on preset
 * registration. The registry mounts a declared preset eagerly, which is what
 * keeps the dispatch rows live and their models in the global catalog — the
 * model list the user switches agents from. The model → preset follow then
 * turns a pick of an `acp:` route into a session on that agent, in place for a
 * blank session or as a handover for a started one. None of that survives
 * deleting the declarations.
 *
 * Why they should not be listed: the picker is a second, redundant door to the
 * same agents. DSH has no "registered but hidden" flag — the roster is one
 * list that feeds the new-session seat, the settings section, and the session
 * header's label — so hiding means filtering the roster at the exit the client
 * actually reads: `remoteExportList`, the registry's remote-facing method.
 *
 * What must NOT be filtered: the registry's internal `list()`. The follow
 * checks its target against that list before moving a session, so a filter
 * that reached it would quietly refuse every switch it exists to enable. Only
 * the client-facing export is wrapped.
 *
 * The gateway resolves the method on the live service instance at call time
 * (`Reflect.get(receiver, implementation)` in dsh-api-gateway's
 * prepareInvocation), so replacing the own property intercepts remote calls —
 * verified against the running version, not assumed.
 */

import Schema from '@deepseek-ai/schemastery'

export const name = 'threadharbor-roster-filter'

/**
 * The preset ids to keep out of the picker, as the composition declares them.
 *
 * Required: a filter row that names nothing hides nothing, and a silent no-op
 * row is exactly the "loaded but did it?" ambiguity the self-report exists to
 * answer.
 */
export const Config: Schema<Config> = Schema.object({
  hide: Schema.array(Schema.string()).required(),
})

export type Config = {
  hide: string[]
}

/** One roster row as this filter reads it — the id, plus whatever survives. */
type RosterRow = { readonly id?: unknown }

/** The roster shape `remoteExportList` answers with. */
type Roster = { readonly presets?: unknown }

/**
 * The pristine export method, per service.
 *
 * Only the original is remembered — never the wrap currently installed — so a
 * config reload rebuilds on it instead of stacking wrappers. Compounding
 * filters could never un-hide an id, and a reload that only added to the hide
 * list would leave edits the other way silently ignored.
 */
const originals = new WeakMap<object, () => Promise<Roster>>()

/**
 * The pure half: which rows the client gets to see.
 *
 * Typed as a passthrough of the roster it was handed — callers that know a
 * richer row shape (the tests, or a future import of the registry types) keep
 * it, and the runtime guard below is what actually decides, not the types.
 *
 * Rows are dropped whole, never rewritten — the survivors keep isDefault and
 * every other field, because filtering is how a row leaves the picker, not how
 * the rest of the roster gets edited.
 */
export function visibleRoster<T extends Roster>(roster: T, hide: readonly string[]): T {
  const hidden = new Set(hide)
  const rows = roster.presets
  if (!Array.isArray(rows)) return roster
  const kept = rows.filter(row => !isHidden(row, hidden))
  return { ...roster, presets: kept } as T
}

function isHidden(row: unknown, hidden: ReadonlySet<string>): boolean {
  if (typeof row !== 'object' || row === null) return false
  const id = (row as RosterRow).id
  return typeof id === 'string' && hidden.has(id)
}

/**
 * Wrap one registry service so its client-facing roster omits the named ids.
 *
 * @param service - the `agentPresets` service instance.
 * @param hide - the preset ids to keep out of the picker.
 * @param report - the loud channel; every way this declines to act says so here.
 * @returns whether the wrap was installed.
 */
export function hideFromRoster(
  service: object,
  hide: readonly string[],
  report: (message: string) => void,
): boolean {
  const holder = service as { remoteExportList?: unknown }
  const original = originals.get(service) ?? holder.remoteExportList
  if (typeof original !== 'function') {
    report(`roster filter: this registry has no remoteExportList to filter — the picker will list the ACP presets; the DSH shape must have changed`)
    return false
  }
  const bound = original.bind(service)
  holder.remoteExportList = async (): Promise<Roster> => {
    const roster = await bound() as Roster
    // An answer this filter does not recognise goes to the client untouched:
    // breaking the roster would take the picker down with it, and the report
    // below is what keeps "not filtering" visible rather than silent.
    if (!Array.isArray(roster?.presets)) {
      report(`roster filter: the roster answer has no presets list — passing it through unfiltered`)
      return roster
    }
    return visibleRoster(roster, hide)
  }
  originals.set(service, original as () => Promise<Roster>)
  return true
}

/**
 * Mount: wait for the registry, then hide the named ids from its roster.
 *
 * `inject` defers this half until the service exists, and re-runs it if the
 * registry is ever replaced — the new instance is wrapped the same way. A
 * missing `inject` on the context falls back to one immediate attempt, so a
 * context without the seam still loads the row and says what happened.
 */
export function apply(ctx: unknown, config: Config): void {
  const report = (message: string) => {
    const logger = (ctx as { logger?: { warn(message: string): void } } | null)?.logger
    logger?.warn(message)
    process.stderr.write(`[threadharbor] ${message}\n`)
  }
  const mount = (service: unknown): void => {
    if (typeof service !== 'object' || service === null) {
      report('roster filter: the agentPresets service is not an object — nothing to filter')
      return
    }
    const done = hideFromRoster(service, config.hide, report)
    if (done) {
      report(`roster filter mounted: [${config.hide.join(', ')}] stay out of the preset picker; model-list switching is untouched`)
    }
  }
  const injector = (ctx as { inject?(deps: string[], body: (child: unknown) => void): unknown } | null)?.inject
  if (typeof injector === 'function') {
    injector.call(ctx, ['agentPresets'], child => {
      mount((child as { agentPresets?: unknown } | null)?.agentPresets)
    })
    return
  }
  mount((ctx as { agentPresets?: unknown } | null)?.agentPresets)
}
