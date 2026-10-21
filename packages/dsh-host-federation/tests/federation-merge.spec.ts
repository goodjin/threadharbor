/**
 * 对端推来的登记簿怎样落到本机：已登记的条目以本机为准（地址、SSH、读数
 * 不被改写），对端只能刷新自己那台的令牌、补上本机缺的令牌、以及介绍本机
 * 还没见过的主机。
 */

import { describe, expect, it } from 'vitest'
import { mergeFederationRegistry } from '../src/federation-merge.ts'

const NOW = 1_752_000_000_000

function self(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hostId: 'mac2',
    hostTitle: '小机器',
    address: 'http://10.0.0.8:3081',
    launchUrl: 'http://10.0.0.8:3081/?token=new',
    announcedAt: NOW,
    ...overrides,
  }
}

function localEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hostId: 'mac2',
    hostTitle: '旧名字',
    address: 'http://10.0.0.8:3081',
    launchUrl: 'http://10.0.0.8:3081/?token=old',
    createdAt: 1,
    ...overrides,
  }
}

function parse(json: string): Array<Record<string, unknown>> {
  return JSON.parse(json) as Array<Record<string, unknown>>
}

describe('对端推送的合并', () => {
  it('没见过的发送方按它的自述新增，令牌与名称都收下', () => {
    const result = mergeFederationRegistry(undefined, { self: self(), hosts: [] }, 'mac1', NOW)
    expect(result.changed).toBe(true)
    expect(result.added).toBe(1)
    expect(result.learned).toEqual(['mac2'])
    expect(parse(result.json)).toEqual([{
      hostId: 'mac2',
      hostTitle: '小机器',
      address: 'http://10.0.0.8:3081',
      launchUrl: 'http://10.0.0.8:3081/?token=new',
      createdAt: NOW,
    }])
  })

  it('已登记的同地址主机：刷新名称与令牌，SSH 与读数原样保留', () => {
    const local = [localEntry({
      ssh: { target: '10.0.0.8', authMode: 'identityFile', identityFile: '/k' },
      remote: { deployment: 'deployed', liveness: 'running', readAt: 5 },
    })]
    const result = mergeFederationRegistry(JSON.stringify(local), { self: self(), hosts: [] }, 'mac1', NOW)
    expect(result.changed).toBe(true)
    expect(result.added).toBe(0)
    expect(result.learned).toEqual([])
    const entry = parse(result.json)[0]
    expect(entry).toMatchObject({
      hostTitle: '小机器',
      launchUrl: 'http://10.0.0.8:3081/?token=new',
      ssh: { target: '10.0.0.8', authMode: 'identityFile', identityFile: '/k' },
      remote: { deployment: 'deployed', liveness: 'running', readAt: 5 },
    })
  })

  it('同 id 但地址不同：只改名称，不拿对端的令牌覆盖本机的地址', () => {
    const local = [localEntry({ address: 'http://192.168.1.9:3080', launchUrl: 'http://192.168.1.9:3080/?token=mine' })]
    const result = mergeFederationRegistry(JSON.stringify(local), { self: self(), hosts: [] }, 'mac1', NOW)
    expect(result.changed).toBe(true)
    expect(parse(result.json)[0]).toMatchObject({
      hostTitle: '小机器',
      address: 'http://192.168.1.9:3080',
      launchUrl: 'http://192.168.1.9:3080/?token=mine',
    })
  })

  it('完全相同的推送不改动登记簿', () => {
    const local = [localEntry({ hostTitle: '小机器', launchUrl: 'http://10.0.0.8:3081/?token=new' })]
    const result = mergeFederationRegistry(JSON.stringify(local), { self: self(), hosts: [] }, 'mac1', NOW)
    expect(result.changed).toBe(false)
    expect(result.added).toBe(0)
  })

  it('发送方介绍的新主机按缺失新增；本机自己与发送方自己都不会被重复登记', () => {
    const result = mergeFederationRegistry(undefined, {
      self: self(),
      hosts: [
        { hostId: 'mac3', hostTitle: '第三台', address: 'http://10.0.0.9:3080', launchUrl: 'http://10.0.0.9:3080/?token=t3', createdAt: 9 },
        { hostId: 'mac1', hostTitle: '我', address: 'http://10.0.0.1:3080', launchUrl: 'http://10.0.0.1:3080/?token=t1', createdAt: 9 },
        { hostId: 'mac2', hostTitle: '重复的发送方', address: 'http://10.0.0.8:3081', launchUrl: 'http://10.0.0.8:3081/?token=x', createdAt: 9 },
      ],
    }, 'mac1', NOW)
    const ids = parse(result.json).map(entry => entry['hostId'])
    expect(ids.sort()).toEqual(['mac2', 'mac3'])
    expect(result.added).toBe(2)
  })

  it('本机登记过但缺令牌、地址一致时补上令牌；地址不一致不补', () => {
    const matched = mergeFederationRegistry(JSON.stringify([
      { hostId: 'mac3', hostTitle: '第三台', address: 'http://10.0.0.9:3080', createdAt: 1 },
    ]), {
      self: self(),
      hosts: [{ hostId: 'mac3', hostTitle: '第三台', address: 'http://10.0.0.9:3080', launchUrl: 'http://10.0.0.9:3080/?token=t3', createdAt: 1 }],
    }, 'mac1', NOW)
    expect(matched.refreshed).toBe(1)
    // mac2 是本机没见过的发送方，先被新增；mac3 是补上的令牌。
    expect(matched.learned).toEqual(['mac2', 'mac3'])
    expect(parse(matched.json)[0]).toMatchObject({ launchUrl: 'http://10.0.0.9:3080/?token=t3' })

    const mismatched = mergeFederationRegistry(JSON.stringify([
      { hostId: 'mac3', hostTitle: '第三台', address: 'http://192.168.1.9:3080', createdAt: 1 },
    ]), {
      self: self(),
      hosts: [{ hostId: 'mac3', hostTitle: '第三台', address: 'http://10.0.0.9:3080', launchUrl: 'http://10.0.0.9:3080/?token=t3', createdAt: 1 }],
    }, 'mac1', NOW)
    expect(mismatched.refreshed).toBe(0)
    expect(parse(mismatched.json)[0]).not.toHaveProperty('launchUrl')
  })

  it('令牌与地址不同源、字段损坏、缺令牌的条目一律不进登记簿', () => {
    const result = mergeFederationRegistry(undefined, {
      self: self(),
      hosts: [
        { hostId: 'bad-token', address: 'http://10.0.0.9:3080', launchUrl: 'http://evil.example:3080/?token=t', createdAt: 1 },
        { hostId: 'no-token', address: 'http://10.0.0.9:3080', launchUrl: 'http://10.0.0.9:3080/', createdAt: 1 },
        { hostId: 'bad/id', address: 'http://10.0.0.9:3080', launchUrl: 'http://10.0.0.9:3080/?token=t', createdAt: 1 },
        'not-an-entry',
      ],
    }, 'mac1', NOW)
    expect(parse(result.json).map(entry => entry['hostId'])).toEqual(['mac2'])
    expect(result.added).toBe(1)
  })

  it('本机已有令牌时对端介绍的同 id 条目不覆盖本机令牌', () => {
    const local = [localEntry()]
    const result = mergeFederationRegistry(JSON.stringify(local), {
      self: self(),
      hosts: [{ hostId: 'mac2', hostTitle: '对端的叫法', address: 'http://10.0.0.8:3081', launchUrl: 'http://10.0.0.8:3081/?token=peer', createdAt: 1 }],
    }, 'mac1', NOW)
    // 发送方对自己的名字有权威性（self 分支），但令牌只按 self 的地址决定。
    expect(parse(result.json)[0]).toMatchObject({ hostTitle: '小机器', launchUrl: 'http://10.0.0.8:3081/?token=new' })
  })

  it('损坏的本机登记簿不清空，能在可解析的条目上合并', () => {
    const result = mergeFederationRegistry('not json', { self: self(), hosts: [] }, 'mac1', NOW)
    expect(result.changed).toBe(true)
    expect(parse(result.json)).toHaveLength(1)
  })
})
