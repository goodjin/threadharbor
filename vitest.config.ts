import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@threadharbor/dsh-client': `${root}packages/dsh-client/src/index.ts`,
      '@threadharbor/dsh-acp-agent': `${root}packages/dsh-acp-agent/src/index.ts`,
    },
  },
  test: {
    include: ['packages/*/tests/**/*.spec.ts', 'tests/**/*.spec.ts'],
    // Node everywhere except the two files that build DOM. The roll-up's
    // renderer is browser code, and asserting on it in Node would mean asserting
    // against a stub of the DOM rather than the DOM.
    environment: 'node',
    environmentMatchGlobs: [
      ['**/rollup-mount.spec.ts', 'jsdom'],
      ['packages/dsh-client/tests/surface.spec.ts', 'jsdom'],
    ],
  },
})
