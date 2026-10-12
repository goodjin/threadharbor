/**
 * The host-side slot that the browser's host-scoped settings persist through.
 *
 * Why this entry exists: the browser used to keep the host registry and this
 * machine's default identity in `window.localStorage`, so they died with the
 * browser — a new context, a new browser, or a cleared cache lost every
 * registered host. The design (docs/design/dsh-multi-host-migration.md, the
 * settings-channel note near line 300) sends identity and shared
 * configuration through the **settings channel** instead: a host-side plugin
 * registers a namespace, and the browser reads and writes it over
 * `ctx.remote.settings`. The values then live in this host's profile
 * document — on the machine, not in any browser.
 *
 * The whole mechanism is declarative, and that is the point: DSH's settings
 * service turns every active composition entry that has a **volatile** config
 * field into a settings namespace (see `volatileForm` in DSH's
 * `packages/settings/settings/src/schema.ts`). So this entry carries exactly
 * one volatile field — `data`, a string-to-string dictionary — and no
 * behavior. The browser stores the same two JSON-string keys it always did
 * (`dsh.host.registry`, `dsh.host.identity`), which is also what makes
 * migration a plain copy.
 *
 * Nothing else may live here: a behavior-bearing entry would make every
 * settings write re-enter this file's fate, and a second non-volatile field
 * would tempt configuration by hand for something only the browser should
 * write.
 */

import Schema from '@deepseek-ai/schemastery'
import { HOST_STORE_ENTRY_ID } from './host-store-id.ts'

export { HOST_STORE_ENTRY_ID }

export const name = HOST_STORE_ENTRY_ID

/**
 * The shape of the stored document, as the browser writes it. Declared beside
 * the schema rather than on it: the schema's own type wraps volatile fields in
 * refs, and annotating `Schema<Config>` makes the two fight.
 */
export type Config = {
  data?: Record<string, string>
}

/**
 * The one field the browser persists through, and it must stay volatile:
 * non-volatile config is invisible to the settings channel, so the namespace
 * would simply not exist and the browser would read "namespace missing".
 * Annotated as plain `Schema` — the precise inferred type drags cosmokit's
 * `Dict` into this package's public surface, which TS rightly refuses; the
 * runtime schema is what the settings channel serves, and {@link Config}
 * documents its shape.
 */
export const Config: Schema = Schema.object({
  data: Schema.dict(Schema.string()).volatile(),
})

/**
 * Mount. The entry is a carrier, so mounting only has to be visible: a row
 * that loads silently looks identical to a row that never composed, and the
 * first question when the browser says "namespace missing" is whether this
 * entry was even in the graph.
 * @param ctx - the host context; only the logger face is used.
 * @param config - the validated composition config (currently unused).
 */
export function apply(ctx: unknown, _config: unknown): void {
  const line = 'host store mounted: registry and default identity persist in this profile document via remote.settings'
  // Self-report through whatever logger face the host context offers, without
  // assuming its shape: the mount line must land either way.
  const logger = isRecord(ctx) ? ctx['logger'] : undefined
  const named = typeof logger === 'function' ? logger('threadharbor-host-store') : undefined
  if (isRecord(named) && typeof named['info'] === 'function') named['info'](line)
  // Also to stderr, like the acp rows: this entry is silent by design, and
  // whether it mounted at all is the first thing anyone checks when the
  // browser reports the namespace missing.
  process.stderr.write(`[threadharbor] ${line}\n`)
  // Then verify the point of mounting: ask the settings service what
  // namespaces it now serves. A mount without a namespace is exactly the
  // silent failure the browser would report as 「组合里缺行」 — say so here,
  // where the composition is being fixed.
  queueMicrotask(() => { void checkRegistration(ctx) })
}

/** Ask the settings service which namespaces it serves, and self-report ours.
 * The service is read through a child-scope injection — the pattern
 * ui-settings-general uses — because a module-level `inject` would park this
 * whole entry waiting for a service the composition never resolves into its
 * own scope, and a parked entry (fiber state ≠ active) is exactly the one the
 * settings collector skips: the namespace would vanish for real. */
function checkRegistration(ctx: unknown): void {
  const say = (message: string): void => {
    process.stderr.write(`[threadharbor] host store check: ${message}\n`)
  }
  const injectFacet = isRecord(ctx) && typeof ctx['inject'] === 'function' ? ctx['inject'] as (names: string[], run: (child: unknown) => void) => void : undefined
  if (injectFacet === undefined) {
    say('settings service not reachable from this entry — namespace registration unverifiable here')
    return
  }
  injectFacet(['settings'], child => {
    // Report at 0s / 4s / 12s: a namespace that is served at boot and drops
    // later is a different bug from one never served, and the browser sees the
    // document minutes after boot.
    for (const delay of [0, 4_000, 12_000]) {
      setTimeout(() => { queueMicrotask(() => { void report(child, say) }) }, delay)
    }
  })
}

async function report(child: unknown, say: (message: string) => void): Promise<void> {
  try {
    const service = isRecord(child) ? child['settings'] : undefined
    const describe = isRecord(service) && typeof service['describe'] === 'function' ? service['describe'].bind(service) as () => unknown : undefined
    if (describe === undefined) {
      say('settings service not reachable from this entry — namespace registration unverifiable here')
      return
    }
    // First: what does this entry's own fiber look like to the settings
    // collector (it needs an active fiber whose runtime carries Config)?
    const fiber = isRecord(child) ? child['fiber'] : undefined
    const runtime = isRecord(fiber) ? fiber['runtime'] : undefined
    say(`entry fiber as seen from the settings scope: state=${isRecord(fiber) ? String(fiber['state']) : '?'} runtimeType=${typeof runtime} hasConfig=${runtime !== null && runtime !== undefined ? 'Config' in (runtime as object) : 'n/a'}`)
    const described: unknown = await describe()
    const rows = isRecord(described) && Array.isArray(described['namespaces'])
      ? described['namespaces'] as unknown[]
      : Array.isArray(described)
        ? described
        : []
    const ids = rows.map(row => (isRecord(row) && typeof row['ns'] === 'string' ? row['ns'] : '?'))
    say(ids.includes(HOST_STORE_ENTRY_ID)
      ? `namespace ${HOST_STORE_ENTRY_ID} is served by remote.settings (all ${ids.length} namespaces: ${ids.join(', ')})`
      : `namespace ${HOST_STORE_ENTRY_ID} is NOT served — settings lists [${ids.join(', ')}]`)
  } catch (error) {
    say(`registration check failed: ${String(error)}`)
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null
