/**
 * DSH Web plugins installed on remote hosts during SSH deploy (GitHub specs).
 */

/** Default ThreadHarbor bundle installed from GitHub instead of a local tarball upload. */
export const DEFAULT_REMOTE_DSH_PLUGINS: readonly string[] = [
  'github:goodjin/threadharbor#main',
]

export function normalizePluginSpecs(value: unknown, fallback: readonly string[] = DEFAULT_REMOTE_DSH_PLUGINS): readonly string[] {
  if (value === undefined || value === null) return fallback
  if (!Array.isArray(value)) throw new Error('remotePlugins must be an array of strings')
  const specs: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') continue
    specs.push(item.trim())
  }
  if (specs.length === 0) return fallback
  return specs
}
