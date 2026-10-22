/**
 * 模型标签：我们占的是官方那个标签子座位，不是整个模型座位。
 *
 * 这里管三件事：
 * - **注册在哪**：子座位 `conversation.input.model.label`（官方 0.2.1-rc.2 声明的），
 *   优先级低于官方那个占用者。注册**等子座位出现**才发生——这正是顺序无关的
 *   原因：2026-10-20 桌面版上旧做法靠一次性读模型目录服务决定要不要注册，
 *   读不到就静默不注册，官方座位顶上，界面上只剩裸模型名（web 上恰好读到了，
 *   所以看得到前缀——同一个构建，两种表现）。
 * - **前缀规则**：只给 `acp:` 开头的外部 agent 路由加；原生 provider 保持裸模型名。
 * - **不弄丢东西**：官方那个 1017 角标（只对官方 Flash 的某个固定版本）由我们
 *   复刻——我们接管了这个座位，就不把它弄丢。
 *
 * 组件渲染出来长什么样由本文件一起验（label 的文字就是界面上的那行字）。
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// ui-primitives 的样式模块 Node 加载不了，整包 mock 成桩（与本仓其它界面用例同款）。
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Tag: ({ children }: { children?: unknown }) => createElement('span', { 'data-tag': '' }, children),
}))

const {
  MODEL_LABEL_SLOT,
  MODEL_LABEL_STORAGE_KEY,
  agentPrefix,
  modelLabelShadowedOff,
  registerModelLabel,
  ModelLabelWithAgent,
} = await import('../src/model-label.tsx')

/**
 * A recording slot host that models the real order-independence: `inject`
 * parks the callback until the slot is declared, and declaring runs it.
 */
function recordingHost() {
  const registrations: { options: { name: string; priority?: number; locale?: string }; component: unknown }[] = []
  const parked = new Map<string, () => () => void>()
  let registered: (() => void) | undefined
  let disposed = false
  const host = {
    inject: (slot: string, callback: () => () => void) => {
      parked.set(slot, callback)
      // 真的 inject 交回的是「它注册的那一份」的退路，不是「别再等这个座位」。
      return () => {
        parked.delete(slot)
        registered?.()
      }
    },
    register: (options: { name: string; priority?: number; locale?: string }, component: unknown) => {
      registrations.push({ options, component })
      return () => { disposed = true; registrations.length = 0 }
    },
  }
  /** The moment the official seat declares the label slot. */
  const declare = (): void => {
    const callback = parked.get(MODEL_LABEL_SLOT)
    if (callback === undefined) return
    registered = callback()
  }
  return { host, registrations, declare, disposed: () => disposed }
}

const provider = (id: string, name: string) => ({ id, name })
const model = (id: string, name: string) => ({ id, name })

describe('输入框模型名：占标签子座位', () => {
  it('注册在官方声明的标签子座位上，优先级低于官方那个占用者', () => {
    // 座位按优先级从小到大渲染，所以 -10 才是「我们赢」；写成 0 会和官方那份
    // 撞在同一格，注册当场抛错而不是安静地盖住。
    const { host, registrations, declare } = recordingHost()
    registerModelLabel(host)
    expect(registrations).toHaveLength(0)
    declare()
    expect(registrations).toHaveLength(1)
    expect(registrations[0]?.options.name).toBe(MODEL_LABEL_SLOT)
    expect(registrations[0]?.options.priority).toBeLessThan(0)
    // 座位按这个命名空间把字典读法交给占用者；没声明就没有 t，角标那一处会炸。
    expect(registrations[0]?.options.locale).toBe('threadharborClient')
  })

  it('等子座位出现才注册：装载顺序不影响结果', () => {
    // 这条是 2026-10-20 桌面版那次的正身：旧做法在挂载那一刻读一次模型目录
    // 服务，读不到就静默不注册。现在注册挂在 inject 上，子座位一出现就注册。
    const { host, registrations, declare } = recordingHost()
    registerModelLabel(host)
    expect(registrations).toHaveLength(0)
    declare()
    expect(registrations).toHaveLength(1)
  })

  it('撤掉之后官方那个占用者回到原位', () => {
    const { host, registrations, declare, disposed } = recordingHost()
    const release = registerModelLabel(host)
    declare()
    expect(registrations).toHaveLength(1)
    release()
    expect(disposed()).toBe(true)
  })

  it('开关设为 off 时根本不注册，官方那个标签原样留着', () => {
    globalThis.localStorage.setItem(MODEL_LABEL_STORAGE_KEY, 'off')
    try {
      expect(modelLabelShadowedOff()).toBe(true)
      const { host, registrations, declare } = recordingHost()
      registerModelLabel(host)
      declare()
      expect(registrations).toHaveLength(0)
    } finally {
      globalThis.localStorage.removeItem(MODEL_LABEL_STORAGE_KEY)
    }
  })
})

describe('模型名上的 agent 前缀', () => {
  it('外部 agent 的路由加前缀：谁在回答一眼看得见', () => {
    expect(agentPrefix(provider('acp:acp-zcode', 'ZCode'), model('GLM-5.3', 'GLM-5.3')))
      .toBe('ZCode · ')
  })

  it('原生 provider 保持裸模型名：这个歧义是外部 agent 带来的', () => {
    expect(agentPrefix(provider('zai-coding-cn', 'GLM'), model('GLM-5.3', 'GLM-5.3'))).toBe('')
  })

  it('模型名里碰巧出现 agent 名字也照加前缀：规则不看字符串脸色', () => {
    // Grok 4.7 这个模型名只是恰好以 Grok 开头，不是「已经带了前缀」的信号。
    // 去重会让前缀随命名漂移（Grok 掉了、别的带着），规范不统一——宁可显示成
    // Grok · Grok 4.7，也不让规则去猜。
    expect(agentPrefix(provider('acp:acp-grok', 'Grok'), model('grok-4.7', 'Grok 4.7')))
      .toBe('Grok · ')
  })

  it('渲染出来的那行字就是「前缀 + 模型名」', () => {
    const markup = renderToStaticMarkup(createElement(ModelLabelWithAgent, {
      provider: provider('acp:acp-codex', 'Codex'),
      model: model('gpt-6-astra', 'GPT-6-Astra'),
      t: (key: string) => (key === 'model-label.badge.1017' ? '1017' : key),
    }))
    expect(markup).toContain('Codex · GPT-6-Astra')
  })

  it('官方那个 1017 角标一并复刻：接管了座位就不弄丢它', () => {
    const markup = renderToStaticMarkup(createElement(ModelLabelWithAgent, {
      provider: provider('deepseek-official', 'DeepSeek'),
      model: model('deepseek-flash', 'DeepSeek-V4.1-Flash'),
      t: (key: string) => (key === 'model-label.badge.1017' ? '1017' : key),
    }))
    expect(markup).toContain('DeepSeek-V4.1-Flash')
    expect(markup).toContain('1017')
  })

  it('其余模型不挂角标', () => {
    const markup = renderToStaticMarkup(createElement(ModelLabelWithAgent, {
      provider: provider('deepseek-official', 'DeepSeek'),
      model: model('deepseek-v4-pro', 'DeepSeek-V4-Pro'),
      t: (key: string) => (key === 'model-label.badge.1017' ? '1017' : key),
    }))
    expect(markup).not.toContain('1017')
  })
})
