/**
 * 这一份文件盯的是**真浏览器能不能把这一页跑起来**。
 *
 * 为什么单独一份：下面两条都长在 vitest 照不到的地方——
 *   1. 原生 ESM 在**链接期**校验具名导出，而 vite 的 SSR transform 把它编译成
 *      属性解构，不校验导出存不存在。于是「导入一个不存在的常量」在用例里全绿，
 *      真浏览器里是整页 SyntaxError、白屏。
 *   2. 用例都是直接调 bootApp，页面自己有没有启动它们不问。
 *
 * 所以这里**不用 vitest 的模块环境**，而是起一个 node 子进程按原生 ESM 逐模块
 * 导入——那才是浏览器的规则。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const MOBILE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'mobile')

/** 用 node 的原生 ESM 导入一个模块，把报错原样带回来。 */
function importNatively(moduleFile: string): { ok: true } | { ok: false; message: string } {
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(moduleFile)})`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true }
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? ''
    return { ok: false, message: stderr.split('\n').find(line => line.includes('Error')) ?? stderr.trim() }
  }
}

describe('手机页的模块图（原生 ESM 规则）', () => {
  it('app.js / backend-machine.js / backend-hub.js 都能被真浏览器实例化', () => {
    for (const file of ['app.js', 'backend-machine.js', 'backend-hub.js']) {
      const result = importNatively(`file://${join(MOBILE_DIR, file)}`)
      expect(result.ok, `${file} 在原生 ESM 下导入失败：${result.ok ? '' : result.message}`).toBe(true)
    }
  })

  it('引用到的具名导出确实存在（钉住上一条背后的具体形状）', () => {
    // 上一条是「整页死掉」的综合症状；这条把最常见的一种单拎出来：
    // 从 wire.js 导入的每个名字都真的导出。
    const wire = readFileSync(join(MOBILE_DIR, 'wire.js'), 'utf8')
    const exported = new Set([...wire.matchAll(/^export (?:const|function|class|async function) (\w+)/gm)].map(m => m[1]))
    for (const file of ['app.js', 'backend-machine.js', 'backend-hub.js']) {
      const source = readFileSync(join(MOBILE_DIR, file), 'utf8')
      for (const block of source.matchAll(/import \{([^}]+)\} from '\.\/wire\.js'/g)) {
        for (const raw of (block[1] ?? '').split(',')) {
          const name = raw.trim()
          if (name.length === 0) continue
          expect(exported.has(name), `${file} 从 wire.js 导入了不存在的 ${name}`).toBe(true)
        }
      }
    }
  })
})

describe('页面自己会启动（用例直调 bootApp，浏览器不会）', () => {
  it('index.html 里有调用 bootApp 的自举脚本', () => {
    const html = readFileSync(join(MOBILE_DIR, 'index.html'), 'utf8')
    expect(html).toMatch(/import\s*\{\s*bootApp\s*\}\s*from\s*'\.\/app\.js'/)
    expect(html).toMatch(/bootApp\s*\(\s*root\s*\)/)
  })

  it('自举拿的是页面里那个根节点，而不是自己造一个', () => {
    const html = readFileSync(join(MOBILE_DIR, 'index.html'), 'utf8')
    expect(html).toMatch(/getElementById\(\s*'app'\s*\)/)
  })
})
