import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: {
    // The client half is jsx: react-jsx (automatic runtime) per tsconfig.base.
    // Vitest's esbuild can't read that from the root tsconfig.json (which is a
    // references-only project with "files": []), so the JSX mode is pinned here
    // — without it the classic transform emits bare `React.createElement` and the
    // renderer dies with "React is not defined".
    jsx: 'automatic',
  },
  test: {
    include: ['tests-client/**/*.spec.ts'],
    // Node everywhere except the files that touch a real browser-like
    // `window` (sessionStorage/localStorage, heartbeat timers). The panel's
    // own rendering asserts through renderToString, which needs no DOM.
    environment: 'node',
    environmentMatchGlobs: [
      ['tests-client/panel-mount.spec.ts', 'jsdom'],
      ['tests-client/rollup-section.spec.ts', 'jsdom'],
    ],
  },
})
