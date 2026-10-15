/**
 * 远端读数解析的合同。
 *
 * 读数是对方机器给的 JSON，字段可能是旧的、缺的、甚至被改坏的。解析刻意
 * 不对称：单个字段宽容——认不出的枚举值降级成 unknown、坏端口只丢自己，
 * 因为一个坏字段不该否定一次真实发生过的读取；整条记录严格——不是对象、
 * readAt 不是有限数字，就返回 undefined，宁可不显示，也不拿编造的时刻当真。
 */

import { describe, expect, it } from 'vitest'
import { parseRemoteReport } from '../src/remote-report.ts'

describe('parseRemoteReport', () => {
  it('读出完整形状', () => {
    expect(parseRemoteReport({
      deployment: 'deployed',
      liveness: 'running',
      livenessNote: '面板在跑',
      port: 3081,
      launchUrl: 'http://192.168.1.20:3081/?token=abc',
      readAt: 1_760_000_000_000,
    })).toEqual({
      deployment: 'deployed',
      liveness: 'running',
      livenessNote: '面板在跑',
      port: 3081,
      launchUrl: 'http://192.168.1.20:3081/?token=abc',
      readAt: 1_760_000_000_000,
    })
  })

  it('deployment 不是三个取值之一时读成 unknown，其余字段保留', () => {
    expect(parseRemoteReport({ deployment: 'installed', liveness: 'running', readAt: 5 }))
      .toEqual({ deployment: 'unknown', liveness: 'running', readAt: 5 })
  })

  it('liveness 不是三个取值之一时读成 unknown，其余字段保留', () => {
    expect(parseRemoteReport({ deployment: 'undeployed', liveness: true, readAt: 5 }))
      .toEqual({ deployment: 'undeployed', liveness: 'unknown', readAt: 5 })
  })

  it('port 不是 1–65535 的整数时丢弃该字段，其余保留', () => {
    for (const bad of [0, 65_536, 30.5, '3081', null]) {
      expect(parseRemoteReport({ deployment: 'deployed', liveness: 'running', port: bad, readAt: 5 }))
        .toEqual({ deployment: 'deployed', liveness: 'running', readAt: 5 })
    }
  })

  it('readAt 缺失或不是有限数字时整条返回 undefined', () => {
    expect(parseRemoteReport({ deployment: 'deployed', liveness: 'running' })).toBeUndefined()
    expect(parseRemoteReport({ deployment: 'deployed', liveness: 'running', readAt: 'yesterday' })).toBeUndefined()
    expect(parseRemoteReport({ readAt: Number.NaN })).toBeUndefined()
    expect(parseRemoteReport({ readAt: Number.POSITIVE_INFINITY })).toBeUndefined()
  })

  it('非对象、非数组的输入返回 undefined', () => {
    expect(parseRemoteReport(null)).toBeUndefined()
    expect(parseRemoteReport('deployed')).toBeUndefined()
    expect(parseRemoteReport(42)).toBeUndefined()
    expect(parseRemoteReport(['deployed', 'running', 5])).toBeUndefined()
  })
})
