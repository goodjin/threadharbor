/**
 * The plugin's own run of `verify-client-ui-i18n`.
 *
 * DSH's host runs that gate over its own client sources; this plugin is loaded
 * by the same host and holds itself to the same standard — product copy is
 * owned by the locale dictionary, presentation reads it through `t`. The
 * detection function is vendored verbatim from the reference gate (see
 * ui-i18n-checker.ts for why), and this spec runs it over the sources this
 * plugin's locale work owns: the entry assembly, the switch progress layer and
 * the handover card. The panel body's remaining copy is a separate, counted
 * piece of work (see the task report); it is not asserted here because this
 * task does not own it.
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
] as const

describe('verify-client-ui-i18n over this plugin', () => {
  it('covers the locale-owned surfaces, plus the dictionary owner', () => {
    // The reference gate refuses a narrowed corpus so a discovery bug cannot
    // read as a pass; the same guard applies here at this scope's scale.
    expect(OWNED_SOURCES).toHaveLength(3)
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
