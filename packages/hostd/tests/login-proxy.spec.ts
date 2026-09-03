import { describe, expect, it } from 'vitest'
import { parseProxyExport } from '../src/login-proxy.ts'

describe('login proxy inheritance', () => {
  it('reads HTTP(S) proxy assignments from export -p output', () => {
    expect(parseProxyExport([
      "export HOME='/Users/jin'",
      "export http_proxy='http://127.0.0.1:7877'",
      'export https_proxy="http://127.0.0.1:7877"',
      'export all_proxy=socks5://127.0.0.1:7877',
      "export no_proxy='localhost,127.0.0.1'",
      'export PATH=/usr/bin',
    ].join('\n'))).toEqual({
      http_proxy: 'http://127.0.0.1:7877',
      https_proxy: 'http://127.0.0.1:7877',
      all_proxy: 'socks5://127.0.0.1:7877',
      no_proxy: 'localhost,127.0.0.1',
    })
  })
})
