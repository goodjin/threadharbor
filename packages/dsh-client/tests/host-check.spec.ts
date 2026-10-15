import { describe, expect, it } from 'vitest'
import type { PeerCheckReport } from '@threadharbor/dsh-host-federation'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PeerCheckList, peerCheckRows } from '../src/host-check.tsx'
import { derivePeerHostId, saveServeRegistration } from '../src/panel.tsx'
import { en, zh, fallbackT } from '../src/locales.ts'
import type { ClientLocaleKey, RuntimeT } from '../src/locales.ts'

const enT: RuntimeT = key => en[key]

const report = {
  ready: false,
  facts: {} as PeerCheckReport['facts'],
  steps: [
    { id: 'ssh', state: 'ok', actions: [] },
    { id: 'running', state: 'fail', reason: 'not-running', detail: '127.0.0.1:3081', actions: ['start'] },
    { id: 'serve', state: 'skip', actions: [] },
    { id: 'https', state: 'fail', reason: 'auth-failed', actions: ['restart', 'retry'] },
  ],
} as PeerCheckReport

describe('peer check rows', () => {
  it('localizes labels, reasons and actions in both languages', () => {
    const rows = peerCheckRows(report, enT)
    expect(rows[0]).toMatchObject({ label: 'SSH reachable', stateWord: 'Passed', note: '', actions: [] })
    expect(rows[1]).toMatchObject({ note: 'Port does not answer · 127.0.0.1:3081', actions: [{ action: 'start', label: 'Start DSH' }] })
    expect(rows[2]?.actions).toEqual([])
    // retry is the list-level button, not repeated per row
    expect(rows[3]?.actions.map(item => item.action)).toEqual(['restart'])
    expect(peerCheckRows(report, fallbackT)[1]?.label).toBe(zh['panel.check.step.running'])
  })

  it('every step, state, reason and action has a bilingual key', () => {
    const ids = ['ssh', 'tailscale', 'node', 'dsh', 'plugins', 'running', 'serve', 'https']
    const keys = [
      ...ids.map(id => `panel.check.step.${id}`),
      ...['ok', 'fail', 'warn', 'skip'].map(state => `panel.check.state.${state}`),
      ...['unreachable', 'not-installed', 'logged-out', 'no-magicdns', 'node-too-old', 'not-deployed', 'not-running', 'other-port', 'not-configured', 'not-checked', 'auth-failed', 'no-token'].map(reason => `panel.check.reason.${reason}`),
      ...['deploy', 'start', 'restart', 'serve', 'retry'].map(action => `panel.check.action.${action}`),
    ] as ClientLocaleKey[]
    for (const key of keys) {
      expect(zh[key], key).toBeTruthy()
      expect(en[key], key).toBeTruthy()
    }
  })
})

describe('derivePeerHostId', () => {
  it('prefers the MagicDNS short name, then the ssh target', () => {
    expect(derivePeerHostId('Box-1.tail1.ts.net', 'x')).toBe('box-1')
    expect(derivePeerHostId(undefined, 'me@studio.local')).toBe('studio')
    expect(derivePeerHostId(undefined, '  ')).toBe('')
  })
})

describe('saveServeRegistration', () => {
  type Entry = { hostId: string; hostTitle: string; address: string; launchUrl?: string; ssh?: unknown }
  const fakeRegistry = (initial: Entry[] = []) => {
    let entries = [...initial]
    return {
      entries: () => entries,
      list: () => entries,
      add: (entry: Entry) => { entries = [...entries.filter(e => e.hostId !== entry.hostId), entry]; return { ok: true as const, value: entry } },
      remove: (id: string) => { entries = entries.filter(e => e.hostId !== id) },
    }
  }
  const ssh = { target: 'box', authMode: 'identityFile' as const, identityFile: '/k', hostKeyFingerprint: 'SHA256:x' }

  it('adds a new host with the ts.net origin and tokenized URL', () => {
    const registry = fakeRegistry()
    const result = saveServeRegistration(registry as never, 'box', '', 'https://box.tail1.ts.net/?token=t', ssh)
    expect(result.ok).toBe(true)
    expect(registry.entries()).toEqual([{ hostId: 'box', hostTitle: '', address: 'https://box.tail1.ts.net', launchUrl: 'https://box.tail1.ts.net/?token=t', ssh }])
  })

  it('updates an existing tunnel registration in place', () => {
    const registry = fakeRegistry([{ hostId: 'box', hostTitle: '', address: 'http://127.0.0.1:5555', launchUrl: 'http://127.0.0.1:5555/?token=t' }])
    saveServeRegistration(registry as never, 'box', '', 'https://box.tail1.ts.net/?token=t', ssh)
    expect(registry.entries()).toHaveLength(1)
    expect(registry.entries()[0]).toMatchObject({ address: 'https://box.tail1.ts.net', launchUrl: 'https://box.tail1.ts.net/?token=t', ssh })
  })
})

describe('PeerCheckList serve failure', () => {
  it('shows the manual commands with copy buttons', () => {
    const html = renderToStaticMarkup(createElement(PeerCheckList, {
      report,
      busy: undefined,
      disabled: false,
      serveFailure: { error: 'denied', manualCommands: ['sudo tailscale set --operator=$USER', 'tailscale serve --bg --https=443 http://127.0.0.1:3081'] },
      onCheck: () => undefined,
      onAction: () => undefined,
      onSave: () => undefined,
      t: enT,
    }))
    expect(html).toContain('sudo tailscale set --operator=$USER')
    expect(html).toContain('tailscale serve --bg --https=443 http://127.0.0.1:3081')
    expect(html.match(/data-action="peer-copy-command"/g)).toHaveLength(2)
    expect(html).toContain(en['panel.check.manualHint'])
  })
})
