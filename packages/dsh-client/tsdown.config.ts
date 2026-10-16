import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename } from 'node:path'
import { isAbsolute, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transform } from 'lightningcss'
import { defineConfig } from 'tsdown'

const id = '@threadharbor/dsh-client'
const root = fileURLToPath(new URL('.', import.meta.url))
const cssPrefix = '\0threadharbor-css:'
const cssSuffix = '.mjs'
const externals = new Set([
  'react',
  'react/jsx-runtime',
  // Seeded by DSH's own platform table (client/web/src/platform.ts). The
  // composer model seat is upstream's component and portals its menu; leaving
  // react-dom out of this set inlined the CJS build into the page bundle, where
  // its `process.env.NODE_ENV` read has no `process` to answer it.
  'react-dom',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-ui-layout/client',
  '@deepseek-ai/dsh-client-ui-primitives',
])

// Packages whose PUBLISHED main entry resolves Node-first must ship their own
// browser entry to this bundle by name. `qrcode` is the case that bit us: its
// main entry pulls the PNG-to-file renderer, whose bare `require('fs')` takes
// the whole page down at materialization ("missed the module table") — and a
// bare builtin name slips past any `node:`-prefix grep, so the resolver, not
// the source, pins the browser entry here. verify-build.mjs refuses every
// builtin spelling either way; if this mapping ever drifts, the gate goes red.
const require_ = createRequire(import.meta.url)
const browserEntries: Record<string, string> = {
  qrcode: require_.resolve('qrcode/package.json').replace(/package\.json$/, 'lib/browser.js'),
}

export default defineConfig([
  {
    entry: [`${root}lib/types/index.js`],
    outDir: `${root}lib`,
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: { client: `${root}lib/types/client/index.js` },
    outDir: `${root}lib`,
    format: 'cjs',
    platform: 'browser',
    target: 'es2024',
    dts: false,
    sourcemap: true,
    minify: true,
    clean: false,
    // DSH Web only materializes the platform allowlist below. Workspace
    // packages such as @threadharbor/protocol are production deps and would
    // otherwise stay as require() against a missing module-table entry.
    external: [...externals],
    noExternal: (specifier: string) => !externals.has(specifier),
    alias: browserEntries,
    plugins: [{
      name: 'threadharbor-css-modules',
      resolveId(source: string, importer?: string) {
        if (!source.endsWith('.module.css') || importer === undefined) return null
        const emitted = new URL(source, `file://${importer}`).pathname
        const file = existsSync(emitted) ? emitted : emitted.replace('/lib/types/', '/src/')
        return `${cssPrefix}${file}${cssSuffix}`
      },
      async load(virtualId: string) {
        if (!virtualId.startsWith(cssPrefix)) return null
        const file = virtualId.slice(cssPrefix.length, -cssSuffix.length)
        this.addWatchFile(file)
        const result = transform({
          filename: file,
          code: await readFile(file),
          cssModules: { pattern: '[hash]_[local]' },
          minify: true,
        })
        const classes: Record<string, string> = {}
        for (const [local, value] of Object.entries(result.exports ?? {})) classes[local] = value.name
        const css = result.code.toString()
        const tag = `${id}/${basename(file)}`
        return [
          `const css = ${JSON.stringify(css)};`,
          `const tag = ${JSON.stringify(tag)};`,
          "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tag) + ']') === null) {",
          "  const element = document.createElement('style');",
          `  element.dataset.plugin = ${JSON.stringify(id)};`,
          '  element.dataset.pluginCss = tag;',
          '  element.textContent = css;',
          '  document.head.appendChild(element);',
          '}',
          `export default ${JSON.stringify(classes)};`,
        ].join('\n')
      },
    }],
    outputOptions: {
      // One file, always: the module loader's `require` resolves only its own
      // table (platform seed words, materialized plugins, registered package
      // factories) — never files. A dynamic `import()` in the source would
      // otherwise emit a sibling chunk and call the factory parameter with its
      // relative path, taking the page down at boot with "missed the module
      // table". Same choice DSH's own single-file client plugins make.
      inlineDynamicImports: true,
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      sourcemapPathTransform: (source: string) => isAbsolute(source) ? relative(root, source).replaceAll('\\', '/') : source,
    },
  },
])
