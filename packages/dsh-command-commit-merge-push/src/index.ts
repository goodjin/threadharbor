/**
 * The `/commit-merge-push` command: run the three git steps behind one slash
 * command, with the repo's gates in between so a red build never lands.
 *
 * @module @threadharbor/dsh-command-commit-merge-push
 */

import { executeShip } from './ship.ts'

export const name = 'command-commit-merge-push'
export const inject = ['commands']

export function apply(ctx: {
  commands: {
    register(def: {
      name: string
      description: string
      input?: { hint?: string }
      handler: (invocation: { rawInput?: string }) => { kind: 'success' | 'error'; text: string }
    }): void
  }
}): void {
  ctx.commands.register({
    name: 'commit-merge-push',
    description: 'Commit, merge to main, and push',
    input: { hint: '[commit message]' },
    handler: ({ rawInput }) => executeShip(rawInput ?? ''),
  })
}
