import { describe, expect, it } from 'vitest'
import * as entry from '../src/index.ts'

/**
 * 骨架冒烟：这个包要在真机上作为组合行装载，装载器读到的是本模块的
 * `name` / `inject` / `Config` / `apply`。名字或注入面变了，组合与
 * 路由注册就会静默落空，所以在这里钉死。
 */
describe('dsh-mobile-entry 骨架', () => {
  it('导出插件名与注入声明', () => {
    expect(entry.name).toBe('threadharbor-mobile-entry')
    expect(entry.inject).toContain('webServer')
    expect(entry.inject).toContain('connection')
  })

  it('导出 Config schema 与 apply 入口', () => {
    expect(entry.Config).toBeTruthy()
    expect(typeof entry.Config.toJSON).toBe('function')
    expect(typeof entry.apply).toBe('function')
  })
})
