/**
 * 输入框模型入口：ThreadHarbor 覆盖官方那一版的理由与它的边界。
 *
 * 官方 0.2.0-rc.2 的触发按钮只显示模型名，于是选了 Cursor 时「grok-4.7」看不出
 * 是谁在回答；上游到 0.2.1-alpha 才补上 agent 前缀。本仓覆盖这个座位自己画，
 * 只给外部 agent 的路线加前缀——原生模型一个字符都不动。
 *
 * 前缀规则与触发按钮上的实际显示各自被测住；座位注册那一半见 model-seat.spec。
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'

// ui-primitives ships styled components that import CSS modules and a bare
// dependency this repo does not install. None of them decide what the trigger
// says, so the seat is rendered over stubs: what is under test is the label,
// and the menu behind it is upstream's unchanged code.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  MenuGroup: () => null,
  MenuSurface: () => null,
  observeStickyMenuGroups: () => () => {},
  rankByName: <T extends { readonly name: string }>(models: readonly T[]) => models,
  Input: () => null,
  StateDot: () => null,
  Toast: () => null,
  IconCheckOutlineRegular: () => null,
  IconChevronDownOutlineRegular: () => null,
  IconChevronRightOutlineRegular: () => null,
  IconCloseFillRegular: () => null,
  IconDataOutlineRegular: () => null,
  IconWarningOutlineRegular: () => null,
}))

const { ComposerModelSelect, externalAgentPrefix } = await import('../src/composer-model-select.tsx')

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

/**
 * The seat renders through the `model` locale namespace, which the loaded
 * ui-model-selection already installs — this copy deliberately carries no
 * dictionary of its own, so a second one could only drift from the first.
 * Echoing the key back is enough here: with a selection present the visible
 * label is the model's own name, never a dictionary entry.
 */
const echoT = (key: string, params?: Record<string, unknown>): string =>
  Object.keys(params ?? {}).reduce(
    (text, name) => text.replaceAll(`{${name}}`, String(params?.[name])),
    key,
  )

/**
 * A directory snapshot store over one fixed state.
 *
 * The snapshot object is built once: `getSnapshot` must return the same
 * reference until the fact moves, or `useSyncExternalStore` re-renders forever.
 *
 * @param provider - the selected route's provider id.
 * @param groupName - that provider group's display name.
 * @param modelName - the selected model's display name.
 * @returns the store face the component reads through useSyncExternalStore.
 */
function directoryFor(provider: string, groupName: string, modelName: string) {
  const snapshot = {
    current: { provider, model: modelName },
    routable: true,
    groups: [{ id: provider, name: groupName, models: [{ id: modelName, name: modelName }] }],
    failures: [],
    status: 'ready' as const,
    pending: null,
    error: null,
  }
  return { subscribe: () => () => {}, getSnapshot: () => snapshot }
}

/**
 * Mount the component over one directory and read the trigger's visible text.
 * @param provider - the selected route's provider id.
 * @param groupName - that provider group's display name.
 * @param modelName - the selected model's display name.
 * @returns the trigger button's text.
 */
function triggerText(provider: string, groupName: string, modelName: string): string {
  const host = document.createElement('div')
  document.body.append(host)
  const root: Root = createRoot(host)
  act(() => {
    root.render(createElement(ComposerModelSelect, {
      locked: false,
      available: true,
      directory: directoryFor(provider, groupName, modelName),
      load: () => {},
      select: () => Promise.resolve(undefined),
      t: echoT,
    } as never))
  })
  const text = host.querySelector('button')?.textContent ?? ''
  act(() => { root.unmount() })
  host.remove()
  return text
}

describe('外部 agent 前缀规则', () => {
  it('给外部 agent 的路线加前缀，原生路线不动', () => {
    expect(externalAgentPrefix('acp:acp-cursor', 'Cursor', 'grok-4.7')).toBe('Cursor · ')
    expect(externalAgentPrefix('deepseek-official', 'DeepSeek', 'deepseek-chat')).toBe('')
  })

  it('模型名已经以 agent 名开头时不重复拼', () => {
    // 模型显示名可以自定义；已经带了前缀再拼一次就成了「Cursor · Cursor」。
    expect(externalAgentPrefix('acp:acp-cursor', 'Cursor', 'Cursor 主力')).toBe('')
  })

  it('拿不到分组名或路线时安静地不加', () => {
    // 这两种情况下前缀无处可取；显示成原样比显示成半个前缀诚实。
    expect(externalAgentPrefix('acp:acp-cursor', undefined, 'grok-4.7')).toBe('')
    expect(externalAgentPrefix(undefined, 'Cursor', 'grok-4.7')).toBe('')
  })
})

describe('触发按钮上的实际显示', () => {
  it('选外部 agent 时按钮上是「Cursor · grok-4.7」', () => {
    expect(triggerText('acp:acp-cursor', 'Cursor', 'grok-4.7')).toContain('Cursor · grok-4.7')
  })

  it('选原生模型时按钮上只有模型名', () => {
    // 这是本次改动最重要的一条边界：为了看得清 agent 而让所有人都变噪音，
    // 等于把一个界面问题换成了另一个。
    expect(triggerText('deepseek-official', 'DeepSeek', 'deepseek-chat')).not.toContain('DeepSeek ·')
  })
})
