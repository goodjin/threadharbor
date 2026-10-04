#!/usr/bin/env node
/** Install, inspect or remove the ACP streaming patch in a DSH `acp` profile.
 *
 * hostd spawns its backend as `dsh --profile acp` with no extra flags, so the
 * patch has to live in that profile's own `cordis.patch.yml`.
 *
 * A patch entry cannot *rename* an entry — `name` in a patch is an assertion,
 * and a mismatch skips the patch. So the installer disables the stock `acp`
 * entry and inserts a replacement right after it, mirroring the stock entry's
 * `inject` and `config` (read back from `dsh --profile acp --dump-config`, so a
 * DSH upgrade cannot silently desync them). The original patch file is kept as
 * a `.th-acp-stream.bak` sibling and restored verbatim on uninstall.
 *
 * Usage:
 *   node deploy/acp-stream/install.mjs               # install into $DSH_HOME
 *   node deploy/acp-stream/install.mjs --check       # report what is installed
 *   node deploy/acp-stream/install.mjs --uninstall   # restore the stock entry
 *   DSH_HOME=/path/to/home DSH_BIN=/path/to/dsh node deploy/acp-stream/install.mjs
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const BLOCK_BEGIN = '# >>> threadharbor acp-stream (managed) >>>'
export const BLOCK_END = '# <<< threadharbor acp-stream <<<'
export const BACKUP_SUFFIX = '.th-acp-stream.bak'
export const PATCHED_ENTRY_ID = 'acp-stream'
export const MODULES = [
  'stream-pacer.mjs',
  'live-stream.mjs',
  'acp-source-transform.mjs',
  'acp-stream-entry.mjs',
]

const SOURCE_DIR = dirname(fileURLToPath(import.meta.url))
const STOCK_ENTRY_ID = 'acp'

/** Remove any managed block, returning the remaining text. */
export function stripManagedBlock(source) {
  const begin = source.indexOf(BLOCK_BEGIN)
  if (begin === -1) return source
  const end = source.indexOf(BLOCK_END, begin)
  if (end === -1) return source.slice(0, begin)
  const after = source.indexOf('\n', end)
  return `${source.slice(0, begin)}${after === -1 ? '' : source.slice(after + 1)}`
}

/** Parse one dumped scalar: the dump quotes with YAML single quotes or JSON. */
export function parseScalar(raw) {
  const value = (raw ?? '').trim()
  if (value.startsWith('"')) return JSON.parse(value)
  if (value.startsWith("'")) return value.slice(1, -1).replace(/''/g, "'")
  return value
}

/**
 * Read one flat entry out of `dsh --dump-config` output.
 *
 * The dump is machine generated and flat, so this deliberately understands only
 * the keys this installer needs and throws on anything else rather than
 * guessing at a value that would end up in a profile file. Long values (a
 * module path, for one) come back as YAML folded scalars across two lines.
 */
export function readEntry(dump, id) {
  const lines = dump.split('\n')
  const start = lines.findIndex((line) => line === `- id: ${id}`)
  if (start === -1) throw new Error(`entry ${id} is not in the dump`)
  const body = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.startsWith('- id: ') || line.startsWith('# == ')) break
    body.push(line)
  }
  const entry = { id, name: undefined, inject: [], config: {} }
  const TOP_LEVEL = new Set(['name', 'inject', 'config', 'disabled', 'group'])
  let section
  for (let index = 0; index < body.length; index += 1) {
    const line = body[index]
    const top = /^ {2}([a-zA-Z]+):(?: (.*))?$/.exec(line)
    const item = /^ {4}- (.+)$/.exec(line)
    const leaf = /^ {4}([a-zA-Z]+):(?: (.*))?$/.exec(line)
    if (top) {
      if (!TOP_LEVEL.has(top[1])) throw new Error(`unrecognised dump key for ${id}: ${top[1]}`)
      section = top[1]
      const raw = top[2]
      if (section === 'name') {
        if (raw === '>-' || raw === '>' || raw === '|-' || raw === '|') {
          const parts = []
          while (index + 1 < body.length && /^ {4}\S/.test(body[index + 1])) {
            parts.push(body[index + 1].trim())
            index += 1
          }
          entry.name = parts.join(' ')
        } else entry.name = parseScalar(raw)
      } else if (section === 'config' && (raw ?? '') !== '') {
        throw new Error(`inline config for ${id} is unsupported`)
      }
      continue
    }
    if (item && section === 'inject') { entry.inject.push(parseScalar(item[1])); continue }
    if (leaf && section === 'config') { entry.config[leaf[1]] = parseScalar(leaf[2]); continue }
    if (line.trim() === '') continue
    throw new Error(`unrecognised dump line for ${id}: ${line}`)
  }
  return entry
}

function yamlScalar(value) {
  return JSON.stringify(value)
}

/** Build the managed block that disables the stock entry and inserts ours. */
export function managedBlock(stock, entryPath) {
  const inject = stock.inject.length > 0 ? `\n      inject: [${stock.inject.join(', ')}]` : ''
  const config = Object.keys(stock.config).length === 0
    ? ''
    : `\n      config:${Object.entries(stock.config)
      .map(([key, value]) => `\n        ${key}: ${yamlScalar(value)}`)
      .join('')}`
  return [
    BLOCK_BEGIN,
    '# The stock bridge emits one committed assistant message as a single frame,',
    '# so a long reasoning block reaches the client only after the whole thing is',
    '# generated. This entry loads the same bridge with that one call routed',
    '# through a paced slicer; the shim refuses to load a stale or unpatchable copy.',
    `- id: ${STOCK_ENTRY_ID}`,
    '  disabled: true',
    '',
    '- insert:',
    `    - id: ${PATCHED_ENTRY_ID}`,
    `      name: ${yamlScalar(entryPath)}${inject}${config}`,
    BLOCK_END,
    '',
  ].join('\n')
}

/**
 * Append the managed block to an existing patch file.
 *
 * A fresh profile ships a comment header followed by a bare `[]`; leaving that
 * `[]` in place would make the file one list followed by another, which the
 * overlay parser rejects.
 */
export function withManagedBlock(current, block) {
  const kept = stripManagedBlock(current)
  const lines = kept.split('\n')
  const hasEntries = lines.some((line) => {
    const trimmed = line.trim()
    return trimmed !== '' && trimmed !== '[]' && !trimmed.startsWith('#')
  })
  // Drop a bare `[]` (a list followed by another list does not parse) but keep
  // the profile's own header comments, which document the file we are editing.
  const prefix = hasEntries
    ? `${kept.replace(/\s+$/, '')}\n`
    : lines.filter((line) => line.trim().startsWith('#')).join('\n') + '\n'
  return `${prefix}${block}`
}

function fail(message) {
  process.stderr.write(`threadharbor-acp-stream install: ${message}\n`)
  process.exit(1)
}

function dshHome(env = process.env) {
  const configured = env.DSH_HOME
  if (configured !== undefined && configured !== '') return resolve(configured)
  return join(homedir(), '.dsh')
}

function profileDir(home) {
  return join(home, 'profiles', 'acp')
}

function dumpConfig(home, bin) {
  try {
    return execFileSync(bin, ['--profile', 'acp', '--dump-config'], {
      env: { ...process.env, DSH_HOME: home },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 32 * 1024 * 1024,
    })
  } catch (error) {
    fail(`could not read the resolved profile from ${bin} (${String(error).slice(0, 200)})`)
    return ''
  }
}

function install(home, bin, log = process.stdout.write.bind(process.stdout)) {
  const profile = profileDir(home)
  if (!existsSync(profile)) fail(`no acp profile at ${profile}; run dsh once to create it`)

  const stock = readEntry(dumpConfig(home, bin), STOCK_ENTRY_ID)
  if (stock.name !== '@deepseek-ai/dsh-acp') {
    fail(`stock entry ${STOCK_ENTRY_ID} is ${stock.name}, not @deepseek-ai/dsh-acp; refusing to patch it`)
  }

  const target = join(profile, 'threadharbor-acp-stream')
  mkdirSync(target, { recursive: true })
  for (const module of MODULES) copyFileSync(join(SOURCE_DIR, module), join(target, module))
  const entry = join(target, 'acp-stream-entry.mjs')
  if (!existsSync(entry)) fail(`copy of acp-stream-entry.mjs missing at ${entry}`)

  const patchFile = join(profile, 'cordis.patch.yml')
  const backupFile = `${patchFile}${BACKUP_SUFFIX}`
  const current = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : '[]\n'
  if (!existsSync(backupFile)) writeFileSync(backupFile, current)
  // The overlay loader resolves a relative entry name beside the patch file and
  // turns it into a file URL, so the profile stays movable between DSH homes.
  writeFileSync(patchFile, withManagedBlock(current, managedBlock(stock, './threadharbor-acp-stream/acp-stream-entry.mjs')))
  log(`threadharbor-acp-stream install: ${profile}\n`)
  log(`  disabled: ${STOCK_ENTRY_ID} (${stock.name})\n`)
  log(`  inserted: ${PATCHED_ENTRY_ID} -> ${entry}\n`)
  log(`  mirrored: inject=[${stock.inject.join(', ')}] config=${JSON.stringify(stock.config)}\n`)
  log(`  backup:   ${backupFile}\n`)
}

function check(home, bin, log = process.stdout.write.bind(process.stdout)) {
  const profile = profileDir(home)
  const patchFile = join(profile, 'cordis.patch.yml')
  const patched = existsSync(patchFile) && readFileSync(patchFile, 'utf8').includes(BLOCK_BEGIN)
  log(`profile:   ${profile}\n`)
  log(`patched:   ${patched ? 'yes' : 'no'}\n`)
  if (!patched) return
  const entry = join(profile, 'threadharbor-acp-stream', 'acp-stream-entry.mjs')
  log(`entry:     ${existsSync(entry) ? entry : `MISSING ${entry}`}\n`)
  for (const module of MODULES) {
    const installed = join(profile, 'threadharbor-acp-stream', module)
    const source = join(SOURCE_DIR, module)
    const same = existsSync(installed) && existsSync(source)
      && readFileSync(installed, 'utf8') === readFileSync(source, 'utf8')
    log(`  ${same ? 'ok  ' : 'stale'} ${module}\n`)
  }
  const dump = dumpConfig(home, bin)
  const stock = readEntry(dump, STOCK_ENTRY_ID)
  log(`resolved:  ${STOCK_ENTRY_ID} name=${stock.name} (disabled=${dump.includes('disabled: true')})\n`)
  try {
    const mine = readEntry(dump, PATCHED_ENTRY_ID)
    log(`resolved:  ${PATCHED_ENTRY_ID} name=${mine.name} inject=[${mine.inject.join(', ')}] `
      + `config=${JSON.stringify(mine.config)}\n`)
  } catch {
    log(`resolved:  ${PATCHED_ENTRY_ID} NOT FOUND in the dump\n`)
  }
}

function uninstall(home, log = process.stdout.write.bind(process.stdout)) {
  const patchFile = join(profileDir(home), 'cordis.patch.yml')
  if (!existsSync(patchFile)) fail(`no acp profile patch at ${patchFile}`)
  const backupFile = `${patchFile}${BACKUP_SUFFIX}`
  if (existsSync(backupFile)) {
    copyFileSync(backupFile, patchFile)
    rmSync(backupFile)
    log(`threadharbor-acp-stream install: restored ${patchFile} from backup\n`)
    return
  }
  const current = readFileSync(patchFile, 'utf8')
  const kept = stripManagedBlock(current)
  if (kept === current) {
    log('threadharbor-acp-stream install: nothing to remove\n')
    return
  }
  writeFileSync(patchFile, kept.trim() === '' ? '[]\n' : kept)
  log(`threadharbor-acp-stream install: removed the managed block from ${patchFile}\n`)
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const home = dshHome()
  const bin = process.env.DSH_BIN ?? 'dsh'
  if (process.argv.includes('--uninstall')) uninstall(home)
  else if (process.argv.includes('--check')) check(home, bin)
  else install(home, bin)
}
