# 安装 ThreadHarbor 到 DeepSeek Harness

ThreadHarbor 是 DSH Web profile 的树外 bundle。它使用 `dsh plugin` 安装，不复制或修改 DeepSeek Harness 源码。

## 前置条件

- 已安装可运行的 DeepSeek Harness，并能执行 `dsh --profile web`；
- DSH 运行环境和 ThreadHarbor 开发构建使用 Node.js `^22.19` 或 `>=24`；
- 管理 profile 插件和从源码构建时需要 pnpm；
- 远程主机需要 SSH、Node.js 22 或更新版本，并由管理员预先安装需要使用的 Agent。

## 从 npm 安装

ThreadHarbor 及其 `@threadharbor/*` 包发布到 npm 后执行：

```sh
dsh plugin --profile web add threadharbor
dsh --profile web
```

`web` profile 不存在时，第一条命令会按 DSH 的 Web 模板创建它。启动后打开 `dsh web:` 输出的地址；ThreadHarbor 将替换侧栏和会话表面，但保留 DSH 的 Web runtime、layout、theme 和 settings。

升级和卸载：

```sh
dsh plugin --profile web update threadharbor
dsh plugin --profile web remove threadharbor
```

修改 profile 后需要重启对应的 `dsh --profile web` 进程。

## 日常发布（源码本地 build / release snapshot）

不通过 npm，而是把当前 checkout 的代码作为不可变快照发布到 `~/.local/share/threadharbor/releases/`，并把对应 channel（stable 3080 / test 3081）的 DSH Web 平滑切到新快照。完整链路在 `scripts/release-promote.mjs`：

```sh
pnpm run release:candidate                       # npm run build -> pnpm deploy -> 写 manifest + 校验和
pnpm run release:promote  -- --channel stable    # stop -> promoteRelease -> startChannel
pnpm run release:status    -- --channel stable   # 健康检查
```

`release:promote` 是一次原子事务：成功时 DSH Web 服务的就是新快照；失败时会自动回滚到上一个快照并把老 DSH Web 重新拉起，DSH 不会中断。失败信息会区分"已回滚"还是"需要手工恢复"。

如果 `dsh` 不在 `PATH` 上（例如本地用 `scripts/dsh-wrapper.sh` 启动），先把 dsh 入口导出给发布脚本：

```sh
export THREADHARBOR_DSH_COMMAND=/absolute/path/to/dsh-wrapper.sh   # 或者 dsh 二进制绝对路径
pnpm run release:promote -- --channel stable
```

发布失败回滚的具体步骤：

```sh
node scripts/release-channel.mjs status   --channel stable
node scripts/release-channel.mjs rollback --channel stable
node scripts/release-channel.mjs start    --channel stable
```

发布机（`release-promote.mjs`）和发布仓库（`release-channel.mjs`）的分工：

- `release-channel.mjs`：8 个原子子命令（candidate / verify / promote / rollback / bootstrap / start / stop / status），可以单独调用。
- `release-promote.mjs`：把 candidate、promote、start 串成一个 release；默认要求 clean working tree（manifest 里 `source.dirty=true` 会被 `promoteRelease` 拒掉，需要 `--allow-dirty`）。

## 从 GitHub 源码安装

尚未使用 npm 发行包时，使用 pnpm 安装工作区依赖并构建全部五个包，再让 DSH profile 链接根 bundle：

```sh
git clone https://github.com/goodjin/threadharbor.git
cd threadharbor
corepack pnpm install
pnpm run build
dsh plugin --profile web add link:.
dsh --profile web
```

`link:.` 会由 DSH 转成当前 checkout 的绝对链接。该安装方式运行的是此目录中的构建产物，因此在执行下面的卸载命令前不能移动或删除 checkout：

```sh
dsh plugin --profile web remove threadharbor
```

拉取新提交后重新执行 `corepack pnpm install` 和 `pnpm run build`，再重启 Web profile。开发参考源码不是运行依赖；只有需要核对 DSH API 时才运行 `npm run reference:checkout`。

## 核对组合结果

不启动服务器即可查看合成后的 profile：

```sh
dsh --profile web --dump-config
```

输出中应包含 `threadharbor-gateway` 和 `threadharbor-client`，官方 `ui-sidebar` 与 `ui-conversation` 两行应被 profile patch 禁用。若 DSH 报某个包无法解析，先在源码 checkout 重新运行 `corepack pnpm install` 和 `pnpm run build`；npm 安装则运行 `dsh plugin --profile web install` 修复 profile 依赖。

## 首次使用

1. 启动 `dsh --profile web` 并打开页面。
2. 在侧栏 **各主机** 中登记本机与其他主机（手动填写地址，或使用 **SSH 自动部署** 在远端安装 DSH + ThreadHarbor，详见 [ssh-deploy.zh.md](./ssh-deploy.zh.md)）。
3. 每台主机在各自的浏览器标签页打开（`dsh web` 打印的 URL 与 `?token=…`）；跨标签页频道只汇总 **在线/心跳**，会话仍在各主机自己的页面操作。
4. 在本机 profile 中配置需要的 ACP agent preset；远端主机上的 agent 需在目标机自行安装并在该机的 profile 中配置。

Claude Code / Codex / Grok 的安装与登录方式见 [install-plugins.zh.md](./install-plugins.zh.md)。
