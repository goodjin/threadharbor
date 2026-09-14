import { describe, expect, it } from 'vitest'
import {
  SESSION_CONFIG_APPLIED_KEY, configAppliedKey, readAppliedConfigMarkers, withAppliedConfigMarker, writeAppliedConfigMarkers,
} from '../src/client/session-config-applied.ts'

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value) },
  }
}

describe('session config applied markers', () => {
  it('survives a reload: a session already pushed this generation is not pushed again', () => {
    const store = memoryStorage()
    const key = configAppliedKey('s1', 'gen-a')
    writeAppliedConfigMarkers(withAppliedConfigMarker(readAppliedConfigMarkers(store), key), store)
    // "Reload": a fresh read from storage still knows about it.
    expect(readAppliedConfigMarkers(store)).toContain(key)
    // A restarted hold (new generation) is a different marker and gets pushed.
    expect(readAppliedConfigMarkers(store)).not.toContain(configAppliedKey('s1', 'gen-b'))
  })

  it('bounds the marker list and tolerates garbage', () => {
    let markers: readonly string[] = []
    for (let index = 0; index < 250; index += 1) markers = withAppliedConfigMarker(markers, `s${index}:g`)
    expect(markers).toHaveLength(200)
    expect(markers[0]).toBe('s50:g')
    expect(markers.at(-1)).toBe('s249:g')
    expect(withAppliedConfigMarker(['a', 'b'], 'a')).toEqual(['b', 'a'])
    expect(readAppliedConfigMarkers(memoryStorage({ [SESSION_CONFIG_APPLIED_KEY]: 'nope' }))).toEqual([])
    expect(readAppliedConfigMarkers(memoryStorage({ [SESSION_CONFIG_APPLIED_KEY]: '["ok", 3, null]' }))).toEqual(['ok'])
    expect(readAppliedConfigMarkers(undefined)).toEqual([])
  })
})
