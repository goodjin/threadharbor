/**
 * The settings section, rendered and clicked.
 *
 * The catalog is RAW here (hidden rows must remain listed so they can be
 * unhidden), while the switches write the same store the pickers read. The
 * test mounts the real component over in-memory stores and presses the
 * checkboxes — a page that only type-checks is not a page that works.
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import type { HostStorePosture } from '../src/host-store.ts'
import {
  ACP_VISIBILITY_STORAGE_KEY,
  startAcpVisibility,
} from '../src/acp-visibility.ts'
import type { AcpVisibilityStore } from '../src/acp-visibility.ts'
import { createAcpCatalogStore } from '../src/acp-visibility-catalog.ts'
import type { AcpCatalogStore } from '../src/acp-visibility-catalog.ts'
import { AcpVisibilityPanel } from '../src/acp-visibility-panel.tsx'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

/** Echoes the key with its params, so assertions can name both. */
const echoT = (key: string, params?: Record<string, unknown>): string => params === undefined
  ? key
  : `${key}(${Object.entries(params).map(([name, value]) => `${name}=${String(value)}`).join(',')})`

const catalogValue = {
  groups: [
    {
      id: 'deepseek-account',
      name: 'DeepSeek account',
      models: [{ id: 'chat', name: 'Chat' }],
    },
    {
      id: 'acp:cursor',
      name: 'Cursor',
      models: [{ id: 'grok', name: 'Grok' }, { id: 'sonnet', name: 'Sonnet' }],
    },
    { id: 'acp:codex', name: 'Codex', models: [{ id: 'gpt', name: 'GPT' }] },
  ],
  failures: [],
}

function memoryVisibility(): AcpVisibilityStore {
  const values = new Map<string, string>()
  return startAcpVisibility({
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
  })
}

function hostStore(posture: HostStorePosture = { kind: 'host' }) {
  return {
    posture: () => posture,
    subscribe: () => () => {},
  }
}

async function mount(options: {
  catalog?: AcpCatalogStore
  visibility?: AcpVisibilityStore
  host?: ReturnType<typeof hostStore>
} = {}): Promise<{
  host: HTMLElement
  visibility: AcpVisibilityStore
  catalog: AcpCatalogStore
  unmount(): void
}> {
  const visibility = options.visibility ?? memoryVisibility()
  const catalog = options.catalog ?? createAcpCatalogStore(async () => ({ ok: true, value: catalogValue }))
  const host = document.createElement('div')
  document.body.append(host)
  const root: Root = createRoot(host)
  await act(async () => {
    root.render(createElement(AcpVisibilityPanel, {
      visibility,
      catalog,
      hostStore: options.host ?? hostStore(),
      t: echoT,
    } as never))
  })
  // The mount effect's catalog read settles in a microtask; flush it so the
  // first assertion sees the listing, not the loading line.
  await act(async () => {})
  return {
    host,
    visibility,
    catalog,
    unmount: () => {
      act(() => { root.unmount() })
      host.remove()
    },
  }
}

function agentBox(host: HTMLElement, key: string): HTMLElement {
  const box = host.querySelector<HTMLElement>(`[data-agent="${key}"]`)
  if (box === null) throw new Error(`agent box not found: ${key}`)
  return box
}

function checkboxes(box: HTMLElement): HTMLInputElement[] {
  return [...box.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
}

function buttonByText(host: HTMLElement, text: string): HTMLButtonElement {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')]
    .find(candidate => candidate.textContent === text)
  if (button === undefined) throw new Error(`button not found: ${text}`)
  return button
}

describe('ACP 可见性设置栏目', () => {
  it('按 agent 列出原始目录——被屏蔽的行也还在', async () => {
    const visibility = memoryVisibility()
    visibility.set({
      hiddenAgents: ['cursor'],
      hiddenModels: { codex: ['gpt'] },
    })
    const view = await mount({ visibility })
    try {
      const cursor = agentBox(view.host, 'cursor')
      const codex = agentBox(view.host, 'codex')
      // The hidden agent and its models still render; that is the point.
      expect(cursor.textContent).toContain('Cursor')
      expect(cursor.textContent).toContain('Grok')
      expect(cursor.textContent).toContain('acp:cursor')
      expect(codex.textContent).toContain('GPT')
      expect(checkboxes(cursor)[0]?.checked).toBe(true)
      expect(checkboxes(codex)[0]?.checked).toBe(false)
      expect(checkboxes(codex)[1]?.checked).toBe(true)
      expect(view.host.textContent).toContain('acpVisibility.summary(agents=1,models=1)')
    } finally {
      view.unmount()
    }
  })

  it('原生 provider 与 ACP agent 同页列出，勾选写的是它的 provider id', async () => {
    const values = new Map<string, string>()
    const visibility = startAcpVisibility({
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value) },
    })
    const view = await mount({ visibility })
    try {
      const native = agentBox(view.host, 'deepseek-account')
      expect(native.textContent).toContain('DeepSeek account')
      expect(native.textContent).toContain('deepseek-account')
      const toggle = checkboxes(native)[0]
      if (toggle === undefined) throw new Error('provider toggle missing')
      act(() => { toggle.click() })
      expect(visibility.get().hiddenAgents).toEqual(['deepseek-account'])
      expect(JSON.parse(values.get(ACP_VISIBILITY_STORAGE_KEY) ?? '{}')).toEqual({
        hiddenAgents: ['deepseek-account'],
        hiddenModels: {},
      })
    } finally {
      view.unmount()
    }
  })

  it('勾选 agent 屏蔽它，并锁住它的模型开关', async () => {
    const view = await mount()
    try {
      const agentToggle = checkboxes(agentBox(view.host, 'cursor'))[0]
      if (agentToggle === undefined) throw new Error('agent toggle missing')
      act(() => { agentToggle.click() })

      expect(view.visibility.get().hiddenAgents).toEqual(['cursor'])
      const cursor = agentBox(view.host, 'cursor')
      expect(cursor.textContent).toContain('acpVisibility.agentHiddenHint')
      const models = checkboxes(cursor).slice(1)
      expect(models).toHaveLength(2)
      expect(models.every(input => input.disabled)).toBe(true)
      expect(view.host.textContent).toContain('acpVisibility.summary(agents=1,models=0)')
    } finally {
      view.unmount()
    }
  })

  it('勾选模型只隐藏那一项；「全部恢复」清空所有屏蔽', async () => {
    const view = await mount()
    try {
      const modelToggle = checkboxes(agentBox(view.host, 'codex'))[1]
      if (modelToggle === undefined) throw new Error('model toggle missing')
      act(() => { modelToggle.click() })
      expect(view.visibility.get().hiddenModels).toEqual({ codex: ['gpt'] })
      expect(view.host.textContent).toContain('acpVisibility.summary(agents=0,models=1)')

      act(() => { buttonByText(view.host, 'acpVisibility.reset').click() })
      expect(view.visibility.get()).toEqual({ hiddenAgents: [], hiddenModels: {} })
      expect(view.host.textContent).toContain('acpVisibility.summaryNone')
    } finally {
      view.unmount()
    }
  })

  it('存储姿态原样显示，不让「没存上」看起来像存上了', async () => {
    const view = await mount({
      host: hostStore({ kind: 'memory', reason: 'no-channel' }),
    })
    try {
      expect(view.host.textContent).toContain('panel.posture.memoryNoChannel')
      expect(view.host.querySelector('[data-storage-posture="memory"]')).not.toBeNull()
    } finally {
      view.unmount()
    }
  })

  it('读取失败时给出原因与重试；重试成功后就地列出目录', async () => {
    let calls = 0
    const catalog = createAcpCatalogStore(async () => {
      calls += 1
      if (calls === 1) throw new Error('socket closed')
      return { ok: true, value: catalogValue }
    })
    const view = await mount({ catalog })
    try {
      expect(view.host.textContent).toContain('acpVisibility.error.failed(detail=socket closed)')
      act(() => { buttonByText(view.host, 'acpVisibility.retry').click() })
      await act(async () => {})

      expect(calls).toBe(2)
      expect(view.host.textContent).toContain('Cursor')
      expect(view.host.textContent).not.toContain('acpVisibility.error.failed')
    } finally {
      view.unmount()
    }
  })

  it('主机没有目录方法时说 missing，而不是装作目录为空', async () => {
    const view = await mount({ catalog: createAcpCatalogStore(undefined) })
    try {
      expect(view.host.textContent).toContain('acpVisibility.error.missing')
      expect(view.host.textContent).not.toContain('acpVisibility.empty')
    } finally {
      view.unmount()
    }
  })
})

describe('栏目写回存储', () => {
  it('开关写入的就是设置文档里的那个键', async () => {
    const values = new Map<string, string>()
    const visibility = startAcpVisibility({
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value) },
    })
    const view = await mount({ visibility })
    try {
      const toggle = checkboxes(agentBox(view.host, 'cursor'))[0]
      if (toggle === undefined) throw new Error('agent toggle missing')
      act(() => { toggle.click() })
      const stored = values.get(ACP_VISIBILITY_STORAGE_KEY)
      expect(stored).toBeDefined()
      expect(JSON.parse(stored ?? '{}')).toEqual({ hiddenAgents: ['cursor'], hiddenModels: {} })
    } finally {
      view.unmount()
    }
  })
})
