import { defineConfig } from 'tsdown'
import { fileURLToPath } from 'node:url'
import { isBuiltin } from 'node:module'

const root = fileURLToPath(new URL('.', import.meta.url))

const base = {
  outDir: `${root}lib`,
  format: ['esm'] as const,
  platform: 'node' as const,
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  minify: true,
}

/**
 * Remote-only artifacts that ship to the host daemon via SSH. They must be
 * location-independent self-contained scripts so verify-build.mjs can scan
 * them: only `node:` builtins may remain as external references.
 */
const bundleAll = (id: string): boolean => !isBuiltin(id)

const SELF_CONTAINED = {
  ...base,
  noExternal: bundleAll,
} as const

/**
 * Library entry consumed by the gateway over HTTP. External deps are kept
 * so we ship a thin wrapper around the workspace dependencies.
 */
const LIBRARY = {
  ...base,
  deps: {
    alwaysBundle: (specifier: string) => !isBuiltin(specifier),
  },
} as const

export default defineConfig([
  { ...LIBRARY, entry: { index: `${root}lib/types/server.js` } },
  { ...SELF_CONTAINED, entry: [`${root}lib/types/bin.js`] },
  { ...SELF_CONTAINED, entry: { 'hold-worker': `${root}lib/types/hold-worker.js` } },
])
