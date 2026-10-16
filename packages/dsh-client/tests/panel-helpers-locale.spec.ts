/**
 * The panel's pure helper functions stop owning their wording and read it
 * through the `t` seat.
 *
 * These helpers cannot call `t` themselves — they are plain functions, not
 * components — so each takes `t` as a parameter and every call site passes
 * the component's seat through. A missed thread ships hardcoded Chinese
 * through a code path the JSX migration looks clean, so this spec pins both
 * halves: given a `t` whose copy is unmistakably not the old hardcoded
 * Chinese, every helper returns that copy with placeholders substituted; and
 * nothing a helper returns carries a CJK character anymore.
 *
 * Compared with the first migration this adds main's new status-word helper
 * `connectionStatusLabel` (the row.connection model) beside the three the
 * original pass covered.
 *
 * The dictionary half is pinned too: every key a helper reads exists in zh
 * and en with the placeholders the call passes.
 */

import { describe, expect, it } from 'vitest'
import { describeVerdict } from '../src/verdict.ts'
import type { ProbeVerdict } from '../src/verdict.ts'
import { connectionStatusLabel, heartbeatWord, storagePostureLine } from '../src/panel.tsx'
import type { HostStatus } from '../src/panel.tsx'
import type { HostStorePosture } from '../src/host-store.ts'
import { en, zh } from '../src/locales.ts'

/**
 * The `t` the tests hand the helpers: reads the documented `{name}`
 * placeholder contract, but answers with sentinel copy that shares no
 * character with the old hardcoded Chinese — so a leaked literal fails the
 * assertion instead of passing as a false friend.
 */
const FAKE_COPY: Record<string, string> = {
  'panel.posture.host': 'POSTURE:HOST',
  'panel.posture.loading': 'POSTURE:LOADING',
  'panel.posture.memoryRemotePage': 'POSTURE:MEMORY:REMOTE-PAGE',
  'panel.posture.memoryNoChannel': 'POSTURE:MEMORY:NO-CHANNEL',
  'panel.posture.degraded': 'POSTURE:DEGRADED:{detail}',
  'panel.time.justNow': 'TIME:JUST-NOW',
  'panel.time.secondsAgo': 'TIME:{n}:SECONDS-AGO',
  'panel.time.minutesAgo': 'TIME:{n}:MINUTES-AGO',
  'panel.time.hoursAgo': 'TIME:{n}:HOURS-AGO',
  'panel.status.connected': 'STATUS:CONNECTED',
  'panel.status.reachableUnsynced': 'STATUS:REACHABLE-UNSYNCED',
  'panel.status.checking': 'STATUS:CHECKING',
  'panel.status.offline': 'STATUS:OFFLINE',
  'panel.status.self': 'STATUS:SELF',
  'panel.status.undeployed': 'STATUS:UNDEPLOYED',
  'panel.status.stopped': 'STATUS:STOPPED',
  'panel.status.unknown': 'STATUS:UNKNOWN',
  'panel.status.unchecked': 'STATUS:UNCHECKED',
  'panel.verdict.ok': 'VERDICT:OK',
  'panel.verdict.slow': 'VERDICT:SLOW',
  'panel.verdict.hung': 'VERDICT:HUNG',
  'panel.verdict.unreachable': 'VERDICT:UNREACHABLE',
  'panel.verdict.hungStartedDetail': 'VERDICT:HUNG-STARTED-DETAIL:{ms}',
  'panel.verdict.hungSilentDetail': 'VERDICT:HUNG-SILENT-DETAIL:{ms}',
  'panel.verdict.okAdvice': 'VERDICT:OK-ADVICE',
  'panel.verdict.slowAdvice': 'VERDICT:SLOW-ADVICE',
  'panel.verdict.hungStartedAdvice': 'VERDICT:HUNG-STARTED-ADVICE',
  'panel.verdict.hungSilentAdvice': 'VERDICT:HUNG-SILENT-ADVICE',
  'panel.verdict.unreachableAdvice': 'VERDICT:UNREACHABLE-ADVICE',
}

function fakeT(key: string, params?: Record<string, unknown>): string {
  const template = FAKE_COPY[key] ?? `<missing:${key}>`
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? `{${name}}`))
}

/** Every key the helpers read, as the helpers spell them. */
const HELPER_KEYS: readonly string[] = Object.keys(FAKE_COPY)

/** The keys whose copy carries a dynamic value, with the placeholders they need. */
const PARAMETERIZED: readonly (readonly [string, readonly string[]])[] = [
  ['panel.posture.degraded', ['detail']],
  ['panel.time.secondsAgo', ['n']],
  ['panel.time.minutesAgo', ['n']],
  ['panel.time.hoursAgo', ['n']],
  ['panel.verdict.hungStartedDetail', ['ms']],
  ['panel.verdict.hungSilentDetail', ['ms']],
]

/** Every `{name}` placeholder a value carries, in order. */
function placeholders(value: string): string[] {
  return [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]!)
}

describe('storagePostureLine 走 t', () => {
  const CASES: readonly (readonly [HostStorePosture, string, string])[] = [
    [{ kind: 'host' }, 'ok', 'POSTURE:HOST'],
    [{ kind: 'loading' }, 'info', 'POSTURE:LOADING'],
    [{ kind: 'memory', reason: 'remote-page' }, 'bad', 'POSTURE:MEMORY:REMOTE-PAGE'],
    [{ kind: 'memory', reason: 'no-channel' }, 'bad', 'POSTURE:MEMORY:NO-CHANNEL'],
    [{ kind: 'degraded', detail: 'disk on fire' }, 'bad', 'POSTURE:DEGRADED:disk on fire'],
  ]

  it('每种姿态的句子来自 t，语气不变，degraded 带 {detail}', () => {
    for (const [posture, tone, text] of CASES) {
      const display = storagePostureLine(posture, fakeT)
      expect(display.tone, posture.kind).toBe(tone)
      expect(display.text, posture.kind).toBe(text)
    }
  })

  it('不再返回硬编码中文', () => {
    for (const [posture] of CASES) {
      expect(storagePostureLine(posture, fakeT).text).not.toMatch(/[\u{4e00}-\u{9fff}]/u)
    }
  })
})

describe('heartbeatWord 走 t', () => {
  it('按久暂选键，数值走 {n} 占位符', () => {
    const now = 1_000_000
    expect(heartbeatWord(now, now, fakeT)).toBe('TIME:JUST-NOW')
    expect(heartbeatWord(now - 5_000, now, fakeT)).toBe('TIME:5:SECONDS-AGO')
    expect(heartbeatWord(now - 120_000, now, fakeT)).toBe('TIME:2:MINUTES-AGO')
    expect(heartbeatWord(now - 7_200_000, now, fakeT)).toBe('TIME:2:HOURS-AGO')
  })

  it('不再返回硬编码中文', () => {
    const now = 1_000_000
    for (const lastSeen of [now, now - 5_000, now - 120_000, now - 7_200_000]) {
      expect(heartbeatWord(lastSeen, now, fakeT)).not.toMatch(/[\u{4e00}-\u{9fff}]/u)
    }
  })
})

describe('connectionStatusLabel 走 t', () => {
  const CASES: readonly (readonly [HostStatus, string])[] = [
    ['self', 'STATUS:SELF'],
    ['reading', 'STATUS:CHECKING'],
    ['undeployed', 'STATUS:UNDEPLOYED'],
    ['stopped', 'STATUS:STOPPED'],
    ['connected', 'STATUS:CONNECTED'],
    ['reachable', 'STATUS:REACHABLE-UNSYNCED'],
    ['disconnected', 'STATUS:OFFLINE'],
    ['unchecked', 'STATUS:UNCHECKED'],
    ['unknown', 'STATUS:UNKNOWN'],
  ]

  it('九个状态词全部来自 t，两两不同', () => {
    const words = CASES.map(([, word]) => word)
    expect(new Set(words).size).toBe(9)
    for (const [status, word] of CASES) {
      expect(connectionStatusLabel(status, fakeT), status).toBe(word)
    }
  })

  it('不再返回硬编码中文', () => {
    for (const [status] of CASES) {
      expect(connectionStatusLabel(status, fakeT)).not.toMatch(/[\u{4e00}-\u{9fff}]/u)
    }
  })
})

describe('describeVerdict 走 t', () => {
  const CASES: readonly (readonly [ProbeVerdict, string, string, string])[] = [
    [{ kind: 'ok', ms: 800 }, 'VERDICT:OK', '800 ms', 'VERDICT:OK-ADVICE'],
    [{ kind: 'slow', ms: 20_000 }, 'VERDICT:SLOW', '20000 ms', 'VERDICT:SLOW-ADVICE'],
    [{ kind: 'hung', ms: 60_000, started: true }, 'VERDICT:HUNG', 'VERDICT:HUNG-STARTED-DETAIL:60000', 'VERDICT:HUNG-STARTED-ADVICE'],
    [{ kind: 'hung', ms: 60_000, started: false }, 'VERDICT:HUNG', 'VERDICT:HUNG-SILENT-DETAIL:60000', 'VERDICT:HUNG-SILENT-ADVICE'],
    [{ kind: 'unreachable', reason: 'connect ECONNREFUSED' }, 'VERDICT:UNREACHABLE', 'connect ECONNREFUSED', 'VERDICT:UNREACHABLE-ADVICE'],
  ]

  it('四种结论的措辞和建议都来自 t，证据原样带出', () => {
    for (const [verdict, headline, detail, advice] of CASES) {
      const display = describeVerdict(verdict, fakeT)
      expect(display.headline, verdict.kind).toBe(headline)
      expect(display.detail, verdict.kind).toBe(detail)
      expect(display.advice, verdict.kind).toBe(advice)
    }
  })

  it('不再返回硬编码中文', () => {
    for (const [verdict] of CASES) {
      const display = describeVerdict(verdict, fakeT)
      expect(display.headline).not.toMatch(/[\u{4e00}-\u{9fff}]/u)
      expect(display.detail).not.toMatch(/[\u{4e00}-\u{9fff}]/u)
      expect(display.advice).not.toMatch(/[\u{4e00}-\u{9fff}]/u)
    }
  })
})

describe('助手读的键在字典里', () => {
  it('每个助手键在 zh 和 en 里都有', () => {
    for (const key of HELPER_KEYS) {
      expect(zh[key as keyof typeof zh], `zh[${key}]`).toBeDefined()
      expect((en as Record<string, string>)[key], `en[${key}]`).toBeDefined()
    }
  })

  it('带动态值的键带着自己的占位符', () => {
    for (const [key, expected] of PARAMETERIZED) {
      expect(placeholders(zh[key as keyof typeof zh]!), key).toEqual(expected)
      expect(placeholders((en as Record<string, string>)[key]!), key).toEqual(expected)
    }
  })
})
