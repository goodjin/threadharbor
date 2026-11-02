/**
 * 结果框（AnswerCard）的编辑功能。
 *
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import type { MarkdownTurnReaders } from '../src/markdown-turn-sources.ts'
import { AnswerCard } from '../src/answer-card.tsx'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const sleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

async function waitFor(check: () => boolean, what: string, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(5)
  }
}

function readers(overrides?: Partial<Pick<MarkdownTurnReaders, 'sendToSession' | 'createSession'>>) {
  return {
    sendToSession: overrides?.sendToSession ?? vi.fn(async () => {}),
    createSession: overrides?.createSession ?? vi.fn(async () => 'new-sess'),
  } as unknown as MarkdownTurnReaders
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('AnswerCard 编辑', () => {
  it('有 readers 时头部出现编辑按钮；点开把正文纯文本变成文本框，发送调用 sendToSession', async () => {
    const send = vi.fn(async () => {})
    const face = readers({ sendToSession: send })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    await act(async () => {
      root.render(createElement(AnswerCard, {
        blocks: [{ kind: 'text', text: '最终答案' }],
        sessionId: 'sess',
        readers: face,
        t: (key: string) => key,
      }, createElement('span', { 'data-native': true }, 'native')))
    })
    const editBtn = container.querySelector('[data-action="edit-answer"]') as HTMLButtonElement
    expect(editBtn).not.toBeNull()
    await act(async () => { editBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const ta = container.querySelector('[data-answer-edit-input]') as HTMLTextAreaElement
    expect(ta).not.toBeNull()
    expect(ta.value).toBe('最终答案')
    await act(async () => {
      ta.value = '改过的结论'
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const sendBtn = container.querySelector('[data-action="send-answer"]') as HTMLButtonElement
    await act(async () => { sendBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(send).toHaveBeenCalledWith('sess', '改过的结论')
    await act(async () => { root.unmount() })
  })

  it('新建会话：先 createSession 拿到新会话号，再把内容发到新会话', async () => {
    const send = vi.fn(async () => {})
    const create = vi.fn(async () => 'new-sess')
    const face = readers({ sendToSession: send, createSession: create })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    await act(async () => {
      root.render(createElement(AnswerCard, {
        blocks: [{ kind: 'text', text: '最终答案' }],
        sessionId: 'sess',
        readers: face,
        t: (key: string) => key,
      }, createElement('span', null, 'native')))
    })
    const editBtn = container.querySelector('[data-action="edit-answer"]') as HTMLButtonElement
    await act(async () => { editBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const newBtn = container.querySelector('[data-action="new-session-answer"]') as HTMLButtonElement
    await act(async () => { newBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(create).toHaveBeenCalledTimes(1)
    // 发到新会话，内容带上「来自结果框」前缀。
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toBe('new-sess')
    expect(send.mock.calls[0][1]).toContain('最终答案')
    await act(async () => { root.unmount() })
  })

  it('取消回到只读，文本框消失', async () => {
    const face = readers()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    await act(async () => {
      root.render(createElement(AnswerCard, {
        blocks: [{ kind: 'text', text: '最终答案' }],
        sessionId: 'sess',
        readers: face,
        t: (key: string) => key,
      }, createElement('span', null, 'native')))
    })
    const editBtn = container.querySelector('[data-action="edit-answer"]') as HTMLButtonElement
    await act(async () => { editBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(container.querySelector('[data-answer-edit-input]')).not.toBeNull()
    const cancel = container.querySelector('[data-action="cancel-answer"]') as HTMLButtonElement
    await act(async () => { cancel.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(container.querySelector('[data-answer-edit-input]')).toBeNull()
    // 只读态头部仍有复制按钮。
    expect(container.querySelector('[data-action="copy-answer"]')).not.toBeNull()
    await act(async () => { root.unmount() })
  })

  it('没有 readers 时不渲染编辑按钮（拿不到会话能力就不放）', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    await act(async () => {
      root.render(createElement(AnswerCard, {
        blocks: [{ kind: 'text', text: '最终答案' }],
        t: (key: string) => key,
      }, createElement('span', null, 'native')))
    })
    expect(container.querySelector('[data-action="edit-answer"]')).toBeNull()
    expect(container.querySelector('[data-action="copy-answer"]')).not.toBeNull()
    await act(async () => { root.unmount() })
  })
})
