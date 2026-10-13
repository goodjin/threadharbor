import { readFileSync, globSync } from 'node:fs'

const client = readFileSync('packages/dsh-client/lib/client.js', 'utf8')
if (!client.startsWith('window.__ModuleLoader__.load(') || !client.includes('@threadharbor/dsh-client')) {
  throw new Error('DSH browser artifact does not register with the public module loader')
}
if (client.includes('@threadharbor/protocol')) {
  throw new Error('DSH browser artifact leaked @threadharbor/protocol into the module table; it must be inlined')
}

/**
 * The browser artifact must be one file.
 *
 * The module loader's `require` resolves only its own table (platform seed
 * words, materialized plugins, registered factories) — never files. A dynamic
 * `import()` in the source makes the bundler emit a sibling chunk and call the
 * factory parameter with its relative path, which takes the whole page down at
 * boot with "missed the module table". Two signals, because the minifier
 * renames the injected `require` parameter so calls cannot be matched by name:
 * chunk files on disk (emitted as `.cjs` beside the entry), and a relative
 * `.cjs` specifier inside the bundle (the source writes no such literal). The
 * invariant is currently held by `inlineDynamicImports` in the client build.
 */
const chunks = globSync('packages/dsh-client/lib/*.cjs')
const relativeChunk = client.match(/["'`]\.\/[^"'`]*\.cjs["'`]/g)
if (chunks.length > 0 || relativeChunk !== null) {
  const named = [...chunks, ...(relativeChunk ?? [])].join(', ')
  throw new Error(
    `DSH browser artifact is not self-contained — split chunk(s): ${named} `
    + '(the module loader cannot resolve files; enforce inlineDynamicImports in the client build)',
  )
}

/**
 * No node builtins in the browser artifact.
 *
 * The platform seed table handed to the module loader lists react and the
 * client UI packages — no `node:*` words. A host-side module pulled into the
 * browser graph (through a package root that re-exports it) puts a
 * `require("node:os")` into the factory, and materialization dies with the
 * same "missed the module table" error. The browser half must import shared
 * constants from node-free modules, never from behavioral entries.
 */
const nodeBuiltin = client.match(/["'`]node:[^"'`]+["'`]/g)
if (nodeBuiltin !== null) {
  throw new Error(
    `DSH browser artifact requires node builtins the module table cannot resolve: ${[...new Set(nodeBuiltin)].join(', ')}`,
  )
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

/**
 * Every host-side plugin entry the bundle patch mounts must import under Node
 * itself, not just under tsx.
 *
 * The web host loads link-installed plugins through Node's strip-only
 * TypeScript mode; tsx (used by `pnpm test` and the source launch) silently
 * accepts what that mode rejects — a constructor parameter property, an enum,
 * a namespace. The import then throws inside the host, the entry never gets a
 * fiber, and boot reports only a bare "failed to import" with the cause buried.
 * Importing each entry here with plain Node catches the syntax at build time;
 * the patch file is the source of truth for what a host actually mounts.
 */
const patch = readFileSync('cordis.patch.yml', 'utf8')
const names = [...new Set([...patch.matchAll(/name:\s*'(@threadharbor\/[^']+)'/g)].map(m => m[1]))]
if (names.length === 0) {
  throw new Error('no @threadharbor plugin names found in cordis.patch.yml — the host-entry import check has nothing to check')
}
for (const name of names) {
  try {
    await import(name)
  } catch (error) {
    throw new Error(
      `host plugin entry ${name} does not import under plain Node (the web host's strip-only mode): `
      + (error instanceof Error ? error.message.split('\n')[0] : String(error)),
    )
  }
}

/**
 * The browser artifact must materialize under the module loader's contract.
 *
 * Static scans prove purity; this smoke proves behavior. The loader hands the
 * factory one `require` that resolves only its table (platform seed words,
 * materialized plugins, registered factories) — never files, never node
 * builtins. Run the artifact's factory with exactly that contract: any
 * relative or `node:` request, or a crash at module scope, fails here instead
 * of taking the page down at boot. Platform modules the factory may touch are
 * permissive stand-ins; the load-bearing assertions are the two refused
 * specifier classes and a factory that returns exports.
 */
{
  const vm = await import('node:vm')
  const universal = new Proxy(function universal() {}, {
    get: (_target, prop) => {
      if (prop === 'then') return undefined
      if (prop === Symbol.toPrimitive || prop === 'toString' || prop === Symbol.toStringTag) return () => 'universal'
      return universal
    },
    apply: () => universal,
    construct: () => ({}),
  })
  const requested = new Set()
  const tabledRequire = (spec) => {
    requested.add(spec)
    if (spec.startsWith('./') || spec.startsWith('node:')) {
      throw new Error(`client-modules: require("${spec}") missed the module table — not a platform seed word, not a materialized module, and no registered package factory`)
    }
    return universal
  }
  let registeredId = null
  let factoryExports = 'factory did not run'
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(entry) {
          registeredId = entry.id
          factoryExports = entry.factory(tabledRequire)
        },
      },
    },
    console,
  }
  vm.runInContext(client, vm.createContext(sandbox), { filename: 'client.js' })
  if (registeredId !== '@threadharbor/dsh-client') {
    throw new Error(`DSH browser artifact registered as ${String(registeredId)}; expected @threadharbor/dsh-client`)
  }
  if (typeof factoryExports !== 'object' || factoryExports === null || Object.keys(factoryExports).length === 0) {
    throw new Error('DSH browser artifact factory did not materialize exports under the module loader contract')
  }
}
