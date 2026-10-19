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
    // ui-primitives ships .css side-imports; node's loader refuses them
    // unless vitest transforms the package itself.
    server: { deps: { inline: [/@deepseek-ai\/dsh-client-ui-primitives/] } },
    include: ['packages/*/tests/**/*.spec.ts', 'tests/**/*.spec.ts'],
    // Node everywhere except the one file that needs a browser-like `window`:
    // the panel mount test touches window/sessionStorage/localStorage and the
    // heartbeat timers. The panel's own rendering asserts through
    // renderToString, which needs no DOM.
    environment: 'node',
    environmentMatchGlobs: [
      ['packages/dsh-client/tests/panel-mount.spec.ts', 'jsdom'],
      ['packages/dsh-client/tests/rollup-section.spec.ts', 'jsdom'],
      ['packages/dsh-client/tests/surface.spec.ts', 'jsdom'],
      ['packages/dsh-host-federation/tests/rollup-mount.spec.ts', 'jsdom'],
      // 手机页挂接层 bootApp 跑真 DOM（jsdom）：入口探测、页签、横幅、表单。
      ['packages/dsh-mobile-entry/tests/app.spec.ts', 'jsdom'],
      ['packages/dsh-mobile-entry/tests/hub-app.spec.ts', 'jsdom'],
    ],
  },
})
