/**
 * pnpm install 钩子：让 `github:goodjin/threadharbor#<ref>` 这种 git 安装开箱即用。
 *
 * git 依赖落成一份纯 checkout：没有 node_modules，也没有构建产物。宿主侧插件是
 * TS 源码（dsh 直接装载，无需构建），但客户端包 `@threadharbor/dsh-client` 必须有
 * 构建出来的 `lib/client.js` 才会被服务给页面——缺了它就是「宿主侧活着、页面上
 * 没有插件」的半残安装（2026-10-20 桌面版输入框裸模型名的同款形状）。
 *
 * 职责（仅在需要时）：
 *   1. workspace 里没有 node_modules 时补跑 `pnpm install`（git 依赖的 prepare
 *      阶段先于依赖安装，这正是 prepare 存在的意义——自己引导自己）；
 *   2. 构建 `lib/`（tsc -b 产出类型与中间层，tsdown 打包客户端入口）。
 *
 * 开发仓里本钩子是空操作：workspace 安装与构建产物都在时直接返回，日常
 * `pnpm install` 不被拖累，也不会和并行的构建流程抢活。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const clientLib = `${root}packages/dsh-client/lib/client.js`
const workspaceLink = `${root}node_modules/@threadharbor/dsh-client`

const done = existsSync(clientLib) && existsSync(workspaceLink)
if (done) {
  process.exit(0)
}

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
  })
  if (result.status !== 0) {
    console.error(`prepare-install: ${command} ${args.join(' ')} failed (exit ${String(result.status)})`)
    process.exit(result.status ?? 1)
  }
}

function pnpm(args) {
  // git 依赖的 prepare 里 PATH 未必有 pnpm；corepack 按 packageManager 字段补位。
  const direct = spawnSync('pnpm', args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
  if (direct.status === 0) return
  if (direct.error === undefined && direct.status !== null && direct.status !== 127) {
    process.exit(direct.status ?? 1)
  }
  run('corepack', ['pnpm', ...args])
}

if (!existsSync(workspaceLink)) {
  pnpm(['install'])
}

run('pnpm', ['exec', 'tsc', '-b', 'tsconfig.json'])
run('pnpm', ['exec', 'tsx', 'scripts/build.ts'])

if (!existsSync(clientLib)) {
  console.error('prepare-install: packages/dsh-client/lib/client.js 仍未产出 —— 构建链断了，页面将拿不到插件客户端')
  process.exit(1)
}
console.log('prepare-install: threadharbor client bundle built.')
