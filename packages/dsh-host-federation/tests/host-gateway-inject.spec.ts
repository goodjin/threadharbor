/**
 * 网关注入脚本的行为：脚本正文不能被用户可控的主机名/主机标识提前闭合，
 * 注入的「回本机」条要等 DOM 就绪、且与对方页面里插件自己的切换器二选一。
 *
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { gatewayClientScript } from '../src/host-gateway-path.ts'

/** 在 jsdom 里真正执行注入脚本（IIFE 同步挂条）。 */
function run(hostId: string, hostTitle: string): void {
  new Function(gatewayClientScript(hostId, hostTitle))()
}

/** 让 MutationObserver 回调（微任务）先跑完。 */
function flush(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, 0) })
}

beforeEach(() => {
  document.body.replaceChildren()
})

describe('网关注入脚本', () => {
  it('敌意主机名与主机标识都不会让脚本正文出现 </script', () => {
    const hostileTitle = '</script><script>window.__pwned=1</script>'
    const hostileId = '</script><img src=x onerror=1>'
    const byTitle = gatewayClientScript('mini', hostileTitle)
    const byId = gatewayClientScript(hostileId, '小机器')
    expect(byTitle).not.toContain('</script')
    expect(byId).not.toContain('</script')
    expect(() => { new Function(byTitle) }).not.toThrow()
    expect(() => { new Function(byId) }).not.toThrow()
  })

  it('DOM 就绪后挂上回本机条，标题与链接正确', () => {
    run('mini', '小机器')
    const bar = document.getElementById('th-host-bar')
    expect(bar).not.toBeNull()
    expect(bar?.querySelector('span')?.textContent).toContain('小机器')
    const link = document.getElementById('th-back-home') as HTMLAnchorElement | null
    expect(link).not.toBeNull()
    expect(link?.getAttribute('href')).toBe('/')
  })

  it('对方页面已有切换器时不插条', () => {
    const switcher = document.createElement('div')
    switcher.setAttribute('data-host-switcher', '')
    document.body.appendChild(switcher)
    run('mini', '小机器')
    expect(document.getElementById('th-host-bar')).toBeNull()
  })

  it('我们的条先挂上，对方切换器后出现时移除', async () => {
    run('mini', '小机器')
    expect(document.getElementById('th-host-bar')).not.toBeNull()
    const switcher = document.createElement('div')
    switcher.setAttribute('data-host-switcher', '')
    document.body.appendChild(switcher)
    await flush()
    expect(document.getElementById('th-host-bar')).toBeNull()
  })
})
