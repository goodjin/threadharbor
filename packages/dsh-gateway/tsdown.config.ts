import { defineConfig } from 'tsdown'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  entry: [`${root}lib/types/index.js`],
  outDir: `${root}lib`,
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  external: [/^@threadharbor\/hostd/],
})
