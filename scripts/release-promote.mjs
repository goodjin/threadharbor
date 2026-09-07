#!/usr/bin/env node

/**
 * Drive a release end-to-end:
 *
 *   release-promote.mjs candidate [--version <ver>]
 *       npm run build -> createCandidate -> return release path
 *
 *   release-promote.mjs promote --channel <stable|test> [--version <ver>] [--allow-dirty]
 *       stopChannel -> promoteRelease -> startChannel -> waitForHealth.
 *         On any failure past promoteRelease, rollbackRelease + startChannel
 *         from the previous release so DSH Web is never left down.
 *
 *   release-promote.mjs status --channel <stable|test>
 *       Echo channel pid, port, healthy flag, and stable-current basename.
 *
 * The promote step is atomic from the user's perspective: either DSH Web
 * is serving the new release, or DSH Web is still serving the previous
 * one. We never leave the channel stopped unless recovery itself fails,
 * in which case the script prints the exact manual recovery steps.
 *
 * Side effects are isolated behind `defaultDeps` so unit tests can swap
 * in fakes without spawning a real DSH process.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  channelStatus as rawChannelStatus,
  channelConfig,
  channelHome,
  createCandidate as rawCreateCandidate,
  promoteRelease as rawPromoteRelease,
  releaseRoot,
  rollbackRelease as rawRollbackRelease,
  startChannel as rawStartChannel,
  stopChannel as rawStopChannel,
  verifyRelease,
} from './release-channel.mjs'

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function fail(message) {
  process.stderr.write(`Error: ${message}\n`)
  process.exitCode = 1
  throw new Error(message)
}

export function parseArgs(argv) {
  const [command, ...rest] = argv
  if (command === undefined) fail('usage: release-promote.mjs <candidate|promote|status> [options]')
  const options = {}
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]
    if (!token.startsWith('--')) fail(`unexpected argument: ${token}`)
    const key = token.slice(2)
    if (key === 'allow-dirty') {
      options[key] = true
      continue
    }
    if (rest[index + 1] === undefined || rest[index + 1].startsWith('--')) {
      fail(`missing value for --${key}`)
    }
    options[key] = rest[index + 1]
    index += 1
  }
  return { command, options }
}

export function runNpmBuild({ cwd = workspaceRoot } = {}) {
  const result = spawnSync('npm', ['run', 'build'], {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, CI: 'true' },
    encoding: 'utf8',
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) fail(`npm run build exited with status ${result.status}`)
}

export function safeVersionToken(date = new Date(), { releaseRootDir = join(homedir(), '.local', 'share', 'threadharbor', 'releases') } = {}) {
  const yyyy = date.getUTCFullYear()
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(date.getUTCDate()).padStart(2, '0')
  const stamp = `${yyyy}${mm}${dd}`
  let n = 0
  if (existsSync(releaseRootDir)) {
    const seen = new Set()
    for (const name of readdirSync(releaseRootDir)) {
      if (name.startsWith(`0.1.0-local.${stamp}.`)) {
        const tail = name.slice(`0.1.0-local.${stamp}.`.length)
        const number = Number(tail)
        if (Number.isSafeInteger(number)) seen.add(number)
      }
    }
    n = seen.size === 0 ? 0 : Math.max(...seen) + 1
  }
  return `0.1.0-local.${stamp}.${n}`
}

export function readCurrentRelease(options) {
  const base = resolve(releaseRoot(options))
  const pointer = join(base, 'stable-current')
  if (!existsSync(pointer)) return undefined
  let relative
  try {
    relative = readlinkSync(pointer)
  } catch {
    return undefined
  }
  const target = resolve(base, relative)
  if (!existsSync(target)) return undefined
  return verifyRelease(target).root
}

/**
 * Latest candidate that is not currently stable-current. Used when the
 * operator runs `release:promote` right after `release:candidate` and wants
 * to skip typing `--version` again.
 */
export function readLatestCandidate(options) {
  const base = resolve(releaseRoot(options))
  const releases = join(base, 'releases')
  if (!existsSync(releases)) return undefined
  const current = readCurrentRelease(options)
  const currentBasename = current === undefined ? null : basename(current)
  let latest
  for (const name of readdirSync(releases)) {
    if (name === currentBasename) continue
    const manifest = join(releases, name, 'threadharbor-release.json')
    if (!existsSync(manifest)) continue
    if (latest === undefined || name.localeCompare(latest) > 0) latest = name
  }
  return latest
}

export function resolveChannel(channelArg) {
  if (channelArg === undefined) fail('--channel <stable|test> is required')
  channelConfig(channelArg)
  return channelArg
}

export const defaultDeps = {
  createCandidate: rawCreateCandidate,
  promoteRelease: rawPromoteRelease,
  rollbackRelease: rawRollbackRelease,
  stopChannel: rawStopChannel,
  startChannel: rawStartChannel,
  channelStatus: rawChannelStatus,
  runNpmBuild,
  safeVersionToken,
  readCurrentRelease,
  readLatestCandidate,
}

/**
 * Pure orchestration. Order:
 *   1. stopChannel(channel)
 *   2. promoteRelease(version)
 *   3. startChannel(channel)
 * On start failure past promote:
 *   a. If there is a previous release, rollbackRelease + startChannel.
 *      Surface a clear error that the new release was rolled back.
 *   b. If there is no previous release, fail without rollback, instructing
 *      the operator to restore manually.
 * @param {object} input
 * @param {string} input.channel
 * @param {object} input.options - forwarded to release-channel.mjs helpers
 * @param {object} [input.deps] - overrides for tests
 */
export function withDshCommand(options) {
  if (options['dsh-command'] !== undefined) return options
  if (process.env['THREADHARBOR_DSH_COMMAND'] === undefined) return options
  return { ...options, 'dsh-command': process.env['THREADHARBOR_DSH_COMMAND'] }
}

export async function promote({ channel, options, deps = defaultDeps }) {
  const root = releaseRoot(options)
  const home = channelHome(channel, options)
  const allowDirty = options['allow-dirty'] === true

  if (!existsSync(home)) {
    fail(`channel home does not exist: ${home}. Run 'release-channel.mjs bootstrap --channel ${channel}' first.`)
  }
  let version = options.version
  if (version === undefined || version === 'latest') {
    const latest = deps.readLatestCandidate(options)
    if (latest === undefined) {
      fail('no candidate release is available. Run `npm run release:candidate` first, or pass `--version <release>`.')
    }
    version = latest
    process.stderr.write(`promoting latest candidate: ${version}\n`)
  }

  let promoteResult
  try {
    promoteResult = deps.promoteRelease({
      version,
      root,
      stableHome: home,
      allowDirty,
    })
  } catch (error) {
    fail(`promote failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  process.stderr.write(`promoted: ${basename(promoteResult.release)} (previous: ${promoteResult.previous === undefined ? 'none' : basename(promoteResult.previous)})\n`)

  const startOptions = withDshCommand(options)
  try {
    await deps.stopChannel(channel, startOptions)
  } catch (error) {
    fail(`could not stop existing DSH Web on ${channel}: ${error instanceof Error ? error.message : String(error)}.\nManual recovery: run 'release-channel.mjs rollback --channel ${channel}' then 'release-channel.mjs start --channel ${channel}'.`)
  }

  try {
    await deps.startChannel(channel, startOptions)
  } catch (startError) {
    process.stderr.write(`start after promote failed: ${startError instanceof Error ? startError.message : String(startError)}\n`)
    if (promoteResult.previous !== undefined) {
      let rollbackError
      try {
        deps.rollbackRelease({ root, stableHome: home })
        await deps.startChannel(channel, startOptions)
      } catch (error) {
        rollbackError = error
      }
      if (rollbackError === undefined) {
        fail(`start failed; rolled back to ${basename(promoteResult.previous)} and restored DSH Web. Inspect 'release-channel.mjs status --channel ${channel}' and try again.`)
      }
      process.stderr.write(`rollback also failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}\n`)
    } else {
      process.stderr.write('no previous release to roll back to\n')
    }
    fail(`start failed and rollback could not restore DSH Web. Manual recovery:\n  1. Inspect ${home}/threadharbor-runtime/web.log\n  2. 'release-channel.mjs rollback --channel ${channel}'\n  3. 'release-channel.mjs start --channel ${channel}'`)
  }

  return {
    channel,
    current: basename(promoteResult.release),
    previous: promoteResult.previous === undefined ? null : basename(promoteResult.previous),
    home,
  }
}

export function candidate({ options, deps = defaultDeps }) {
  deps.runNpmBuild()
  const version = options.version ?? deps.safeVersionToken()
  const root = releaseRoot(options)
  let release
  try {
    release = deps.createCandidate({ version, root })
  } catch (error) {
    fail(`createCandidate failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { release, version }
}

export async function status({ channel, options, deps = defaultDeps }) {
  const startOptions = withDshCommand(options)
  const statusResult = await deps.channelStatus(channel, startOptions)
  const current = deps.readCurrentRelease(options)
  return {
    ...statusResult,
    stableCurrent: current === undefined ? null : basename(current),
  }
}

export async function main(argv = process.argv.slice(2), deps = defaultDeps) {
  const { command, options } = parseArgs(argv)
  let result
  switch (command) {
    case 'candidate':
      result = candidate({ options, deps })
      break
    case 'promote': {
      const channel = resolveChannel(options.channel)
      result = await promote({ channel, options, deps })
      break
    }
    case 'status': {
      const channel = resolveChannel(options.channel)
      result = await status({ channel, options, deps })
      break
    }
    default: fail(`unknown command: ${command}`)
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    if (process.exitCode !== 1) {
      process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    }
  })
}
