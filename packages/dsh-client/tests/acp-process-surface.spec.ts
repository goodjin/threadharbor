import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { registerAcpProcessSurface } from '../src/acp-process-surface.tsx'

function fixture() {
  const Native = () => createElement('span', { 'data-native': true }, 'native answer')
  const injection = () => ({ hooks: { presentation: {} } })
  const native = { component: Native, options: { key: 'assistant-step', priority: 0 }, locale: 'chat', inject: injection }
  const entries: any[] = [native]
  const slotListeners = new Set<() => void>()
  const create = () => ({ empty: null, replace: () => null, apply: () => null })
  const view = { target: 'chat', create }
  const unregister = vi.fn()
  let dispose: () => void = () => {}
  const ctx = {
    slots: {
      entries: () => entries,
      subscribe: (_name: string, fn: () => void) => { slotListeners.add(fn); return () => slotListeners.delete(fn) },
      register: (options: any, component: any) => {
        const entry = { options, component }; entries.push(entry)
        for (const fn of slotListeners) fn()
        return () => { entries.splice(entries.indexOf(entry), 1); for (const fn of slotListeners) fn() }
      },
    },
    get: () => ({ views: { entries: () => [view], subscribe: () => () => {} }, events: { register: () => unregister } }),
    effect: (effect: () => () => void) => { dispose = effect() },
  }
  return { ctx, native, view, create, entries, unregister, dispose: () => dispose() }
}

describe('ACP process surface', () => {
  it('renders one unit for reasoning and progress while preserving the native renderer and its injections', () => {
    const f = fixture(); registerAcpProcessSurface(f.ctx)
    expect(f.view.create).not.toBe(f.create)
    const added = f.entries.at(-1)!
    expect(added.options).toMatchObject({ locale: f.native.locale, inject: f.native.inject })
    const native = renderToStaticMarkup(createElement(added.component, { node: { data: {} } }))
    expect(native).toContain('data-native="true"')
    const html = renderToStaticMarkup(createElement(added.component, {
      node: { data: { acpProcessSegment: { callId: 'c1', entries: [], blocks: [{ kind: 'reasoning', text: 'Checking boundaries' }, { kind: 'text', text: 'Running verification' }] } } },
      t: (key: string) => key,
    }))
    expect(html.match(/data-acp-process-segment=/g)).toHaveLength(1)
    expect(html).toContain('Checking boundaries')
    expect(html).toContain('Running verification')
    expect(html).not.toContain('native answer')
    f.dispose()
    expect(f.view.create).toBe(f.create)
    expect(f.entries).toEqual([f.native])
    expect(f.unregister).toHaveBeenCalledOnce()
  })
  it('leaves a host without the required registry APIs untouched', () => {
    const effect = vi.fn()
    registerAcpProcessSurface({ get: () => undefined, slots: undefined, effect })
    expect(effect).not.toHaveBeenCalled()
  })
})
