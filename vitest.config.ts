import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@threadharbor/protocol': `${root}packages/protocol/src/index.ts`,
      '@threadharbor/dsh-client': `${root}packages/dsh-client/src/index.ts`,
      '@threadharbor/dsh-acp-agent': `${root}packages/dsh-acp-agent/src/index.ts`,
    },
  },
  test: {
    include: ['packages/*/tests/**/*.spec.ts', 'tests/**/*.spec.ts'],
    environment: 'node',
  },
})
