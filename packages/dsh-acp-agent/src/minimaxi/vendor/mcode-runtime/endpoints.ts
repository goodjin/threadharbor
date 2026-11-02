/**
 * Managed-login endpoint facts, copied from MiniMax Code's own config.
 *
 * Upstream: `packages/config/src/config.ts` (`PRESET_BASE_URLS`) in
 * MiniMax-AI/minimax-code. Only the production entries are copied: every other
 * environment ships `.example.invalid` placeholders in the open-source tree, so
 * there is nothing real to copy for them.
 *
 * These are product-internal routing facts with no documentation behind them.
 * They are copied rather than invented so that a change upstream is a diff here,
 * not a silent divergence — see PROVENANCE.md for how to re-sync.
 */

export type MavisRegion = 'cn' | 'en'
export type MavisBuildEnv = 'prod' | 'staging' | 'test' | 'dev'

export type PresetKey = `${MavisRegion}-${MavisBuildEnv}`

/** `packages/config/src/config.ts`: `PRESET_BASE_URLS`. */
export const PRESET_BASE_URLS: Readonly<Record<PresetKey, string>> = {
  'cn-test': 'https://matrix-test.example.invalid/mavis/api/v1/llm/v1',
  'cn-dev': 'https://matrix-test.example.invalid/mavis/api/v1/llm/v1',
  'cn-staging': 'https://matrix-pre.example.invalid/mavis/api/v1/llm/v1',
  'en-test': 'https://matrix-overseas-test.example.invalid/mavis/api/v1/llm/v1',
  'en-dev': 'https://matrix-overseas-test.example.invalid/mavis/api/v1/llm/v1',
  'en-staging': 'https://matrix-overseas-pre.example.invalid/mavis/api/v1/llm/v1',
  'cn-prod': 'https://agent.minimax.cn/mavis/api/v1/llm/v1',
  'en-prod': 'https://agent.minimax.io/mavis/api/v1/llm/v1',
}

/**
 * Open-platform origins, copied from the MiniMax Code desktop app's quota
 * transport (`MemoryQuotaTransport`, measured 2026-10-30 against the installed
 * `MiniMax Code.app`). The coding-plan `remains` readout the quota pill shows
 * lives here, not on the managed LLM gateway — only the production entries are
 * real; the rest mirror the desktop app's own staging/test/dev hosts.
 */
export const OPEN_PLATFORM_BASE_URLS: Readonly<Record<PresetKey, string>> = {
  'cn-test': 'https://openplatform-test.xaminim.com',
  'cn-dev': 'https://openplatform-test.xaminim.com',
  'cn-staging': 'https://open-platform-for-online-test.xaminim.com',
  'en-test': 'https://mmx-test.xaminim.com',
  'en-dev': 'https://mmx-test.xaminim.com',
  'en-staging': 'https://mmx-pre.xaminim.com',
  'cn-prod': 'https://www.minimaxi.com',
  'en-prod': 'https://platform.minimax.io',
}

/** `packages/config/src/config.ts`: `LEGACY_MANAGED_PRESET_BASE_URLS`. */
export const LEGACY_MANAGED_PRESET_BASE_URLS: readonly string[] = [
  'https://agent.minimaxi.com/mavis/api/v1/llm/v1',
]

/** The managed LLM base URL one region/build-env pair talks to. */
export function managedBaseUrl(region: MavisRegion, buildEnv: MavisBuildEnv): string {
  return PRESET_BASE_URLS[`${region}-${buildEnv}`]
}

/**
 * The open-platform base URL one region/build-env pair talks to.
 * The coding-plan `remains` readout is served from here (Bearer + `X-Group-Id`,
 * no request signing — unlike the `/matrix/` membership lookups).
 */
export function openPlatformBaseUrl(region: MavisRegion, buildEnv: MavisBuildEnv): string {
  return OPEN_PLATFORM_BASE_URLS[`${region}-${buildEnv}`]
}

/**
 * The matrix origin (scheme + host) the signed `/matrix/` and `/v1/api/user/info`
 * calls go to. Derived from the managed LLM base so the host stays in one place.
 */
export function matrixOrigin(llmBaseUrl: string): string {
  return new URL(llmBaseUrl).origin
}
