/**
 * The local MiniMax Code login, used as-is.
 *
 * MiniMax Code keeps its OAuth credential under `<dataDir>/auth/<buildEnv>/<region>/mcode-public/`
 * and refreshes it under a cross-process file lock. This module locates that
 * tree, hands it to the vendored official store, and returns a lease — the same
 * store, the same lock, the same refresh the desktop app and the CLI use. That
 * shared lock is the whole point: a refresh that lands here rewrites the same
 * `auth.json` they read, so neither side invalidates the other.
 *
 * Nothing is written here except by that official refresh path, and the token
 * never leaves this module's return value: no log line, no error message.
 */

import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  AuthRequiredError,
  createMCodeTokenProvider,
  resolveMCodeOAuthEndpointConfig,
} from './vendor/mcode-oauth/index.js'
import type { AuthBuildEnv, AuthRegion } from './vendor/mcode-oauth/contracts.js'
import { managedBaseUrl } from './vendor/mcode-runtime/endpoints.ts'

export type { AuthBuildEnv, AuthRegion }

const BUILD_ENVS: readonly AuthBuildEnv[] = ['prod', 'staging', 'test', 'dev']
const REGIONS: readonly AuthRegion[] = ['cn', 'en']

/** How long a token must still be good for before a request is allowed to use it. */
const DEFAULT_MIN_VALIDITY_MS = 60_000

export type DataDirOptions = {
  readonly env?: NodeJS.ProcessEnv
  readonly home?: string
}

export type CredentialOverrides = {
  readonly dataDir?: string
  readonly region?: AuthRegion
  readonly buildEnv?: AuthBuildEnv
  readonly env?: NodeJS.ProcessEnv
  readonly home?: string
  readonly fetchImpl?: typeof fetch
  readonly minValidityMs?: number
}

/** One usable access, and where it is good. */
export type MiniMaxCredential = {
  readonly accessToken: string
  readonly expiresAtMs: number
  readonly region: AuthRegion
  readonly buildEnv: AuthBuildEnv
  /** The managed Anthropic-compatible base; the region in the credential decides it. */
  readonly baseUrl: string
}

/**
 * Which directory holds the credential.
 *
 * Same order MiniMax Code uses: `MINIMAX_DATA_DIR`, then `MAVIS_DATA_DIR`, then
 * `~/.minimax`, and the pre-rename `~/.mavis` only when that is where the login
 * actually is. Deliberately one difference from upstream, which also migrates
 * between the two names: a chat host must not rename or move the user's MiniMax
 * directories, so the legacy tree is read where it lies and left alone.
 */
export async function resolveDataDir(options: DataDirOptions = {}): Promise<string> {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  for (const key of ['MINIMAX_DATA_DIR', 'MAVIS_DATA_DIR'] as const) {
    const configured = env[key]
    if (configured !== undefined && configured.trim() !== '') return configured.trim()
  }
  const primary = join(home, '.minimax')
  if (await holdsLogin(primary)) return primary
  const legacy = join(home, '.mavis')
  if (await holdsLogin(legacy)) return legacy
  return primary
}

/**
 * Which region and build environment the login on disk belongs to.
 *
 * Read off the credential's own path rather than configured: a `cn` login only
 * works against the `cn` gateway, and the wrong pairing is a stable 401 rather
 * than an error worth reading. `MAVIS_REGION` wins when it names a tree that
 * exists, so a machine with both can still choose.
 */
export async function detectNamespace(
  dataDir: string,
  options: { readonly env?: NodeJS.ProcessEnv } = {},
): Promise<{ region: AuthRegion; buildEnv: AuthBuildEnv }> {
  const env = options.env ?? process.env
  const found = await listLoggedInNamespaces(dataDir)
  const preferredRegion = env['MAVIS_REGION']
  const preferredBuild = env['MAVIS_BUILD_ENV']
  const region = REGIONS.find(candidate =>
    candidate === preferredRegion && found.some(found => found.region === candidate))
    ?? found.find(found => found.buildEnv === 'prod')?.region
    ?? found[0]?.region
  const buildEnv = BUILD_ENVS.find(candidate =>
    candidate === preferredBuild && found.some(found => found.buildEnv === candidate))
    ?? BUILD_ENVS.find(candidate => found.some(found => found.buildEnv === candidate))
  if (region === undefined || buildEnv === undefined) {
    throw notLoggedIn(dataDir)
  }
  return { region, buildEnv }
}

/** The access token the local login can use right now, refreshing it if it is stale. */
export async function resolveCredential(overrides: CredentialOverrides = {}): Promise<MiniMaxCredential> {
  const env = overrides.env ?? process.env
  const dataDir = overrides.dataDir ?? await resolveDataDir({ env, ...(overrides.home === undefined ? {} : { home: overrides.home }) })
  const detected = overrides.region === undefined || overrides.buildEnv === undefined
    ? await detectNamespace(dataDir, { env })
    : undefined
  const region = overrides.region ?? detected?.region
  const buildEnv = overrides.buildEnv ?? detected?.buildEnv
  if (region === undefined || buildEnv === undefined) throw notLoggedIn(dataDir)

  const provider = createMCodeTokenProvider({
    dataDir,
    region,
    buildEnv,
    endpoints: resolveMCodeOAuthEndpointConfig(env, { region, buildEnv }),
    ...(overrides.fetchImpl === undefined ? {} : { fetchImpl: overrides.fetchImpl }),
  })
  try {
    const lease = await provider.getAccessToken({
      minValidityMs: overrides.minValidityMs ?? DEFAULT_MIN_VALIDITY_MS,
    })
    return {
      accessToken: lease.accessToken,
      expiresAtMs: lease.expiresAtMs,
      region,
      buildEnv,
      baseUrl: managedBaseUrl(region, buildEnv),
    }
  } catch (error) {
    if (error instanceof AuthRequiredError) throw notLoggedIn(dataDir)
    throw error
  }
}

/** `{base}/messages`, leaving an address that already names the call alone. */
export function messagesUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/u, '')
  return trimmed.endsWith('/messages') ? trimmed : `${trimmed}/messages`
}

/** The one message a missing login gets: where to go, never what was looked for. */
function notLoggedIn(dataDir: string): Error {
  return new Error(
    `no MiniMax Code login under ${dataDir}. Open MiniMax Code, log in, then try again — `
    + 'this plugin answers with the same login, so there is no separate key to configure.',
  )
}

async function holdsLogin(dataDir: string): Promise<boolean> {
  return (await listLoggedInNamespaces(dataDir)).length > 0
}

/** Every `<buildEnv>/<region>` pair under a data dir that actually holds a credential. */
async function listLoggedInNamespaces(dataDir: string): Promise<{ region: AuthRegion; buildEnv: AuthBuildEnv }[]> {
  const authHome = join(dataDir, 'auth')
  const buildEnvs = await childDirs(authHome)
  const found: { region: AuthRegion; buildEnv: AuthBuildEnv }[] = []
  for (const buildEnv of buildEnvs) {
    if (!isBuildEnv(buildEnv)) continue
    for (const region of await childDirs(join(authHome, buildEnv))) {
      if (!isRegion(region)) continue
      if (await exists(join(authHome, buildEnv, region, 'mcode-public', 'auth.json'))) {
        found.push({ region, buildEnv })
      }
    }
  }
  return found
}

async function childDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch {
    return []
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function isBuildEnv(value: string): value is AuthBuildEnv {
  return (BUILD_ENVS as readonly string[]).includes(value)
}

function isRegion(value: string): value is AuthRegion {
  return (REGIONS as readonly string[]).includes(value)
}
