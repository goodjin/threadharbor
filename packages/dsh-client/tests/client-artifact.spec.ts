import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('DSH browser artifact', () => {
  it('does not require workspace packages from the DSH module table', () => {
    let factory: ((require: (specifier: string) => unknown) => unknown) | undefined
    const fakeWindow = { __ModuleLoader__: undefined as unknown }
    const fakeDocument = {
      querySelector: () => null,
      createElement: () => ({ dataset: {}, textContent: '' }),
      head: { appendChild: () => undefined },
    }
    Object.assign(globalThis, {
      window: fakeWindow,
      document: fakeDocument,
    })
    fakeWindow.__ModuleLoader__ = {
      load(registration: { id: string; factory: (require: (specifier: string) => unknown) => unknown }) {
        expect(registration.id).toBe('@threadharbor/dsh-client')
        factory = registration.factory
      },
    }

    Function(readFileSync('packages/dsh-client/lib/client.js', 'utf8'))()

    expect(factory).toBeTypeOf('function')
    expect(() => factory?.((specifier) => {
      if (specifier.startsWith('@threadharbor/')) throw new Error(`unexpected module-table request: ${specifier}`)
      return {}
    })).not.toThrow()
  })

  it('inlines @threadharbor/protocol instead of asking the DSH module table', () => {
    const js = readFileSync('packages/dsh-client/lib/client.js', 'utf8')
    expect(js).not.toContain('@threadharbor/protocol')
  })

  it('keeps host actions on one row and nests Agent setup under the selected backend', () => {
    const js = readFileSync('packages/dsh-client/lib/client.js', 'utf8')
    expect(js).toContain('设置')
    expect(js).toContain('添加项目')
    expect(js).toContain('设置主机')
    expect(js).toContain('会话操作')
    expect(js).toContain('主机 → 项目 → 会话')
    expect(js).toContain('正在打开配置文件。')
    expect(js).toContain('DSH API Key 已配置')
    expect(js).toContain('修改')
    expect(js).not.toContain('安装 / 登录 / 配置 Agent')
    expect(js).toContain('label-primary-foreground')
    expect(js).toContain('关闭重命名会话')
    expect(js).not.toContain('window.prompt')
    expect(js).not.toContain('重新部署 hostd')
    expect(js).toContain('保存名称')
    expect(js).toContain('升级 hostd')
    expect(js).toContain('部署 hostd')
    expect(js).toContain('请确认远端服务已启动后再试')
    expect(js).toContain('取消隐藏')
    expect(js).toContain('设置：查看全部主机、项目和会话')
    expect(js).toContain('后台操作')
    expect(js).toContain('部署中…')
    expect(js).toContain('请在远端主机安装')
    expect(js).toContain('浏览中…')
    expect(js).toContain('归档中…')
    expect(js).toContain('停止中…')
    expect(js).toContain('提交中…')
    expect(js).toContain('正在接入实时通道')
    expect(js).toContain('/remote-agent/ws')
  })
})
