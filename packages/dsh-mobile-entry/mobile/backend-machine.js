/**
 * 直连后端：手机直接连一台机器的 DSH。
 *
 * 它不自己实现任何协议——每个方法都转交 app.js 注入的钩子，而钩子就是今天
 * 那些直连调用本身。这样「直连行为不变」不是靠两套代码恰好一致，而是靠
 * **根本没有第二套**：后端只是给既有调用换了个名字。
 *
 * 换后端（连中转站）因此不影响直连：钩子的实现原封不动。
 */

import { PEERS_PATH } from './wire.js'

/**
 * @typedef {object} MachineBackendHooks
 * @property {() => Promise<any>} listSessions            会话清单 RPC
 * @property {(sessionId: string, throughSeq: number|undefined, maxMessages: number|undefined) => Promise<any>} pageMessages
 * @property {(sessionId: string, text: string) => Promise<any>} prompt
 * @property {(sessionId: string) => Promise<any>} cancel
 * @property {(eventId: string, outcome: object) => Promise<any>} answer
 * @property {(handlers: any) => { close(): void }} connectEvents
 * @property {() => Promise<{ peers: any[], error?: string }>} listHosts
 */

/**
 * @param {MachineBackendHooks} hooks
 */
export function createMachineBackend(hooks) {
  return {
    mode: 'machine',
    async listSessions() {
      return await hooks.listSessions()
    },
    async pageMessages(hostId, sessionId, throughSeq, maxMessages) {
      return await hooks.pageMessages(sessionId, throughSeq, maxMessages)
    },
    async prompt(hostId, sessionId, text) {
      return await hooks.prompt(sessionId, text)
    },
    async cancel(hostId, sessionId) {
      return await hooks.cancel(sessionId)
    },
    async answer(hostId, eventId, outcome) {
      return await hooks.answer(eventId, outcome)
    },
    connectEvents(handlers) {
      return hooks.connectEvents(handlers)
    },
    async listHosts() {
      return await hooks.listHosts()
    },
  }
}

export { PEERS_PATH }
