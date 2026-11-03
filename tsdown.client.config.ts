import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename } from 'node:path'
import { isAbsolute, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transform } from 'lightningcss'
import { defineConfig } from 'tsdown'

const id = '@goodjin2/dsh-threadharbor'
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
          // lightningcss 的 [hash] 以文件名为种子：传绝对路径会让类名哈希随构建目录
          // 变化（隔离工作区 vs 主仓 → 同一份 CSS 出不同 hash，产物于是每次都“变脏”，
          // 宿主按内容算 rev，会白白让每个打开的页面重载一次插件）。
          // 本包的 .module.css 基名唯一，传基名即让哈希只由内容决定。
          filename: basename(file),
          code: await readFile(file),
          cssModules: { pattern: '[hash]_[local]' },
          minify: true,
        })
        const classes: Record<string, string> = {}
        // 键序也要固定：lightningcss 的 exports 来自 Rust 侧哈希表，遍历顺序随进程
        // （HashMap 随机种子）变化，不排序的话同一份源码每次构建的产物字节都不同。
        const exported = Object.entries(result.exports ?? {})
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        for (const [local, value] of exported) classes[local] = value.name
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
