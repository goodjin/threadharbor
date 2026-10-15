/**
 * state.json 的形状与读-改-写纪律。
 *
 * 这份文档里装的是「下次还要靠它活下去的东西」：已换到的凭据、已分配的隧道端口。
 * 所以它的规则只有一条——看不懂就整份作废，绝不局部修剪。留下看得懂的那一半
 * 等于静默使用半份数据，而半份凭据比没有凭据更难排查。
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { StateStore } from '../src/state.ts'

function pathIn(): string {
  return join(mkdtempSync(join(tmpdir(), 'relay-state-')), 'state.json')
}

describe('状态文档', () => {
  it('文件不存在时按全空文档读（首次使用不是错误）', () => {
    const doc = new StateStore(pathIn()).read()
    expect(doc).toEqual({ version: 1, credentials: [], tunnels: {}, lastSeen: {} })
  })

  it('内容损坏时按全空文档读而不是抛错（凭据与端口会被重新换、重新分配）', () => {
    const path = pathIn()
    writeFileSync(path, '{ 这不是 JSON')
    expect(new StateStore(path).read().credentials).toEqual([])
  })

  it('版本不认识时整份作废', () => {
    const path = pathIn()
    writeFileSync(path, JSON.stringify({ version: 2, credentials: [], tunnels: {} }))
    expect(new StateStore(path).read()).toEqual({ version: 1, credentials: [], tunnels: {}, lastSeen: {} })
  })

  it('mutate 抛错时不落盘', () => {
    const path = pathIn()
    const store = new StateStore(path)
    store.markSeen('mac-a', 7)
    expect(() => store.update(() => { throw new Error('改坏了') })).toThrow('改坏了')
    expect(new StateStore(path).lastSeenOf('mac-a')).toBe(7)
  })

  it('update 每次从盘上现读：两个持有者各改各的段都不丢对方的', () => {
    const path = pathIn()
    const tunnels = new StateStore(path)
    const credentials = new StateStore(path)
    tunnels.update(doc => ({ ...doc, tunnels: { 'mac-a': { port: 41100 } } }))
    credentials.update(doc => ({ ...doc, credentials: [{ hostId: 'mac-a', cookie: 'v1.x', obtainedAt: 1 }] }))
    const doc = new StateStore(path).read()
    expect(doc.tunnels).toEqual({ 'mac-a': { port: 41100 } })
    expect(doc.credentials).toHaveLength(1)
  })
})

describe('lastSeen（机器离线时手机上要能说清它最后一次有动静是什么时候）', () => {
  it('记下时刻并读回；没记过的机器是 undefined', () => {
    const path = pathIn()
    const store = new StateStore(path)
    expect(store.lastSeenOf('mac-a')).toBeUndefined()
    expect(store.markSeen('mac-a', 1_700_000_000_000)).toBe(1_700_000_000_000)
    expect(new StateStore(path).lastSeenOf('mac-a')).toBe(1_700_000_000_000)
  })

  it('写 lastSeen 不影响别的段（凭据与隧道分配要原样留着）', () => {
    const path = pathIn()
    const store = new StateStore(path)
    store.update(doc => ({
      ...doc,
      credentials: [{ hostId: 'mac-a', cookie: 'v1.x', obtainedAt: 1 }],
      tunnels: { 'mac-a': { port: 41100 } },
    }))
    store.markSeen('mac-a', 42)
    const doc = new StateStore(path).read()
    expect(doc.credentials).toHaveLength(1)
    expect(doc.tunnels).toEqual({ 'mac-a': { port: 41100 } })
    expect(doc.lastSeen['mac-a']).toBe(42)
  })

  it('整段缺失的旧文档按「都没见过」读，不作废别的段', () => {
    const path = pathIn()
    writeFileSync(path, JSON.stringify({ version: 1, credentials: [], tunnels: { 'mac-a': { port: 41100 } } }))
    const doc = new StateStore(path).read()
    expect(doc.lastSeen).toEqual({})
    expect(doc.tunnels).toEqual({ 'mac-a': { port: 41100 } })
  })

  it('lastSeen 段形状不对 → 整份作废（半份数据比没有更难排查）', () => {
    const path = pathIn()
    writeFileSync(path, JSON.stringify({ version: 1, credentials: [], tunnels: {}, lastSeen: { 'mac-a': '刚才' } }))
    expect(new StateStore(path).read().lastSeen).toEqual({})
  })
})
