/**
 * The client-side terminal sub-protocol.
 *
 * grok hands its shell work to the client: it calls `terminal/create` and then
 * `terminal/wait_for_exit`, and expects output back for both. Answering only the
 * first one looks like it worked — the turn completes — while the tool result is
 * a string saying the second call could not be served.
 *
 * Worth knowing before building this: DSH deliberately rejected this sub-protocol
 * for its own use, because routing execution to the client forks execution into
 * a second backend and bypasses its env scrub and background-task ownership
 * (`reference/deepseek-harness/.agents/notes/archived/feature/
 * 2026-06-18-acp-terminal-and-tool-rendering.md`). The spawn step is therefore
 * injectable, so a host can keep its own execution policy while still serving an
 * agent that insists on this shape.
 */

import { describe, expect, it } from 'vitest'
import { TerminalService } from '../src/terminals.ts'
import type { SpawnedCommand } from '../src/terminals.ts'

/** A stand-in for a spawned process, so no test needs a real shell. */
function fakeCommand(result: { readonly output?: string; readonly exitCode?: number } = {}) {
  let killed = false
  return {
    killed: () => killed,
    command: {
      output: () => result.output ?? '',
      exited: Promise.resolve(result.exitCode ?? 0),
      kill: () => { killed = true },
    } satisfies SpawnedCommand,
  }
}

describe('TerminalService', () => {
  it('returns only a terminal id when creating a terminal, as the protocol specifies', async () => {
    // ACP's CreateTerminalResponse carries `terminalId` and nothing else.
    // Sending an extra field makes a strict decoder reject the whole response,
    // and the agent reports it as a failed tool rather than a shape problem.
    const fake = fakeCommand({ output: 'ACP_LIVE_OK\n', exitCode: 0 })
    const service = new TerminalService({ spawn: () => fake.command })

    const created = await service.create({ command: 'echo ACP_LIVE_OK' })
    expect(Object.keys(created)).toEqual(['terminalId'])
  })

  it('does not block on a command that is still running', async () => {
    let finish: (() => void) | undefined
    const exited = new Promise<number>(resolve => { finish = () => resolve(0) })
    const service = new TerminalService({
      spawn: () => ({ output: () => '', exited, kill: () => {} }),
    })
    // Would hang if create awaited the process.
    await expect(service.create({ command: 'sleep 60' })).resolves.toHaveProperty('terminalId')
    finish?.()
  })

  it('answers wait_for_exit with the process exit code', async () => {
    const fake = fakeCommand({ exitCode: 3 })
    const service = new TerminalService({ spawn: () => fake.command })
    const created = await service.create({ command: 'false' })

    await expect(service.waitForExit(created.terminalId)).resolves.toEqual({ exitCode: 3, signal: null })
  })

  it('answers output with all three fields the protocol names, not just the text', async () => {
    // A command still running: no exit status yet, and the field is still sent.
    let finish: ((code: number) => void) | undefined
    const service = new TerminalService({
      spawn: () => ({
        output: () => 'partial',
        exited: new Promise<number>(resolve => { finish = resolve }),
        kill: () => {},
      }),
    })
    const created = await service.create({ command: 'sleep 5' })

    await expect(service.output(created.terminalId)).resolves.toEqual({
      output: 'partial',
      exitStatus: null,
      truncated: false,
    })
    finish?.(0)
  })

  it('reports the exit status once the command has finished', async () => {
    const fake = fakeCommand({ output: 'done', exitCode: 0 })
    const service = new TerminalService({ spawn: () => fake.command })
    const created = await service.create({ command: 'echo done' })
    await service.waitForExit(created.terminalId)

    await expect(service.output(created.terminalId)).resolves.toMatchObject({
      exitStatus: { exitCode: 0, signal: null },
    })
  })

  it('kills a running command', async () => {
    const fake = fakeCommand({})
    const service = new TerminalService({ spawn: () => fake.command })
    const created = await service.create({ command: 'sleep 100' })

    await service.kill(created.terminalId)
    expect(fake.killed()).toBe(true)
  })

  it('forgets a released terminal', async () => {
    const fake = fakeCommand({})
    const service = new TerminalService({ spawn: () => fake.command })
    const created = await service.create({ command: 'echo hi' })

    await service.release(created.terminalId)
    await expect(service.output(created.terminalId)).rejects.toThrow(/unknown terminal/)
  })

  it('rejects rather than reporting success for a terminal it never made', async () => {
    const service = new TerminalService({ spawn: () => fakeCommand().command })
    await expect(service.waitForExit('nope')).rejects.toThrow(/unknown terminal/)
    await expect(service.kill('nope')).rejects.toThrow(/unknown terminal/)
  })

  it('waits for the process to finish before reporting its exit code', async () => {
    // The exit code is only meaningful after the process has ended; reading it
    // eagerly would report success for a command that later fails.
    let resolveExit: ((code: number) => void) | undefined
    const exited = new Promise<number>(resolve => { resolveExit = resolve })
    const service = new TerminalService({
      spawn: () => ({ output: () => '', exited, kill: () => {} }),
    })
    const created = await service.create({ command: 'sleep 1' })

    let settled = false
    const waiting = service.waitForExit(created.terminalId).then(result => { settled = true; return result })
    await Promise.resolve()
    expect(settled).toBe(false)

    resolveExit?.(7)
    await expect(waiting).resolves.toEqual({ exitCode: 7, signal: null })
  })
})