# Bug Fix: 部署 codex/claude 一直报 `installer exited with status 1`（npm EEXIST），且界面只看到 electron_mirror 警告

## 问题描述
- 日期: 2026-09-08
- 严重程度: High（操作被完全阻塞；当天 Mac-mini 上 codex 失败 2 次、claude 失败 3 次）
- 影响范围: 主机设置 → 对**远端已存在同名 bin 文件**的主机执行「部署 codex / claude」；症状对所有 npm 安装型 Agent（codex / claude / grok）通用。
- 现象: 浏览器弹「部署 codex installer exited with status 1: npm warn Unknown user config "electron_mirror" …」——错误正文只露出开头几条 **npm 对 `~/.npmrc` 未知键的警告**，真正原因（日志尾部）被界面截断。gateway 日志（`threadharbor-runtime/web.log`）里能看到完整尾部:

  ```
  npm error code EEXIST
  npm error path /Users/jin/.local/bin/codex
  npm error EEXIST: file already exists
  npm error File exists: /Users/jin/.local/bin/codex
  ```

## 根因分析
- 问题位置: `packages/hostd/src/agent-manager.ts` `install()` / `installPlan()`。
- 原因: ThreadHarbor 的官方安装命令是 `npm install -g @openai/codex@0.150.1 @agentclientprotocol/codex-acp@1.6.2`（claude 同理）。npm 在全局 prefix 的 `bin/` 目录建符号链接时，如果目标文件名已被**其它来源**占用，npm **不会覆盖**，直接以 `EEXIST` 退出 1。本机实测（Mac-mini，`jin@100.96.156.60`，npm prefix `~/.local`）:
  - `~/.local/bin/codex` → 指向无关的 `codex-cli`（v0.1.3，"The CLI for codex.js"）→ 挡住 `@openai/codex`；
  - `~/.local/bin/claude` → 指向独立安装的 `~/.local/share/claude/versions/2.1.50` → 挡住 `@anthropic-ai/claude-code`；
  - 该机没有 `@openai` / `@agentclientprotocol` 任何包，也没有 `codex-acp` / `claude-agent-acp`，所以 hostd 库存判定 codex/claude「未安装」，一部署就撞 EEXIST。
- 为什么用户只看到 npm 警告: hostd 把安装输出尾部塞进错误消息，而 Web 错误条展示时从头截断；`electron_mirror`/`ELECTRON_MIRROR`/`electron_builder_binaries_mirror` 只是 `~/.npmrc` 里的中国镜像配置，npm 不认识它们所以警告，**与失败无关**（真的错误在它们后面）。

## 修复方案
- 修改文件: `packages/hostd/src/agent-manager.ts`
  - 常量 `NPM_BIN_NAMES` / `NPM_BIN_OWNER`:每个后端官方安装要写的全局 bin 名，及其所属 npm 包（codex→`codex`,`codex-acp`；claude→`claude`,`claude-agent-acp`；grok→`grok`）。
  - 模块级 `describeOccupiedNpmBin(path, binName)`:检查某个全局 bin 路径当前被什么占用；**自己上次安装的链接（指向 `node_modules/<所属包>`）不算冲突**，其余（别的包建的链接、普通文件、目录、悬空链接）都算。
  - `install()` 在真正跑 `npm install -g` **之前**先做预检（`npmInstallBlocker` → `npm prefix -g` 定位 bin 目录，逐个 bin 名检查）：有冲突就直接抛**中文可操作错误**，列出被占文件、占用来源（含所属包名），并给出 `mv '<path>' '<path>.bak'`（或 `rm`、或 `npm uninstall -g <占用包>`）的重试指引，不再让 npm 白跑一遍 EEXIST。
  - 兜底翻译 `npmInstallEexistMessage`:预检后 npm 仍报 `EEXIST`（预检和链接之间新出现的文件等竞态）时，从 `npm error path …` 解析出冲突文件并给出同样的中文提示，而不是丢原始输出让用户去翻日志。
- 不改 `installPlan()`:确认弹窗仍展示官方命令；冲突在执行确认后才暴露为清晰错误（保持“浏览器只能确认 hostd 预声明的官方计划”的既有设计）。

## 验证
1. ✅ `npx vitest run packages/hostd/tests/agent-manager.spec.ts` — 11/11（新增 3 条）:
   - `reports a clear EEXIST preflight reason when another package owns the global bin name`——`bin/codex` 指向 `codex-cli` 时 install 直接拒绝，报中文占用原因 + `mv` 指引，且 npm install 从未被 spawn（marker 不存在）；
   - `allows an existing npm link that already targets the package being installed`——已有链接指向 `node_modules/@openai/codex` 等目标时不拦截，可正常重装；
   - `translates a residual npm EEXIST failure when no conflict existed at preflight time`——npm 自身 EEXIST 输出被翻译成含 `mv` 指引的中文错误。
   - 三条测试 stub 掉 `PATH`，避免本机已装的真实 codex/claude 污染 `alreadyInstalled` 判断。
2. ✅ `npx vitest run packages/hostd` — 10 文件 65/65 通过。
3. ✅ `npx tsc -b tsconfig.json` 无类型错误。
4. ✅ `npm run build` 重建 hostd/gateway/dsh-client 制品（hostd `lib/bin.js` 包含预检逻辑）。

## 遗留 / 运维注意
- ⚠️ hostd 是运行在目标主机上的独立进程：**代码与制品更新后，必须在 Web 对目标主机点一次「升级 hostd」并重启**，预检才会生效；旧 hostd 仍只会回传原始 EEXIST 输出。
- Mac-mini（`jin@100.96.156.60`）的现成处置（升级 hostd 后重新点部署前执行）:
  ```sh
  mv ~/.local/bin/codex  ~/.local/bin/codex.codex-cli.bak
  mv ~/.local/bin/claude ~/.local/bin/claude.native.bak
  ```
  再把 codex / claude 各部署一次。`codex` 被 `codex-cli` 占名也可改 `npm uninstall -g codex-cli`（需先确认不再使用该旧包）。
- `~/.npmrc` 中 `electron_mirror` 等未知键警告无害，可忽略；与本次失败无关。
