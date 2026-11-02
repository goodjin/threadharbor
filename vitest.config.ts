import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@goodjin2/dsh-acp-agent': `${root}packages/dsh-acp-agent/src/index.ts`,
    },
  },
  test: {
    // ui-primitives ships .css side-imports; node's loader refuses them
    // unless vitest transforms the package itself.
    server: { deps: { inline: [/@deepseek-ai\/dsh-client-ui-primitives/] } },
    include: ['packages/*/tests/**/*.spec.ts', 'tests/**/*.spec.ts'],
    // Node everywhere except the one file that needs a browser-like `window`:
    // the federation roll-up mount test touches window/storage.
    environment: 'node',
    environmentMatchGlobs: [
      ['packages/dsh-host-federation/tests/rollup-mount.spec.ts', 'jsdom'],
      // 手机页挂接层 bootApp 跑真 DOM（jsdom）：入口探测、页签、横幅、表单。
      ['packages/dsh-mobile-entry/tests/app.spec.ts', 'jsdom'],
      ['packages/dsh-mobile-entry/tests/hub-app.spec.ts', 'jsdom'],
    ],
  },
})
