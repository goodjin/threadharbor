/**
 * pnpm install 钩子：让 `github:goodjin/threadharbor#<ref>` 这种 git 安装开箱即用。
 *
 * git 依赖落成一份纯 checkout：没有 node_modules。宿主侧插件是 TS 源码
 * （dsh 直接装载，无需构建）；bundle 的宿主组合层（lib/index.js）由 tsc 从
 * TS 源产出，同样无需打包。浏览器 bundle 已随联邦 UI 独立出仓
 * （github.com/goodjin/dsh-client），那边自己构建。
 *
 * 职责（仅在需要时）：workspace 里没有 node_modules 时补跑 `pnpm install`
 * （git 依赖的 prepare 阶段先于依赖安装，这正是 prepare 存在的意义——自己
 * 引导自己）。开发仓里本钩子是空操作，日常 `pnpm install` 不被拖累。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const workspaceLink = `${root}node_modules/@threadharbor`

if (existsSync(workspaceLink)) {
  process.exit(0)
}

function pnpm(args) {
  // git 依赖的 prepare 里 PATH 未必有 pnpm；corepack 按 packageManager 字段补位。
  const direct = spawnSync('pnpm', args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
  if (direct.status === 0) return
  if (direct.error === undefined && direct.status !== null && direct.status !== 127) {
    process.exit(direct.status ?? 1)
  }
  const corepack = spawnSync('corepack', ['pnpm', ...args], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
  if (corepack.status !== 0) {
    console.error(`prepare-install: pnpm ${args.join(' ')} failed (exit ${String(corepack.status ?? 'signal')})`)
    process.exit(corepack.status ?? 1)
  }
}

pnpm(['install'])
console.log('prepare-install: workspace installed.')
