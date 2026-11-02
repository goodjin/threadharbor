/**
 * Keeping ACP presets out of the picker without unmouting them.
 *
 * The four ACP agents register as presets because the whole switching machine
 * runs on preset registration: eager mounting is what puts their models in the
 * global catalog, and the model → preset follow is what turns a model pick into
 * a session on that agent. But the same registration also lists them in the
 * preset picker, where they read as clutter — the model list already switches.
 *
 * So the row this module tests hides ids at the roster's client-facing exit
 * only. The registry's internal `list()` must stay whole, because the follow
 * checks target presets against it; a filter that reached it would quietly
 * refuse every switch it was meant to enable.
 */

import { describe, expect, it } from 'vitest'
import { hideFromRoster, visibleRoster } from '../src/roster-filter.ts'
import { clearRosterMarks, markRosterHidden } from '../src/roster-marks.ts'

const ROSTER = {
  presets: [
    { id: 'standard', isDefault: true },
    { id: 'superpowers', name: 'Superpowers' },
    { id: 'acp-codex', name: 'Codex', order: 20 },
    { id: 'acp-grok', name: 'Grok', order: 25 },
  ],
}

describe('visibleRoster', () => {
  it('drops exactly the named ids', () => {
    const visible = visibleRoster(ROSTER, ['acp-codex', 'acp-grok'])
    expect(visible.presets.map(row => row.id)).toEqual(['standard', 'superpowers'])
  })

  it('keeps every other field of the surviving rows', () => {
    // Filtering is how a row leaves the picker, not how the survivors get
    // rewritten — isDefault still has to reach the seat's default marking.
    const visible = visibleRoster(ROSTER, ['acp-codex'])
    expect(visible.presets[0]).toEqual({ id: 'standard', isDefault: true })
    expect(visible.presets[2]).toEqual({ id: 'acp-grok', name: 'Grok', order: 25 })
  })

  it('returns the roster whole when nothing is named', () => {
    expect(visibleRoster(ROSTER, []).presets).toHaveLength(4)
  })

  it('leaves the roster it was given unmodified', () => {
    const before = JSON.stringify(ROSTER)
    visibleRoster(ROSTER, ['acp-grok'])
    expect(JSON.stringify(ROSTER)).toBe(before)
  })

  it('drops a row that carries the hideFromRoster mark', () => {
    const visible = visibleRoster({
      presets: [
        { id: 'standard' },
        { id: 'acp-future', hideFromRoster: true },
      ],
    }, [])
    expect(visible.presets.map(row => row.id)).toEqual(['standard'])
  })

  it('names an absent id without inventing rows', () => {
    const visible = visibleRoster(ROSTER, ['acp-claude'])
    expect(visible.presets.map(row => row.id)).toEqual(ROSTER.presets.map(row => row.id))
  })
})

describe('hideFromRoster', () => {
  const makeService = () => ({
    async remoteExportList() {
      return structuredClone(ROSTER)
    },
  })

  it('filters what the service answers through its own method', async () => {
    const service = makeService()
    const done = hideFromRoster(service, ['acp-codex', 'acp-grok'], () => {})
    expect(done).toBe(true)
    const roster = await service.remoteExportList()
    expect(roster.presets.map(row => row.id)).toEqual(['standard', 'superpowers'])
  })

  it('replaces a previous wrap instead of stacking on it', async () => {
    // A live config reload remounts the row with a possibly edited list. The
    // second wrap must rebuild on the pristine method, or hides would compound
    // and an unhidden id could never come back.
    const service = makeService()
    hideFromRoster(service, ['acp-codex'], () => {})
    hideFromRoster(service, ['acp-grok'], () => {})
    const roster = await service.remoteExportList()
    expect(roster.presets.map(row => row.id)).toEqual(['standard', 'superpowers', 'acp-codex'])
  })

  it('reports and refuses to touch a service with no roster export', () => {
    // A DSH shape change must not break the roster — it may only stop the
    // hiding, and say so, because a silently unfiltered picker looks exactly
    // like a filter that works.
    const lines: string[] = []
    const done = hideFromRoster({}, ['acp-codex'], line => lines.push(line))
    expect(done).toBe(false)
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain('remoteExportList')
  })

  it('hides ids recorded by a binding mark, without a name list', async () => {
    clearRosterMarks()
    markRosterHidden('acp-codex')
    const service = makeService()
    hideFromRoster(service, [], () => {})
    const roster = await service.remoteExportList()
    expect(roster.presets.map(row => row.id)).toEqual(['standard', 'superpowers', 'acp-grok'])
    clearRosterMarks()
  })

  it('passes an answer it does not recognise through untouched', async () => {
    // Same rule as above for the return path: an unexpected shape goes to the
    // client as the registry produced it, with a report on the way — "declined
    // to filter" must be visible, not silent.
    const lines: string[] = []
    const service = {
      async remoteExportList() {
        return { presets: 'not-a-list' }
      },
    }
    hideFromRoster(service, ['acp-codex'], line => lines.push(line))
    const roster = await service.remoteExportList()
    expect(roster).toEqual({ presets: 'not-a-list' })
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain('passing it through unfiltered')
  })
})
