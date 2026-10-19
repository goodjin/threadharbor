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

/** `packages/config/src/config.ts`: `LEGACY_MANAGED_PRESET_BASE_URLS`. */
export const LEGACY_MANAGED_PRESET_BASE_URLS: readonly string[] = [
  'https://agent.minimaxi.com/mavis/api/v1/llm/v1',
]

/** The managed LLM base URL one region/build-env pair talks to. */
export function managedBaseUrl(region: MavisRegion, buildEnv: MavisBuildEnv): string {
  return PRESET_BASE_URLS[`${region}-${buildEnv}`]
}
