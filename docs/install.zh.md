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
2. 在 ThreadHarbor 侧栏选择“添加主机 → SSH 自动部署”。
3. 输入 SSH 目标、用户、端口，以及可选的 Web 服务本机私钥绝对路径和 ProxyJump。
4. 将页面显示的 SHA256 host-key 指纹与主机管理员提供的指纹核对，确认后部署 hostd。
5. 刷新 Agent 状态，确认远端已安装的命令能被 hostd 发现。
6. 对 Codex 或 Grok 点击“登录”，在页面打开授权链接并输入设备码。
7. 点击“配置”编辑对应 Agent 的用户配置；保存前由远程 hostd 校验语法。
8. 添加远程项目目录，然后从已安装、已登录且具备 session adapter 的 Agent 创建会话。

Claude Code 目前支持发现、登录和配置，但尚未接入 ThreadHarbor 原生会话 adapter，因此不会出现在新会话后端列表中。
