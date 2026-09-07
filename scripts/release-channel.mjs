#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { createServer } from 'node:net'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifestName = 'threadharbor-release.json'
const channels = {
  stable: { port: 3080, defaultHome: join(homedir(), '.dsh-threadharbor-stable') },
  test: { port: 3081, defaultHome: join(homedir(), '.dsh-threadharbor-test') },
}

function fail(message) {
  throw new Error(message)
}

function parseArgs(argv) {
  const [command, ...rest] = argv
  if (command === undefined) fail('usage: release-channel.mjs <candidate|verify|promote|rollback|bootstrap|start|stop|status> [options]')
  const options = {}
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]
    if (!token.startsWith('--')) fail(`unexpected argument: ${token}`)
    const key = token.slice(2)
    if (['restore-data', 'skip-check', 'allow-dirty'].includes(key)) {
      options[key] = true
      continue
    }
    const value = rest[index + 1]
    if (value === undefined || value.startsWith('--')) fail(`missing value for --${key}`)
    options[key] = value
    index += 1
  }
  return { command, options }
}

function safeVersion(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
    fail('version must use 1-64 letters, digits, dots, underscores, or hyphens')
  }
  return value
}

export function channelConfig(value) {
  if (value !== 'stable' && value !== 'test') fail('channel must be stable or test')
  return channels[value]
}

export function releaseRoot(options) {
  return resolve(options.root ?? process.env['THREADHARBOR_RELEASE_ROOT'] ?? join(homedir(), '.local', 'share', 'threadharbor'))
}

export function channelHome(channel, options) {
  const configured = options.home ?? process.env[`THREADHARBOR_${channel.toUpperCase()}_HOME`]
  return resolve(configured ?? channelConfig(channel).defaultHome)
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? workspaceRoot,
    env: { ...process.env, CI: 'true', ...options.env },
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    const detail = options.capture ? `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() : ''
    fail(`${command} exited with status ${result.status}${detail === '' ? '' : `: ${detail}`}`)
  }
  return options.capture ? String(result.stdout ?? '').trim() : ''
}

function walk(root, prefix = '') {
  const entries = []
  const directory = prefix === '' ? root : join(root, ...prefix.split('/'))
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name)
    const relativePath = prefix === '' ? name : `${prefix}/${name}`
    if (relativePath === manifestName) continue
    const stats = lstatSync(path)
    if (stats.isDirectory()) entries.push(...walk(root, relativePath))
    else if (stats.isFile()) {
      entries.push({
        path: relativePath,
        type: 'file',
        bytes: stats.size,
        sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
      })
    } else if (stats.isSymbolicLink()) {
      const target = readlinkSync(path)
      entries.push({
        path: relativePath,
        type: 'symlink',
        bytes: Buffer.byteLength(target),
        sha256: createHash('sha256').update(target).digest('hex'),
      })
    } else fail(`release contains unsupported entry: ${relativePath}`)
  }
  return entries
}

function gitMetadata() {
  const revision = runChecked('git', ['rev-parse', 'HEAD'], { capture: true })
  const dirty = runChecked('git', ['status', '--porcelain=v1'], { capture: true }) !== ''
  return { revision, dirty }
}

export function verifyRelease(directory) {
  const root = realpathSync(resolve(directory))
  const manifestPath = join(root, manifestName)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.entries)) fail('invalid release manifest')
  const actual = walk(root)
  if (JSON.stringify(actual) !== JSON.stringify(manifest.entries)) fail(`release checksum verification failed: ${root}`)
  return { root, manifest }
}

export function detachHardlinks(root) {
  for (const entry of walk(root)) {
    if (entry.type !== 'file') continue
    const path = join(root, ...entry.path.split('/'))
    const stats = lstatSync(path)
    if (stats.nlink < 2) continue
    const temporary = join(dirname(path), `.${basename(path)}.detached-${randomUUID()}`)
    copyFileSync(path, temporary)
    chmodSync(temporary, stats.mode & 0o777)
    renameSync(temporary, path)
  }
}

export function createCandidate({ version, root, artifactSource, skipCheck = false }) {
  const safe = safeVersion(version)
  const base = resolve(root)
  const releases = join(base, 'releases')
  const target = join(releases, safe)
  if (existsSync(target)) fail(`release already exists: ${target}`)
  mkdirSync(releases, { recursive: true, mode: 0o755 })
  const staging = join(releases, `.${safe}.staging-${randomUUID()}`)
  try {
    if (!skipCheck) runChecked('npm', ['run', 'check'])
    if (artifactSource !== undefined) {
      cpSync(resolve(artifactSource), staging, { recursive: true, verbatimSymlinks: true })
    } else {
      runChecked('pnpm', ['--filter', 'threadharbor', 'deploy', '--legacy', '--prod', staging])
    }
    detachHardlinks(staging)
    const source = gitMetadata()
    const manifest = {
      schemaVersion: 1,
      version: safe,
      createdAt: new Date().toISOString(),
      source,
      entries: walk(staging),
    }
    writeFileSync(join(staging, manifestName), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o444, flag: 'wx' })
    verifyRelease(staging)
    renameSync(staging, target)
    return realpathSync(target)
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
}

function safePointerTarget(base, pointer) {
  const path = join(base, pointer)
  if (!existsSync(path)) return undefined
  const target = realpathSync(path)
  const releases = realpathSync(join(base, 'releases'))
  if (target !== releases && !target.startsWith(`${releases}${sep}`)) fail(`${pointer} points outside the release root`)
  return target
}

function replaceSymlink(path, target) {
  const temporary = `${path}.next-${randomUUID()}`
  symlinkSync(target, temporary)
  renameSync(temporary, path)
}

const snapshotEntries = ['storages', 'sessions', 'threadharbor', '.credentials.yaml', '.agent-presets']

function snapshotData(home, backup) {
  mkdirSync(backup, { recursive: true, mode: 0o700 })
  for (const name of snapshotEntries) {
    const source = join(home, name)
    if (existsSync(source)) cpSync(source, join(backup, name), { recursive: true, verbatimSymlinks: true })
  }
}

export function promoteRelease({ version, root, stableHome, allowDirty = false }) {
  const base = realpathSync(resolve(root))
  const release = verifyRelease(join(base, 'releases', safeVersion(version))).root
  const releaseManifest = JSON.parse(readFileSync(join(release, manifestName), 'utf8'))
  if (releaseManifest.source?.dirty === true && !allowDirty) {
    fail(`release ${basename(release)} was built from a dirty working tree; pass --allow-dirty to promote or rebuild from a clean commit`)
  }
  const current = safePointerTarget(base, 'stable-current')
  let verifiedCurrent
  let rejectedCurrent
  if (current !== undefined) {
    try {
      verifiedCurrent = verifyRelease(current).root
    } catch {
      rejectedCurrent = current
    }
  }
  const timestamp = new Date().toISOString().replaceAll(':', '').replaceAll('.', '-')
  let backup
  if (existsSync(stableHome)) {
    backup = join(base, 'backups', timestamp)
    snapshotData(stableHome, backup)
  }
  if (verifiedCurrent !== undefined && verifiedCurrent !== release) {
    replaceSymlink(join(base, 'stable-previous'), relative(base, verifiedCurrent))
  }
  replaceSymlink(join(base, 'stable-current'), relative(base, release))
  writeFileSync(join(base, 'stable-state.json'), `${JSON.stringify({
    schemaVersion: 1,
    current: basename(release),
    previous: verifiedCurrent === undefined ? null : basename(verifiedCurrent),
    rejectedCurrent: rejectedCurrent === undefined ? null : basename(rejectedCurrent),
    backup: backup ?? null,
    promotedAt: new Date().toISOString(),
  }, null, 2)}\n`)
  return { release, previous: verifiedCurrent, rejectedCurrent, backup }
}

export function rollbackRelease({ root, stableHome, restoreData = false }) {
  const base = realpathSync(resolve(root))
  const current = safePointerTarget(base, 'stable-current')
  const previous = safePointerTarget(base, 'stable-previous')
  if (current === undefined || previous === undefined) fail('rollback requires both stable-current and stable-previous')
  verifyRelease(previous)
  replaceSymlink(join(base, 'stable-current'), relative(base, previous))
  replaceSymlink(join(base, 'stable-previous'), relative(base, current))
  const statePath = join(base, 'stable-state.json')
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {}
  if (restoreData) {
    if (typeof state.backup !== 'string' || !existsSync(state.backup)) fail('no stable data backup is available')
    const failed = join(base, 'backups', `failed-${new Date().toISOString().replaceAll(':', '').replaceAll('.', '-')}`)
    if (existsSync(stableHome)) renameSync(stableHome, failed)
    cpSync(state.backup, stableHome, { recursive: true, verbatimSymlinks: true })
  }
  writeFileSync(statePath, `${JSON.stringify({
    ...state,
    current: basename(previous),
    previous: basename(current),
    rolledBackAt: new Date().toISOString(),
  }, null, 2)}\n`)
  return { release: previous, failedRelease: current }
}

function pluginTarget(channel, options) {
  if (channel === 'test') return resolve(options.workspace ?? workspaceRoot)
  const current = safePointerTarget(realpathSync(releaseRoot(options)), 'stable-current')
  if (current === undefined) fail('stable-current is not set; create and promote a candidate first')
  verifyRelease(current)
  return current
}

function replaceDirSymlink(path, target) {
  rmSync(path, { recursive: true, force: true })
  mkdirSync(dirname(path), { recursive: true })
  symlinkSync(target, path, 'dir')
}

function configureProfile(home, target) {
  const profile = join(home, 'profiles', 'web')
  const packagePath = join(profile, 'package.json')
  if (!existsSync(packagePath)) fail(`DSH web profile is missing: ${packagePath}`)
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
  pkg.dependencies ??= {}
  pkg.dependencies.threadharbor = `link:${target}`
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`)
  const modules = join(profile, 'node_modules')
  mkdirSync(modules, { recursive: true })
  replaceDirSymlink(join(modules, 'threadharbor'), target)
  const releasedScoped = join(target, 'node_modules', '@threadharbor')
  const profileScoped = join(modules, '@threadharbor')
  if (!existsSync(releasedScoped)) return
  mkdirSync(profileScoped, { recursive: true })
  const released = new Set(readdirSync(releasedScoped))
  for (const name of readdirSync(profileScoped)) {
    if (!released.has(name)) rmSync(join(profileScoped, name), { recursive: true, force: true })
  }
  for (const name of released) {
    replaceDirSymlink(join(profileScoped, name), realpathSync(join(releasedScoped, name)))
  }
}

function isolateProfileOverrides(home) {
  const profile = join(home, 'profiles', 'web')
  const patch = join(profile, 'cordis.patch.yml')
  const imported = join(profile, 'cordis.patch.imported.yml')
  if (existsSync(patch) && !existsSync(imported)) cpSync(patch, imported)
  writeFileSync(patch, '[]\n')
}

export function bootstrapChannel({ channel, home, sourceHome, root, workspace }) {
  channelConfig(channel)
  const destination = resolve(home)
  if (!existsSync(destination)) {
    if (!existsSync(sourceHome)) fail(`source DSH_HOME does not exist: ${sourceHome}`)
    cpSync(resolve(sourceHome), destination, { recursive: true, verbatimSymlinks: true })
  }
  const options = { root, workspace }
  isolateProfileOverrides(destination)
  configureProfile(destination, pluginTarget(channel, options))
  return destination
}

function pidPath(home) {
  return join(home, 'threadharbor-runtime', 'web.pid')
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readPid(home) {
  const path = pidPath(home)
  if (!existsSync(path)) return undefined
  const pid = Number(readFileSync(path, 'utf8').trim())
  return processAlive(pid) ? pid : undefined
}

export async function loopbackPortAvailable(port) {
  return await new Promise(resolveAvailable => {
    const server = createServer()
    server.once('error', () => resolveAvailable(false))
    server.listen(port, '127.0.0.1', () => {
      server.close(error => resolveAvailable(error === undefined))
    })
  })
}

function resolveDshCommand(options) {
  const configured = options['dsh-command'] ?? process.env['THREADHARBOR_DSH_COMMAND']
  if (configured !== undefined) return resolve(configured)
  const probe = spawnSync('command', ['-v', 'dsh'], { shell: true, encoding: 'utf8' })
  const found = String(probe.stdout ?? '').trim()
  if (probe.status === 0 && found !== '') return found
  fail('dsh command was not found; pass --dsh-command or set THREADHARBOR_DSH_COMMAND')
}

async function waitForHealth(port, pid, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let lastError = 'not ready'
  while (Date.now() < deadline) {
    if (!processAlive(pid)) fail(`DSH Web exited before port ${port} became healthy`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`)
      if (response.ok) return
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 250))
  }
  fail(`DSH Web on port ${port} did not become healthy: ${lastError}`)
}

export async function startChannel(channel, options) {
  const config = channelConfig(channel)
  const home = channelHome(channel, options)
  const existing = readPid(home)
  if (existing !== undefined) fail(`${channel} is already running with pid ${existing}`)
  if (!await loopbackPortAvailable(config.port)) {
    fail(`port ${config.port} is already in use by a process not tracked by the ${channel} channel`)
  }
  configureProfile(home, pluginTarget(channel, options))
  const target = pluginTarget(channel, options)
  const patch = join(target, 'deploy', 'channels', `${channel}.patch.yml`)
  if (!existsSync(patch)) fail(`channel patch is missing: ${patch}`)
  const runtime = join(home, 'threadharbor-runtime')
  mkdirSync(runtime, { recursive: true, mode: 0o700 })
  const logPath = join(runtime, 'web.log')
  const log = openSync(logPath, 'a', 0o600)
  const dsh = resolveDshCommand(options)
  const child = spawn(dsh, ['--profile', 'web', '--patch', patch, '--no-open', '--port', String(config.port)], {
    cwd: target,
    env: { ...process.env, DSH_HOME: home },
    detached: true,
    stdio: ['ignore', log, log],
  })
  child.unref()
  closeSync(log)
  writeFileSync(pidPath(home), `${child.pid}\n`, { mode: 0o600 })
  await waitForHealth(config.port, child.pid)
  return { channel, home, port: config.port, pid: child.pid, target, logPath }
}

export async function stopChannel(channel, options) {
  const home = channelHome(channel, options)
  const pid = readPid(home)
  if (pid === undefined) return { channel, stopped: false }
  process.kill(pid, 'SIGTERM')
  const deadline = Date.now() + 10_000
  while (processAlive(pid) && Date.now() < deadline) {
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  if (processAlive(pid)) fail(`${channel} process ${pid} did not stop after SIGTERM`)
  rmSync(pidPath(home), { force: true })
  return { channel, stopped: true, pid }
}

export async function channelStatus(channel, options) {
  const config = channelConfig(channel)
  const home = channelHome(channel, options)
  const pid = readPid(home)
  let healthy = false
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/`)
    healthy = response.ok
  } catch {
    healthy = false
  }
  return { channel, home, port: config.port, pid: pid ?? null, healthy }
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2))
  const root = releaseRoot(options)
  let result
  switch (command) {
    case 'candidate':
      result = { release: createCandidate({
        version: options.version,
        root,
        artifactSource: options['artifact-source'],
        skipCheck: options['skip-check'] === true,
      }) }
      break
    case 'verify': {
      const directory = options.release ?? join(root, 'releases', safeVersion(options.version))
      const verified = verifyRelease(directory)
      result = {
        root: verified.root,
        version: verified.manifest.version,
        source: verified.manifest.source,
        files: verified.manifest.entries.length,
      }
      break
    }
    case 'promote':
      result = promoteRelease({
        version: options.version,
        root,
        stableHome: channelHome('stable', options),
        allowDirty: options['allow-dirty'] === true,
      })
      break
    case 'rollback':
      result = rollbackRelease({ root, stableHome: channelHome('stable', options), restoreData: options['restore-data'] === true })
      break
    case 'bootstrap': {
      const channel = options.channel
      result = { home: bootstrapChannel({
        channel,
        home: channelHome(channel, options),
        sourceHome: resolve(options['source-home'] ?? join(homedir(), '.dsh')),
        root,
        workspace: options.workspace,
      }) }
      break
    }
    case 'start': result = await startChannel(options.channel, options); break
    case 'stop': result = await stopChannel(options.channel, options); break
    case 'status': result = await channelStatus(options.channel, options); break
    default: fail(`unknown command: ${command}`)
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
