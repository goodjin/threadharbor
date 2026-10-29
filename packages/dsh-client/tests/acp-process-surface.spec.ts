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
  it('boxes the turn answer step while leaving process steps and empty answers in the native renderer', () => {
    const f = fixture(); registerAcpProcessSurface(f.ctx)
    const renderer = f.entries.at(-1)!.component as any
    const turnProcess = (answerStep: number) => ({ turnProcess: { spec: { answerStep } } })
    const answerNode = {
      node: { data: { step: 2, blocks: [{ kind: 'text', text: 'Final answer' }] } },
      t: (key: string) => key, ...turnProcess(2),
    }
    const html = renderToStaticMarkup(createElement(renderer, answerNode))
    expect(html).toContain('data-acp-answer-card="true"')
    expect(html).toContain('data-native="true"')
    // The card header carries the thinking icon and a copy button.
    expect(html).toContain('data-action="copy-answer"')
    expect(html).toContain('aria-label="answerCard.copy"')
    // A non-answer step keeps the native renderer with no card.
    const processNode = {
      node: { data: { step: 1, blocks: [{ kind: 'text', text: 'Mid-turn prose' }] } },
      t: (key: string) => key, ...turnProcess(2),
    }
    expect(renderToStaticMarkup(createElement(renderer, processNode))).not.toContain('data-acp-answer-card')
    // An answer step with no prose does not get an empty card.
    const emptyAnswer = {
      node: { data: { step: 2, blocks: [{ kind: 'tool-call', callId: 'c9', name: 'bash', argsRaw: '{}' }] } },
      t: (key: string) => key, ...turnProcess(2),
    }
    expect(renderToStaticMarkup(createElement(renderer, emptyAnswer))).not.toContain('data-acp-answer-card')
    f.dispose()
  })
  it('renders the answer card header with the thinking icon and a copy button, no label', () => {
    const f = fixture(); registerAcpProcessSurface(f.ctx)
    const renderer = f.entries.at(-1)!.component as any
    const t = (key: string) => ({ 'answerCard.copy': '复制结果' })[key] ?? key
    const html = renderToStaticMarkup(createElement(renderer, {
      node: { data: { step: 3, blocks: [{ kind: 'text', text: 'The final answer' }] } },
      t, turnProcess: { spec: { answerStep: 3 } },
    }))
    // Just the thinking icon and the copy button in its initial state — no text label.
    expect(html).toContain('data-action="copy-answer"')
    expect(html).toContain('aria-label="复制结果"')
    expect(html).not.toContain('data-copied="true"')
    f.dispose()
  })
})
