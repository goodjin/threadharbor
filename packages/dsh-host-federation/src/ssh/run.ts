/** Spawn helpers for OpenSSH CLI tools. */

import { spawn } from 'node:child_process'

export type RunResult = {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export function run(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  stdin?: string | Buffer,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RunResult> {
  return runWithEnv(command, args, timeoutMs, env, stdin)
}

export function runWithEnv(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  stdin?: string | Buffer,
): Promise<RunResult> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'], env })
    let stdout = ''
    let stderr = ''
    let stdinError: Error | undefined
    child.stdout.on('data', (chunk: Buffer) => { stdout = `${stdout}${chunk.toString('utf8')}`.slice(-65_536) })
    child.stderr.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-65_536) })
    child.stdin.once('error', (error) => { stdinError = error })
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      rejectRun(error)
    }
    child.once('error', (error) => { fail(error) })
    timer = setTimeout(() => {
      child.kill('SIGTERM')
      const hardKill = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, 2_000)
      hardKill.unref()
      fail(new Error(`${command} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.once('exit', (code) => {
      if (timer !== undefined) clearTimeout(timer)
      if (settled) return
      if ((code ?? 1) === 0 && stdinError !== undefined) {
        fail(stdinError)
        return
      }
      settled = true
      resolveRun({ code: code ?? 1, stdout, stderr })
    })
    try {
      if (stdin !== undefined) child.stdin.end(stdin)
      else child.stdin.end()
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)))
    }
  })
}
