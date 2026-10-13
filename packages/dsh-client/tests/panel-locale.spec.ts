/**
 * The panel-i18n rebase: main's parity work rewrote panel.tsx (the host
 * status model became `row.connection`, the ssh-deploy UI arrived), so the
 * `t` seat and the `panel.*` dictionary are re-applied on top of it.
 *
 * The dictionary is the one place product copy may live (the plugin's own run
 * of `verify-client-ui-i18n` holds the entry, the progress bar, the handover
 * card and now the panel body to that standard). zh and en must ship together
 * with identical key domains — `ctx.locale.register` refuses a one-sided
 * dictionary, and a key that exists in one language only renders a
 * half-translated panel. Placeholders must match too, or switching languages
 * renders a broken sentence.
 *
 * This spec pins the key set the migrated JSX reads: if a key name and the
 * component drift apart, this test fails before the page does. The strings
 * were removed from the add page by main's parity work, so the old
 * `panel.help.*` keys have no UI to serve and are gone; the ssh-deploy
 * section's copy takes their place as the rich-segment (`{…}`) keys.
 */

import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { richSegments } from '../src/panel.tsx'
import { en, zh } from '../src/locales.ts'

/**
 * Every key the panel's components read, spelled the way the components read
 * them. Grouped by the surface that renders them: titles, buttons, the
 * connection status model, probe states, the verdict, the form, the
 * host-reported facts, the registry actions, the reach check, the agent
 * section, the Tailscale picker, the JSX-rendered notices, and the ssh-deploy
 * section.
 */
const PANEL_KEYS: readonly string[] = [
  // Section titles and page headings.
  'panel.title.hosts',
  'panel.title.addHost',
  'panel.title.management',
  'panel.title.selfAgents',
  'panel.title.connectionCare',
  'panel.title.notes',
  'panel.title.sessionTree',
  // Buttons.
  'panel.button.probe',
  'panel.button.confirm',
  'panel.button.save',
  'panel.button.cancel',
  'panel.button.back',
  'panel.button.backToList',
  'panel.button.deleteRegistration',
  'panel.button.confirmRemove',
  'panel.button.refresh',
  'panel.button.pickFromTailscale',
  'panel.button.settings',
  'panel.button.reachTry',
  'panel.button.copyLink',
  // Status words: the row badge and the detail page's status line.
  'panel.status.self',
  'panel.status.online',
  'panel.status.offline',
  'panel.status.connected',
  'panel.status.reachable',
  'panel.status.checking',
  'panel.status.reachableUnsynced',
  // Probe states and the advice fold.
  'panel.probe.idle',
  'panel.probe.running',
  'panel.probe.error',
  'panel.verdict.advice',
  // Four verdicts and their advice (describeVerdict).
  'panel.verdict.ok',
  'panel.verdict.slow',
  'panel.verdict.hung',
  'panel.verdict.unreachable',
  'panel.verdict.hungStartedDetail',
  'panel.verdict.hungSilentDetail',
  'panel.verdict.okAdvice',
  'panel.verdict.slowAdvice',
  'panel.verdict.hungStartedAdvice',
  'panel.verdict.hungSilentAdvice',
  'panel.verdict.unreachableAdvice',
  // Form labels and placeholders (example values are copy the checker owns).
  'panel.form.fieldName',
  'panel.form.fieldNamePlaceholder',
  'panel.form.fieldStatus',
  'panel.form.fieldIp',
  'panel.form.ipPlaceholder',
  'panel.form.fieldTitle',
  // Storage posture line (storagePostureLine).
  'panel.posture.host',
  'panel.posture.loading',
  'panel.posture.memoryRemotePage',
  'panel.posture.memoryNoChannel',
  'panel.posture.degraded',
  // Heartbeat wording (heartbeatWord).
  'panel.time.justNow',
  'panel.time.secondsAgo',
  'panel.time.minutesAgo',
  'panel.time.hoursAgo',
  // Host-reported facts (view mode).
  'panel.facts.selfLine',
  'panel.facts.status',
  'panel.facts.heartbeat',
  'panel.facts.offlineNote',
  'panel.facts.offlineIdsPrefix',
  'panel.facts.offlineEnd',
  'panel.facts.onlineIdsSeparator',
  'panel.facts.match',
  'panel.facts.idMismatch',
  'panel.facts.reportedTitle',
  // The remove-registration confirmation and the launch link.
  'panel.registry.removeNote',
  'panel.registry.launchLink',
  // The reach check under the registry actions.
  'panel.reach.probeTimeout',
  // The agent section on the self detail page.
  'panel.agents.loading',
  'panel.agents.failed',
  'panel.agents.empty',
  // The Tailscale address picker.
  'panel.tailscale.pickTitle',
  'panel.tailscale.loading',
  'panel.tailscale.empty',
  'panel.tailscale.collapse',
  'panel.tailscale.peerMeta',
  // JSX-rendered notices.
  'panel.notes.selfHeal',
  'panel.notes.onlineMeaning',
  'panel.notes.otherSource',
  'panel.notes.sessionTree',
  // The list page's empty state.
  'panel.list.empty',
  // The ssh-deploy section (inspect / deploy / progress / result).
  'panel.ssh.title',
  'panel.ssh.manualEntry',
  'panel.ssh.intro',
  'panel.ssh.introLoopback',
  'panel.ssh.accessMode',
  'panel.ssh.accessHostIp',
  'panel.ssh.accessTunnel',
  'panel.ssh.bindHostLabel',
  'panel.ssh.bindHostPlaceholder',
  'panel.ssh.trustedHostLabel',
  'panel.ssh.trustedHostPlaceholder',
  'panel.ssh.targetLabel',
  'panel.ssh.targetPlaceholder',
  'panel.ssh.portLabel',
  'panel.ssh.userLabel',
  'panel.ssh.userPlaceholder',
  'panel.ssh.proxyJumpLabel',
  'panel.ssh.authModeLabel',
  'panel.ssh.authIdentityFile',
  'panel.ssh.authIdentityPem',
  'panel.ssh.authPassword',
  'panel.ssh.identityFileLabel',
  'panel.ssh.identityFilePlaceholder',
  'panel.ssh.identityPemLabel',
  'panel.ssh.passwordLabel',
  'panel.ssh.remotePortLabel',
  'panel.ssh.inspect',
  'panel.ssh.inspecting',
  'panel.ssh.deploy',
  'panel.ssh.deploying',
  'panel.ssh.pickKeyPrompt',
  'panel.ssh.progressFailed',
  'panel.ssh.launchUrlPrompt',
  'panel.ssh.open',
  'panel.ssh.hostIdLabel',
  'panel.ssh.approveFingerprintFirst',
  'panel.ssh.hostIdRequired',
  'panel.ssh.deployFailed',
  'panel.ssh.registered',
  'panel.ssh.addFooterPrefix',
  'panel.ssh.redeploy',
]

/** The keys whose copy carries a dynamic value, with the placeholders they need. */
const PARAMETERIZED: readonly (readonly [string, readonly string[]])[] = [
  ['panel.probe.error', ['message']],
  ['panel.posture.degraded', ['detail']],
  ['panel.time.secondsAgo', ['n']],
  ['panel.time.minutesAgo', ['n']],
  ['panel.time.hoursAgo', ['n']],
  ['panel.verdict.hungStartedDetail', ['ms']],
  ['panel.verdict.hungSilentDetail', ['ms']],
  ['panel.facts.status', ['status']],
  ['panel.facts.heartbeat', ['age']],
  ['panel.facts.reportedTitle', ['name']],
  ['panel.reach.probeTimeout', ['ms']],
  ['panel.agents.failed', ['message']],
  ['panel.tailscale.peerMeta', ['ip', 'status']],
  ['panel.ssh.progressFailed', ['error']],
  ['panel.ssh.registered', ['endpoint']],
]

/** Every `{name}` placeholder a value carries, in order. */
function placeholders(value: string): string[] {
  return [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]!)
}

describe('panel 的 locale 键', () => {
  it('按钮键在两种语言里都落了成品文案', () => {
    expect(zh['panel.button.save']).toBe('保存')
    expect(en['panel.button.save']).toBe('Save')
  })

  it('状态模型的新词（连接状态）在两种语言里都有', () => {
    expect(zh['panel.status.connected']).toBe('已连接')
    expect(zh['panel.status.reachable']).toBe('可达')
    expect(zh['panel.status.checking']).toBe('检测中')
    expect(zh['panel.status.reachableUnsynced']).toBe('可达未同步')
    expect(en['panel.status.connected']).toBeDefined()
    expect(en['panel.status.reachableUnsynced']).toBeDefined()
  })

  it('面板 JSX 读的每个键在 zh 和 en 里都有', () => {
    for (const key of PANEL_KEYS) {
      expect(zh[key as keyof typeof zh], `zh[${key}]`).toBeDefined()
      expect((en as Record<string, string>)[key], `en[${key}]`).toBeDefined()
    }
  })

  it('zh 与 en 的键域完全一致', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })

  it('每个键在两种语言里用同一组占位符', () => {
    for (const [key, value] of Object.entries(zh)) {
      expect(placeholders((en as Record<string, string>)[key]!), `占位符不一致：${key}`)
        .toEqual(placeholders(value))
    }
  })

  it('带动态值的键带着自己的占位符', () => {
    for (const [key, expected] of PARAMETERIZED) {
      expect(placeholders(zh[key as keyof typeof zh]!), key).toEqual(expected)
      expect(placeholders((en as Record<string, string>)[key]!), key).toEqual(expected)
    }
  })

  it('离线时在线标识列表的分隔符是键，zh 值是「、」', () => {
    expect(zh['panel.facts.onlineIdsSeparator']).toBe('、')
    expect(en['panel.facts.onlineIdsSeparator']).toBeDefined()
  })
})

/**
 * The ssh-deploy section's copy carries inline elements the way the old
 * add-host help block did: the command-looking fragments stay inside the
 * translated sentence, marked with `{…}`, and `richSegments` wraps them back
 * into `<code>` (the intro's emphasis into `<strong>`). One key per sentence
 * keeps the whole line visible to a translator.
 */
describe('panel.ssh 的 {…} 富文本段', () => {
  /** The keys whose copy embeds `{…}` rich segments, with the segments they carry. */
  const RICH_KEYS = ['panel.ssh.intro', 'panel.ssh.introLoopback', 'panel.ssh.accessHostIp'] as const

  /** Every `{…}` rich segment a sentence carries, contents included. */
  function richSegmentsOf(value: string): string[] {
    return [...value.matchAll(/\{([^{}]+)\}/g)].map(match => match[1]!)
  }

  it('intro 的强调段和命令段都收在句子里，不另拆键', () => {
    expect(zh['panel.ssh.intro']).toContain('{当前这台机器}')
    expect(zh['panel.ssh.introLoopback']).toContain('{?token=}')
    expect(zh['panel.ssh.accessHostIp']).toContain('{http://<主机IP>:<端口>}')
  })

  it('每个富文本句的 {…} 段两种语言数量一致（段内容随语言走，顺序可换）', () => {
    for (const key of RICH_KEYS) {
      expect(richSegmentsOf((en as Record<string, string>)[key]!).length, key)
        .toBe(richSegmentsOf(zh[key]!).length)
    }
  })

  it('富文本句里没有未成对的花括号（拆段不会把半截句子当成段）', () => {
    for (const key of RICH_KEYS) {
      for (const value of [zh[key]!, (en as Record<string, string>)[key]!]) {
        expect(value.replace(/\{[^{}]+\}/g, ''), key).not.toMatch(/[{}]/)
      }
    }
  })
})

/**
 * The rendered half: `richSegments` turns a translated template into text and
 * inline elements — even-index parts stay raw strings, odd-index parts are
 * wrapped in the given tag, and no `{…}` marker leaks into the markup.
 */
describe('richSegments：{…} 段包回行内元素', () => {
  it('偶数段保持原文，奇数段包成给定的元素', () => {
    const nodes = richSegments('前句 {强调段} 中句 {命令段} 后句', 'code')
    expect(nodes).toHaveLength(5)
    expect(nodes[0]).toBe('前句 ')
    expect(nodes[2]).toBe(' 中句 ')
    expect(nodes[4]).toBe(' 后句')
    const first = renderToString(createElement('p', null, nodes[1]))
    expect(first).toContain('<code>强调段</code>')
  })

  it('tag 给 strong 时段包成 strong，记号不漏到标记里', () => {
    const html = renderToString(createElement('p', null, richSegments('A {B} C', 'strong')))
    expect(html).toContain('<strong>B</strong>')
    expect(html).not.toContain('{B}')
  })

  it('没有记号的句子原样返回一段文本', () => {
    expect(richSegments('plain sentence', 'code')).toEqual(['plain sentence'])
  })
})
