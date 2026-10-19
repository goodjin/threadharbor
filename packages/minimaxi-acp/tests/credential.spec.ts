/**
 * The local MiniMax Code login, resolved the way MiniMax Code itself resolves it.
 *
 * Every test builds a real credential tree in a temp directory — same layout,
 * same file modes, same record key the official store validates. Nothing here
 * reaches the network or the user's own `~/.minimax`.
 */

import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { messagesUrl, resolveCredential, resolveDataDir } from '../src/credential.ts'
import type { AuthBuildEnv, AuthRegion } from '../src/credential.ts'

type Login = {
  readonly buildEnv?: AuthBuildEnv
  readonly region?: AuthRegion
  readonly accessToken?: string
  readonly refreshToken?: string
  readonly expiresAtMs?: number
  readonly generation?: number
}

/** Where the tree landed: `home` for the current name, `home/.mavis` for the pre-rename one. */
type LoginTree = { readonly home: string; readonly dataDir: string }

/** A temp home holding one namespaced credential, byte-identical in shape to the real one. */
async function withLogin(login: Login = {}, layout: 'current' | 'legacy' = 'current'): Promise<LoginTree> {
  const home = await mkdtemp(join(tmpdir(), 'minimaxi-login-'))
  const dataDir = layout === 'legacy' ? join(home, '.mavis') : home
  const buildEnv = login.buildEnv ?? 'prod'
  const region = login.region ?? 'cn'
  const authHome = join(dataDir, 'auth')
  const namespaceHome = join(authHome, buildEnv, region, 'mcode-public')
  await mkdir(namespaceHome, { recursive: true, mode: 0o700 })
  await chmod(authHome, 0o700)
  await chmod(join(authHome, buildEnv), 0o700)
  await chmod(join(authHome, buildEnv, region), 0o700)
  // The official store keys its record by sha256(`<authHome>\0<clientId>`), so the
  // hash is taken over the auth home — not the namespaced directory itself.
  const account = createHash('sha256')
    .update(`${authHome}\0mcode-public`)
    .digest('base64url')
  const record = {
    schemaVersion: 1,
    accessToken: login.accessToken ?? 'mmoat_test_access_token',
    refreshToken: login.refreshToken ?? 'mmort_test_refresh_token',
    tokenType: 'Bearer',
    clientId: 'mcode-public',
    scopes: ['agent.default'],
    audience: 'agent-backend',
    expiresAtMs: login.expiresAtMs ?? Date.now() + 3_600_000,
    generation: login.generation ?? 7,
  }
  const file = join(namespaceHome, 'auth.json')
  await writeFile(file, `${JSON.stringify({ schemaVersion: 1, records: { [`com.minimax.mcode.oauth.${buildEnv}.${region}\0${account}`]: record } }, null, 2)}\n`, { mode: 0o600 })
  await chmod(file, 0o600)
  // The credential only counts while the sibling state file agrees and the two
  // generations match — which is why a real login always leaves both behind.
  const stateFile = join(namespaceHome, 'auth-state.json')
  await writeFile(stateFile, `${JSON.stringify({
    schemaVersion: 2,
    status: 'authenticated',
    storeKind: 'file',
    clientId: 'mcode-public',
    scopes: ['agent.default'],
    audience: 'agent-backend',
    buildEnv,
    region,
    expiresAtMs: record.expiresAtMs,
    generation: record.generation,
  }, null, 2)}\n`, { mode: 0o600 })
  await chmod(stateFile, 0o600)
  return { home, dataDir }
}

/** A fetch that answers nothing but the token endpoint, counting what it was asked. */
function tokenEndpointFetch(granted: { accessToken: string; expiresInSec: number }): {
  fetchImpl: typeof fetch
  calls: string[]
} {
  const calls: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(String(input))
    return new Response(
      JSON.stringify({
        access_token: granted.accessToken,
        refresh_token: 'mmort_rotated_refresh_token',
        token_type: 'Bearer',
        expires_in: granted.expiresInSec,
        scope: 'agent.default',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch
  return { fetchImpl, calls }
}

describe('resolveDataDir', () => {
  it('prefers MINIMAX_DATA_DIR over everything else', async () => {
    const chosen = await mkdtemp(join(tmpdir(), 'minimaxi-chosen-'))
    const other = await mkdtemp(join(tmpdir(), 'minimaxi-other-'))
    expect(await resolveDataDir({ env: { MINIMAX_DATA_DIR: chosen, MAVIS_DATA_DIR: other } })).toBe(chosen)
  })

  it('falls back to MAVIS_DATA_DIR when the new name is unset', async () => {
    const other = await mkdtemp(join(tmpdir(), 'minimaxi-other-'))
    expect(await resolveDataDir({ env: { MAVIS_DATA_DIR: other } })).toBe(other)
  })

  it('uses ~/.minimax, and ~/.mavis only when that is where the login actually is', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'minimaxi-home-'))
    expect(await resolveDataDir({ home: empty, env: {} })).toBe(join(empty, '.minimax'))
    const legacy = await withLogin({}, 'legacy')
    expect(await resolveDataDir({ home: legacy.home, env: {} })).toBe(legacy.dataDir)
  })
})

describe('resolveCredential', () => {
  it('returns the access token the local login already holds', async () => {
    const { dataDir } = await withLogin({ accessToken: 'mmoat_fresh_token' })
    const credential = await resolveCredential({ dataDir })
    expect(credential.accessToken).toBe('mmoat_fresh_token')
    expect(credential.region).toBe('cn')
    expect(credential.baseUrl).toBe('https://agent.minimax.cn/mavis/api/v1/llm/v1')
  })

  it('takes the region from the credential on disk, not from a guess', async () => {
    const { dataDir } = await withLogin({ region: 'en', buildEnv: 'prod', accessToken: 'mmoat_global_token' })
    const credential = await resolveCredential({ dataDir })
    expect(credential.region).toBe('en')
    expect(credential.baseUrl).toBe('https://agent.minimax.io/mavis/api/v1/llm/v1')
  })

  it('refreshes an expired token through the official token endpoint, under the shared lock', async () => {
    const { dataDir } = await withLogin({ expiresAtMs: Date.now() - 60_000, generation: 12 })
    const { fetchImpl, calls } = tokenEndpointFetch({ accessToken: 'mmoat_refreshed_token', expiresInSec: 3600 })
    const credential = await resolveCredential({ dataDir, fetchImpl })
    expect(credential.accessToken).toBe('mmoat_refreshed_token')
    expect(calls).toEqual(['https://account.minimax.cn/oauth2/token'])
  })

  it('leaves the refreshed token on disk for the desktop app to pick up', async () => {
    const { dataDir } = await withLogin({ accessToken: 'mmoat_stale_token', expiresAtMs: Date.now() - 60_000 })
    const { fetchImpl } = tokenEndpointFetch({ accessToken: 'mmoat_rotated_token', expiresInSec: 3600 })
    await resolveCredential({ dataDir, fetchImpl })
    const written = await readFile(join(dataDir, 'auth', 'prod', 'cn', 'mcode-public', 'auth.json'), 'utf8')
    expect(written).toContain('mmoat_rotated_token')
  })

  it('says how to log in when there is no local login, without naming a file it invented', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'minimaxi-empty-'))
    await expect(resolveCredential({ dataDir: empty })).rejects.toThrow(/MiniMax Code/)
  })
})

describe('messagesUrl', () => {
  it('appends /messages to the managed gateway, the way the anthropic adapter does', () => {
    expect(messagesUrl('https://agent.minimax.cn/mavis/api/v1/llm/v1')).toBe(
      'https://agent.minimax.cn/mavis/api/v1/llm/v1/messages',
    )
    expect(messagesUrl('https://agent.minimax.cn/mavis/api/v1/llm/v1/')).toBe(
      'https://agent.minimax.cn/mavis/api/v1/llm/v1/messages',
    )
  })
})
