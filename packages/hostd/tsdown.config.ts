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
  outputOptions: { codeSplitting: false },
  dts: false,
  clean: false,
  minify: true,
  deps: {
    alwaysBundle: (specifier: string) => !isBuiltin(specifier),
  },
}

export default defineConfig([
  { ...base, entry: { index: `${root}lib/types/server.js` } },
  { ...base, entry: [`${root}lib/types/bin.js`] },
  { ...base, entry: { 'hold-worker': `${root}lib/types/hold-worker.js` } },
])
