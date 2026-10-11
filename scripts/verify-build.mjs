import { readFileSync, globSync } from 'node:fs'

const client = readFileSync('packages/dsh-client/lib/client.js', 'utf8')
if (!client.startsWith('window.__ModuleLoader__.load(') || !client.includes('@threadharbor/dsh-client')) {
  throw new Error('DSH browser artifact does not register with the public module loader')
}
if (client.includes('@threadharbor/protocol')) {
  throw new Error('DSH browser artifact leaked @threadharbor/protocol into the module table; it must be inlined')
}

/**
 * The artifact must actually contain what the source exports.
 *
 * `lib/` is build output and is not committed, so a package can sit there holding
 * an artifact from an earlier day that still registers with the module loader
 * and still loads — every smoke check passes and the feature is simply missing.
 * This is the check that catches it: every named export of the browser half has
 * to be findable in the built file.
 */
const exported = new Set()
for (const source of globSync('packages/dsh-client/src/client/**/*.ts')) {
  const text = readFileSync(source, 'utf8')
  for (const match of text.matchAll(/export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z0-9_$]+)/g)) {
    exported.add(match[1])
  }
  for (const match of text.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const name of match[1].split(',')) {
      const trimmed = name.trim().split(/\s+as\s+/).pop()?.trim()
      if (trimmed !== undefined && trimmed !== '') exported.add(trimmed)
    }
  }
}
const missing = [...new Set([...exported])].filter(name => !client.includes(name))
if (missing.length > 0) {
  throw new Error(
    `DSH browser artifact is stale — missing from the build: ${missing.join(', ')}. `
    + 'Run `pnpm build`; lib/ is build output and is not committed.',
  )
}
