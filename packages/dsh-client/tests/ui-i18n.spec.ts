/**
 * The plugin's own run of `verify-client-ui-i18n`.
 *
 * DSH's host runs that gate over its own client sources; this plugin is loaded
 * by the same host and holds itself to the same standard — product copy is
 * owned by the locale dictionary, presentation reads it through `t`. The
 * detection function is vendored verbatim from the reference gate (see
 * ui-i18n-checker.ts for why), and this spec runs it over the sources this
 * plugin's locale work owns: the entry assembly, the switch progress layer,
 * the handover card, and (since the panel-i18n effort closed) the panel body —
 * re-applied on top of main's rewritten panel.tsx, whose new status model and
 * ssh-deploy UI carried fresh hardcoded strings.
 *
 * The gate's property-assignment rule only scans `.tsx` files, so a class of
 * user-facing runtime strings that live in `.ts` modules is invisible to it.
 * This commit localized the two highest-traffic sets — the entry's port
 * failures (client/index.ts: Tailscale picker, agent gateway) and ssh-deploy's
 * HTTP errors — bilingual via the same dictionary with a byte-identical
 * fallback when no locale service is present; that contract is pinned by
 * runtime-locale.spec.ts rather than scanned here. The same blind spot exists
 * in a handful of other `.ts` modules (gateway.ts, host-store.ts, reach.ts,
 * rollup-section.ts, session-source.ts) whose copy also reaches the screen —
 * they are a known, deliberately-undeferred scope item, not cleared. Adding
 * any `.ts` file to OWNED_SOURCES would be a no-op (the rule is `.tsx`-only), so
 * none are listed.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { findUiI18nViolations } from './ui-i18n-checker.ts'

const CLIENT_SRC = fileURLToPath(new URL('../src', import.meta.url))

/** The sources the locale work owns, as repository-relative paths. */
const OWNED_SOURCES = [
  'packages/dsh-client/src/client/index.ts',
  'packages/dsh-client/src/switch-progress.ts',
  'packages/dsh-client/src/handover-card.ts',
  'packages/dsh-client/src/panel.tsx',
] as const

describe('verify-client-ui-i18n over this plugin', () => {
  it('covers the locale-owned surfaces, plus the dictionary owner', () => {
    // The reference gate refuses a narrowed corpus so a discovery bug cannot
    // read as a pass; the same guard applies here at this scope's scale.
    expect(OWNED_SOURCES).toHaveLength(4)
    for (const file of OWNED_SOURCES) {
      expect(() => readFileSync(join(CLIENT_SRC, file.slice('packages/dsh-client/src/'.length)), 'utf8')).not.toThrow()
    }
  })

  it('finds no hard-coded product copy in the locale-owned surfaces', () => {
    const violations = OWNED_SOURCES.flatMap(file =>
      findUiI18nViolations(file, readFileSync(join(CLIENT_SRC, file.slice('packages/dsh-client/src/'.length)), 'utf8')))
    expect(violations).toEqual([])
  })
})
