/**
 * 座位遮蔽本身：注册进哪个位置、以什么优先级、撤掉之后会怎样、以及逃生开关。
 *
 * 组件长什么样由 composer-model-select.spec 负责；这里管的是「我们确实盖住了
 * 官方那一版，而且盖得可退」——机制对了但没注册上，界面会安静地退回旧样子而
 * 不报任何错，所以这两半必须分别被测住。
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it, vi } from 'vitest'
import type { ModelSeatServices, ModelSeatSlotHost } from '../src/model-seat.ts'

// The seat module names the component so it can register it, and that component
// renders over ui-primitives' styled components, whose CSS modules Node cannot
// load. Nothing here renders: what is under test is what got registered, so an
// explicit stub is enough — a Proxy would hand back a function for `then` too,
// and the module namespace would read as a thenable that never settles.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  MenuGroup: () => null,
  MenuSurface: () => null,
}))

const { registerModelSeat, MODEL_SEAT_STORAGE_KEY } = await import('../src/model-seat.ts')

/**
 * A recording slot host: what was registered where, and at what priority.
 *
 * `inject` runs the callback and returns a disposer for whatever it
 * registered, which is what the real one does — the seat may not be declared
 * yet, so `inject` is what waits for the declaration and hands back the way
 * out. Returning the slot name instead (the first version of this fake) made
 * the release path untestable rather than testing anything real.
 *
 * @returns the fake host, its registration log, and whether it was disposed.
 */
function recordingHost() {
  const registrations: { options: { name: string; priority?: number }; component: unknown }[] = []
  let disposed = false
  const host: ModelSeatSlotHost = {
    inject: (slot, callback) => {
      const result = callback()
      return typeof result === 'function' ? result : () => {}
    },
    register: (options, component) => {
      registrations.push({ options, component })
      return () => { disposed = true; registrations.length = 0 }
    },
  }
  return { host, registrations, disposed: () => disposed }
}

function services(subagentAddress?: string): ModelSeatServices {
  return {
    modelDirectories: {
      directoryFor: (sessionId: string) => ({
        store: { sessionId },
        load: () => Promise.resolve(undefined),
        select: () => Promise.resolve(undefined),
      }),
    },
    sessions: { subagentAddress: () => subagentAddress },
  }
}

describe('输入框模型入口的座位遮蔽', () => {
  it('注册在同一个座位上，优先级低于官方的 0', () => {
    // 座位按优先级从小到大渲染，所以 -10 才是「我们赢」；写成 0 会和官方那份
    // 撞在同一格，注册当场抛错而不是安静地盖住。
    const { host, registrations } = recordingHost()
    registerModelSeat(host, services())
    expect(registrations.length).toBe(1)
    expect(registrations[0]?.options.name).toBe('conversation.input.model')
    expect(registrations[0]?.options.priority).toBeLessThan(0)
  })

  it('撤掉之后官方那份回到原位', () => {
    // 官方那份我们没有摘；能还回去才是一次可退的接管，而不是一次替换。
    const { host, registrations, disposed } = recordingHost()
    const release = registerModelSeat(host, services())
    expect(registrations.length).toBe(1)
    release()
    expect(disposed()).toBe(true)
  })

  it('注入的是官方自己的目录服务，而不是另建一套', () => {
    // 目录加载、提交选择、加载失败重试都还是官方的，所以注入面必须是同一个
    // 按会话取到的目录；换一套就等于把那些行为也重写了一遍。
    const { host, registrations } = recordingHost()
    registerModelSeat(host, services())
    const inject = registrations[0]?.options as unknown as { inject: (id: string) => { directory: unknown } }
    expect(inject.inject('s1').directory).toEqual({ sessionId: 's1' })
  })

  it('子代理会话里这个入口不出现', () => {
    // 子代理会话选模型会去动直系父会话之外的历史，和官方那一版的判断一致。
    const { host, registrations } = recordingHost()
    registerModelSeat(host, services('agent-1'))
    const inject = registrations[0]?.options as unknown as { inject: (id: string) => { available: boolean } }
    expect(inject.inject('s1').available).toBe(false)
  })

  it('开关设为 off 时根本不注册，官方那份原样留着', () => {
    // harness 升级漂移时的退路：不改代码，一个开关就把接管撤掉。
    localStorage.setItem(MODEL_SEAT_STORAGE_KEY, 'off')
    try {
      const { host, registrations } = recordingHost()
      registerModelSeat(host, services())
      expect(registrations.length).toBe(0)
    } finally {
      localStorage.removeItem(MODEL_SEAT_STORAGE_KEY)
    }
  })

  it('宿主没有模型目录服务时不注册，也不报错', () => {
    // 官方那一份读的是同一个服务；没有它本来就没有模型座位可显示，这里再注册
    // 一份等于把「没这一项」换成装载时崩掉。
    const { host, registrations } = recordingHost()
    expect(() => registerModelSeat(host, {})).not.toThrow()
    expect(registrations.length).toBe(0)
  })
})
