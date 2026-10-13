import { chmodSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'

const root = fileURLToPath(new URL('.', import.meta.url))

// One self-contained executable: DSH spawns presets with a bare `command`
// and no args, so the adapter ships as a single shebanged ESM file under lib/.
export default defineConfig({
  entry: { 'zcode-acp': `${root}src/main.ts` },
  outDir: `${root}lib`,
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: false,
  minify: false,
  banner: { js: '#!/usr/bin/env node' },
  onSuccess: async () => { chmodSync(`${root}lib/zcode-acp.js`, 0o755) },
})
