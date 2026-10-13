/**
 * 这份插件的 locale 字典：键、两种语言的齐备、占位符的一致。
 *
 * `ctx.locale.register` 两个语言必须一起交，缺一边就注册不上；占位符在两
 * 种语言里必须同一组，否则切语言会渲染出残句。组件读的键也在这里固定——
 * 组件与字典之间的键名错了，测试比页面先知道。
 */

import { describe, expect, it } from 'vitest'
import { NAMESPACE, en, zh } from '../src/locales.ts'
import type { ClientLocaleKey } from '../src/locales.ts'

/** The keys the two surfaces and the entry read, as the components spell them. */
const KEYS_USED_BY_COMPONENTS: readonly ClientLocaleKey[] = [
  'panel.label',
  'progress.preparing',
  'progress.loading',
  'progress.ready',
  'handover.title',
  'handover.open',
]

/** Every `{name}` placeholder a value carries, in order. */
function placeholders(value: string): string[] {
  return [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]!)
}

describe('locale 字典', () => {
  it('两种语言的键完全一致，且每个值都是非空文案', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    for (const [key, value] of Object.entries(zh)) {
      expect(value.trim(), `zh[${key}]`).not.toBe('')
      expect((en as Record<string, string>)[key]?.trim(), `en[${key}]`).not.toBe('')
    }
  })

  it('两种语言的同一键用同一组占位符', () => {
    for (const [key, value] of Object.entries(zh)) {
      expect(placeholders((en as Record<string, string>)[key]!), `占位符不一致：${key}`)
        .toEqual(placeholders(value))
    }
  })

  it('组件读的每个键都在字典里', () => {
    for (const key of KEYS_USED_BY_COMPONENTS) {
      expect(zh[key], key).toBeDefined()
    }
  })

  it('命名空间就是注册进 locale 服务的那一个', () => {
    // The slot registrations and the entry's register call must name the same
    // namespace, or the framework synthesizes a `t` that finds no dictionary.
    expect(NAMESPACE).toBe('threadharborClient')
  })
})
