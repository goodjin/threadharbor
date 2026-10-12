import { describe, expect, it } from 'vitest'
import { HOST_STORE_ENTRY_ID } from '../src/host-store.ts'
import { Config } from '../src/host-store.ts'

/**
 * The host-side slot the browser's host-scoped settings persist through.
 *
 * The entry itself has no behavior: its whole job is to exist as a
 * composition row whose volatile config the settings service turns into a
 * `remote.settings` namespace. These tests pin the two facts that make that
 * work — the volatile dictionary, and the entry id the browser addresses —
 * because a silent rename or a missing volatile marker leaves the browser
 * writing into a namespace that does not exist, which is exactly the kind of
 * breakage that only shows up on a real page.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

describe('threadharbor host store entry', () => {
  it('composition id is the namespace the browser writes through', () => {
    expect(HOST_STORE_ENTRY_ID).toBe('threadharbor-host-store')
  })

  it('carries a string dictionary: the browser stores both keys as JSON strings', () => {
    // 与浏览器侧现在的两个存储键一字不差：登记簿和身份默认层。
    const document = {
      data: {
        'dsh.host.registry': '[{"hostId":"bench","hostTitle":"测试机","address":"http://192.168.1.20:3081","createdAt":12}]',
        'dsh.host.identity': '{"hostId":"workstation","hostTitle":"工作室主机"}',
      },
    }
    const result: unknown = Config['~standard'].validate(document)
    expect(isRecord(result) && 'value' in result).toBe(true)
    const value = isRecord(result) ? result['value'] : undefined
    const data = isRecord(value) ? value['data'] : undefined
    // volatile 字段验证后是引用单元（cosmokit volatile），设置通道在
    // plainConfig 里统一 .get() 展开；这里同样展开后比对。
    expect(isRecord(data) && typeof data['get'] === 'function').toBe(true)
    if (isRecord(data) && typeof data['get'] === 'function') expect(data['get']()).toEqual(document.data)
  })

  it('refuses non-string values: the channel carries JSON strings, not structures', () => {
    const result: unknown = Config['~standard'].validate({ data: { 'dsh.host.registry': { not: 'a string' } } })
    expect(isRecord(result) && Array.isArray(result['issues'])).toBe(true)
  })

  it('data is volatile: only volatile config becomes a settings namespace at all', () => {
    // schema.ts 的 volatileForm 只保留带 volatile 标记的子树；整个条目若没有
    // volatile 字段，settings.describe() 里就没有这个命名空间，浏览器侧的
    // 读取会拿到「命名空间不存在」。schema 的 JSON 是 refs 表：顶层 uid 指向
    // 根节点，dict 里存的是字段节点编号。逐层运行时收窄，不靠类型断言。
    const json: unknown = Config.toJSON()
    const uid = isRecord(json) ? json['uid'] : undefined
    const refs = isRecord(json) ? json['refs'] : undefined
    expect(typeof uid).toBe('number')
    expect(isRecord(refs)).toBe(true)
    const root = isRecord(refs) && typeof uid === 'number' ? refs[String(uid)] : undefined
    const dict = isRecord(root) ? root['dict'] : undefined
    const ref = isRecord(dict) ? dict['data'] : undefined
    expect(typeof ref).toBe('number')
    const node = isRecord(refs) && typeof ref === 'number' ? refs[String(ref)] : undefined
    const meta = isRecord(node) ? node['meta'] : undefined
    expect(isRecord(meta) && meta['volatile'] === true).toBe(true)
  })
})
