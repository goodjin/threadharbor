# Bug Fix: 添加项目面板报 `path must be a non-empty string`、无法浏览目录

## 问题描述
- 日期: 2026-09-04
- 严重程度: High（阻塞「新建项目」主路径）
- 影响范围: DSH Web "添加项目" 面板、`AddProjectPanel` 的目录浏览与登记流程

在 Web 端打开"添加项目"面板后立即报错 `Error: path must be a non-empty string`，目录列表不显示，点"浏览目录"按钮也无响应，最终无法创建项目。

## 根因分析
- 问题位置: `packages/hostd/src/server.ts:678`（修复前）
- 原因: hostd 把 `fs.list` 的 `path` 视为**必填**非空字段，而 Web 端把它当作**可选**字段。协议层在 gateway (`fs.list` 透传) 和 store (`fs.list` 主动剥空 `path`) 都按"可选"处理，唯独 hostd 用了 `stringField` 严格校验。

### 代码流程

1. **Web 端 `AddProjectPanel.useEffect`** 在选择主机后自动调用 `browse('', projectHost)`（`RemoteConversation.tsx:779-805`）。
2. **`RemoteAgentStore.listDirectory(hostId, '')`** 看到 `path.trim() === ''`，主动把 `path` 字段从 wire 请求里删掉（`store.ts:1071-1077`）。
3. **`RemoteAgentGateway.listDirectory`** 用 `optionalString(params, 'path')` 取到 `undefined`，转发 `{}` 给 hostd（`dsh-gateway/src/index.ts:1670-1674`）。
4. **`RemoteAgentHostd.listDirectory`** 调用 `stringField(params, 'path')`，命中 `if (typeof value !== 'string' || value.trim() === '') throw new TypeError('path must be a non-empty string')`（`packages/protocol/src/index.ts:520-524`）。
5. 错误沿着 WS 帧回传，UI 用 `String(error)` 渲染成 `Error: path must be a non-empty string`。

为什么 "登记项目" 也跟着失败：面板打开瞬间就在浏览失败，`cwd` 一直是空串，按钮的 `disabled={cwd.trim() === ''}` 永远为真，用户没有机会提交一个非空 `cwd`，所以也"无法创建项目"。

## 修复方案
- 修改文件: `packages/hostd/src/server.ts`
- 修改内容:
  - 新增 `import { homedir } from 'node:os'`。
  - 把 `listDirectory` 里的 `stringField(params, 'path')` 改成 `optionalString(params, 'path')`，缺省或仅含空白时落到 `os.homedir()`。这样契约就跟 gateway / store / Web 保持一致：缺失/空 path 等价于"列用户的家目录"。
  - 把 `if (!statSync(path).isDirectory()) throw new Error(\`not a directory: ${requested}\`)` 的提示路径从 `requested` 改成 `target`，确保错误里出现的是真实传给 `realpathSync` 的字符串。

修改后 hostd 接受这三种合法输入：
- `path` 缺省 / 为 `''` / 全空白 → 列 `$HOME`
- `path` 是合法绝对路径 → 列该目录，正常返回 `parent`
- `path` 不存在 → `realpathSync` 抛 `ENOENT`，错误里带原始路径

## 验证步骤
1. ✅ `packages/hostd/tests/hostd.spec.ts` 新增四个 `RemoteAgentHostd fs.list` 用例（缺省 path → `$HOME`、空白 path → `$HOME`、显式 path → 真实列表 + parent、不存在 path → 抛 `ENOENT` 并带原路径）。
2. ✅ `pnpm test`：227/227 通过（`Test Files 24 passed`）。
3. ✅ `pnpm typecheck`：`tsc -b tsconfig.json` 无报错。
4. ✅ `pnpm build`：四个包全部 `Build complete`。
5. ✅ 真实路径复现脚本（`/tmp/repro-hostd-fslist.mjs`，已清理）通过四种输入的回放：
   - `dispatch({ method: 'fs.list', params: {} })` → `path: '/Users/good', entries.length: 20`
   - `dispatch({ method: 'fs.list', params: { path: '   ' } })` → `path: '/Users/good'`
   - `dispatch({ method: 'fs.list', params: { path: <abs> } })` → 列出真实文件 + `parent`
   - `dispatch({ method: 'fs.list', params: { path: <missing> } })` → 抛 `Error ENOENT ... lstat <missing>`

## 相关测试
- `packages/hostd/tests/hostd.spec.ts` 新增 `describe('RemoteAgentHostd fs.list')`

## 设计建议
- 协议层 `RemoteHostdMethod` 的 `fs.list` 描述应当明确"可选 path"；现在客户端/网关/hostd 三层对契约的理解不一致，是这次 bug 能潜伏的主因（`packages/dsh-gateway/tests/gateway.spec.ts` 和 `packages/hostd/tests/hostd-ws.spec.ts` 之前的 mock 都直接吃掉 `path ?? '/'`，绕过了 hostd 真机的 `stringField` 校验，所以测试绿灯但运行时炸）。
- 后续可以考虑给 hostd 加一个 `--browse-root <dir>`（默认 `$HOME`）配置项，把"DSH Web 能看到哪些目录"做成可在部署时收紧的硬约束，避免默认暴露整个 `$HOME` 到 Web（参考已有的 `--max-directory-entries` 模式）。本次修复先把功能打通，安全收紧放到下一个变更。
