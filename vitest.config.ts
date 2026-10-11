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
    // Node everywhere except the one file that needs a browser-like `window`:
    // the panel mount test touches window/sessionStorage/localStorage and the
    // heartbeat timers. The panel's own rendering asserts through
    // renderToString, which needs no DOM.
    environment: 'node',
    environmentMatchGlobs: [
      ['packages/dsh-client/tests/panel-mount.spec.ts', 'jsdom'],
    ],
  },
})
