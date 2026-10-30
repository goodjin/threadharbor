/**
 * 浏览器侧与宿主侧必须认同一根 Mermaid 资产路径。
 *
 * 两边各写一个常量，谁改了忘同步都只会表现为运行时的静默 404——页面不报错，
 * 图就是不出现。这里把两个导出钉在一起。
 */

import { describe, expect, it } from 'vitest'
import { MERMAID_ROUTE_PATH as CLIENT_ROUTE } from '../packages/dsh-client/src/mermaid.ts'
import { MERMAID_ROUTE_PATH as HOST_ROUTE } from '../packages/dsh-preset-dispatch/src/mermaid-asset.ts'

describe('Mermaid 资产路由', () => {
  it('客户端与宿主用同一个路径', () => {
    expect(CLIENT_ROUTE).toBe(HOST_ROUTE)
    expect(CLIENT_ROUTE).toBe('/threadharbor/mermaid.js')
  })
})
