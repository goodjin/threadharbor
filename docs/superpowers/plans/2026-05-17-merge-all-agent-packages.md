# Merge all agent packages into dsh-acp-agent

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge `zcode-acp`, `minimaxi-acp`, and `dsh-preset-dispatch` into `dsh-acp-agent`, making it a single self-contained package that provides both the ACP protocol library and the runtime plugin entry points.

**Architecture:** Move all source files into `packages/dsh-acp-agent/src/`. The package gains two subdirectories (`zcode/`, `minimaxi/`) for model clients and absorbs `dsh-preset-dispatch`'s runtime code (entry, plugin, dispatch, catalog, etc.) at the top level. The barrel `index.ts` re-exports everything. Update `cordis.patch.yml` and all consumers. Delete the three old packages.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest

**Spec:** Derived from brainstorming conversation 2026-05-17.

## Global Constraints

- All existing tests must continue to pass after each task.
- The `@threadharbor/dsh-preset-dispatch` package name must remain resolvable during transition via a package.json `exports` redirect, because `cordis.patch.yml` and possibly external configs reference it.
- `@deepseek-ai/schemastery` dependency moves to `dsh-acp-agent` (it was already a dependency of `dsh-preset-dispatch`).
- `proper-lockfile` dependency (used by minimaxi) moves to `dsh-acp-agent`.
- `mermaid` dependency (used by mermaid-asset) moves to `dsh-acp-agent`.
- The DSH bundle entry (`cordis.patch.yml`) references `@threadharbor/dsh-preset-dispatch` for 7 agent presets and several plugin rows. All these references must be updated to `@threadharbor/dsh-acp-agent`.

## Review Focus

- **Vendored files must not be modified:** `packages/minimaxi-acp/src/vendor/` contains third-party code with PROVENANCE.md tracking. Moving it must not alter file contents.
- **Export name collisions:** `messagesUrl`, `buildAnthropicBody`, `reasoningFields`, `AnthropicBody`, `PromptInput`, `PromptTool` exist in both zcode and minimaxi. Disambiguation required.
- **DSH plugin entry contract:** `dsh-preset-dispatch/src/entry.ts` exports `name` and `Config`/`apply` — these are what DSH's loader reads. After merge, they must be exported from `dsh-acp-agent`'s root.
- **Cordis patch references:** `cordis.patch.yml` has 10+ references to `@threadharbor/dsh-preset-dispatch` subpaths (e.g., `./roster-filter`, `./zcode-quota`). Each must be updated.
- **Circular imports:** `dsh-acp-agent` gains `node:http` usage (from quota plugins). These must not leak into the pure library code paths.
- **`verbatimModuleSyntax`:** TypeScript's `verbatimModuleSyntax` is enabled. Type-only imports must use `import type`.

---

### Task 1: Move zcode-acp source into dsh-acp-agent/src/zcode/

**Files:**
- Create: `packages/dsh-acp-agent/src/zcode/credential.ts`
- Create: `packages/dsh-acp-agent/src/zcode/anthropic.ts`
- Create: `packages/dsh-acp-agent/src/zcode/glm.ts`
- Create: `packages/dsh-acp-agent/src/zcode/quota.ts`
- Create: `packages/dsh-acp-agent/src/zcode/sse.ts`
- Create: `packages/dsh-acp-agent/src/zcode/index.ts`

**Interfaces:**
- Produces: Zcode public API re-exported from `./zcode/index.ts`:
  - `decryptCredential`, `deriveKey`, `loadApiKey` from `./credential.ts`
  - `BIGMODEL_CODING_PLAN_BASE`, `ZAI_CODING_PLAN_BASE`, `buildAnthropicBody`, `messagesUrl`, `reasoningFields`, `AnthropicBody`, `PromptInput`, `PromptTool` from `./anthropic.ts`
  - `streamGlm`, `scrub`, `GlmRequest` from `./glm.ts`
  - `fetchCodingPlanQuota`, `parseQuotaLimits`, `quotaUrl`, `GlmCodingPlanQuota`, `GlmQuotaRequest`, `GlmQuotaWindow` from `./quota.ts`
  - `GlmBlock`, `GlmFinish`, `GlmStreamChunk`, `GlmUsage` from `./sse.ts`

- [ ] **Step 1: Copy source files**

Copy each file from `packages/zcode-acp/src/` to `packages/dsh-acp-agent/src/zcode/`, preserving exact contents. Create `packages/dsh-acp-agent/src/zcode/index.ts` as a barrel:

```ts
export { decryptCredential, deriveKey, loadApiKey } from './credential.ts'
export { BIGMODEL_CODING_PLAN_BASE, ZAI_CODING_PLAN_BASE, buildAnthropicBody, messagesUrl, reasoningFields } from './anthropic.ts'
export type { AnthropicBody, PromptInput, PromptTool } from './anthropic.ts'
export { streamGlm, scrub } from './glm.ts'
export type { GlmRequest } from './glm.ts'
export { fetchCodingPlanQuota, parseQuotaLimits, quotaUrl } from './quota.ts'
export type { GlmCodingPlanQuota, GlmQuotaRequest, GlmQuotaWindow } from './quota.ts'
export type { GlmBlock, GlmFinish, GlmStreamChunk, GlmUsage } from './sse.ts'
```

- [ ] **Step 2: Run typecheck**

Run: `cd /Users/good/github/threadharbor && npx tsc -b packages/dsh-acp-agent/tsconfig.json --noEmit 2>&1 | head -20`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add packages/dsh-acp-agent/src/zcode/
git commit -m "refactor: move zcode-acp source into dsh-acp-agent/src/zcode"
```

---

### Task 2: Move minimaxi-acp source into dsh-acp-agent/src/minimaxi/

**Files:**
- Create: `packages/dsh-acp-agent/src/minimaxi/credential.ts`
- Create: `packages/dsh-acp-agent/src/minimaxi/anthropic.ts`
- Create: `packages/dsh-acp-agent/src/minimaxi/minimax.ts`
- Create: `packages/dsh-acp-agent/src/minimaxi/quota.ts`
- Create: `packages/dsh-acp-agent/src/minimaxi/sse.ts`
- Create: `packages/dsh-acp-agent/src/minimaxi/index.ts`
- Create: `packages/dsh-acp-agent/src/minimaxi/vendor/` (entire vendor tree)
- Modify: `packages/dsh-acp-agent/package.json` — add `proper-lockfile` dependency

**Interfaces:**
- Produces: Minimaxi public API re-exported from `./minimaxi/index.ts`:
  - `detectNamespace`, `resolveCredential`, `resolveDataDir`, `messagesUrl`, `CredentialOverrides`, `DataDirOptions`, `MiniMaxCredential`, `AuthBuildEnv`, `AuthRegion` from `./credential.ts`
  - `buildAnthropicBody`, `defaultMaxTokens`, `reasoningFields`, `AnthropicBody`, `Effort`, `PromptInput`, `PromptTool` from `./anthropic.ts`
  - `streamMiniMax`, `scrub`, `MiniMaxRequest` from `./minimax.ts`
  - `fetchMiniMaxQuota`, `MiniMaxCodingPlanQuota`, `MiniMaxCredit`, `MiniMaxQuotaRequest`, `MiniMaxQuotaWindow` from `./quota.ts`
  - `MiniMaxBlock`, `MiniMaxFinish`, `MiniMaxStreamChunk`, `MiniMaxUsage` from `./sse.ts`
  - `canDisableThinking`, `MINIMAX_MODELS` from `./vendor/mcode-runtime/model-catalog.ts`

- [ ] **Step 1: Copy source files including vendor tree**

Copy all files from `packages/minimaxi-acp/src/` to `packages/dsh-acp-agent/src/minimaxi/`, preserving exact contents including the entire `vendor/` subtree. Create `packages/dsh-acp-agent/src/minimaxi/index.ts` as a barrel:

```ts
export { detectNamespace, messagesUrl, resolveCredential, resolveDataDir } from './credential.ts'
export type { CredentialOverrides, DataDirOptions, MiniMaxCredential } from './credential.ts'
export type { AuthBuildEnv, AuthRegion } from './credential.ts'
export { buildAnthropicBody, defaultMaxTokens, reasoningFields } from './anthropic.ts'
export type { AnthropicBody, Effort, PromptInput, PromptTool } from './anthropic.ts'
export { streamMiniMax, scrub } from './minimax.ts'
export type { MiniMaxRequest } from './minimax.ts'
export { fetchMiniMaxQuota } from './quota.ts'
export type { MiniMaxCodingPlanQuota, MiniMaxCredit, MiniMaxQuotaRequest, MiniMaxQuotaWindow } from './quota.ts'
export type { MiniMaxBlock, MiniMaxFinish, MiniMaxStreamChunk, MiniMaxUsage } from './sse.ts'
export { canDisableThinking, MINIMAX_MODELS } from './vendor/mcode-runtime/model-catalog.ts'
```

- [ ] **Step 2: Add proper-lockfile to dsh-acp-agent dependencies**

Edit `packages/dsh-acp-agent/package.json` to add a `dependencies` field:
```json
"dependencies": {
  "proper-lockfile": "^4.1.2"
}
```

- [ ] **Step 3: Run typecheck**

Run: `cd /Users/good/github/threadharbor && npx tsc -b packages/dsh-acp-agent/tsconfig.json --noEmit 2>&1 | head -30`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add packages/dsh-acp-agent/src/minimaxi/ packages/dsh-acp-agent/package.json
git commit -m "refactor: move minimaxi-acp source into dsh-acp-agent/src/minimaxi"
```

---

### Task 3: Re-export zcode and minimaxi from dsh-acp-agent barrel

**Files:**
- Modify: `packages/dsh-acp-agent/src/index.ts`
- Create: `packages/dsh-acp-agent/tests/merged-exports.spec.ts`

**Interfaces:**
- Produces: Additional named exports from `@threadharbor/dsh-acp-agent`:
  - From zcode (un-prefixed): `decryptCredential`, `deriveKey`, `loadApiKey`, `BIGMODEL_CODING_PLAN_BASE`, `ZAI_CODING_PLAN_BASE`, `buildAnthropicBody`, `messagesUrl`, `reasoningFields`, `AnthropicBody`, `PromptInput`, `PromptTool`, `streamGlm`, `scrub`, `GlmRequest`, `fetchCodingPlanQuota`, `parseQuotaLimits`, `quotaUrl`, `GlmCodingPlanQuota`, `GlmQuotaRequest`, `GlmQuotaWindow`, `GlmBlock`, `GlmFinish`, `GlmStreamChunk`, `GlmUsage`
  - From minimaxi (MiniMax-prefixed for collisions): `miniMaxBuildAnthropicBody`, `miniMaxReasoningFields`, `miniMaxMessagesUrl`, `MiniMaxAnthropicBody`, `MiniMaxPromptInput`, `miniMaxPromptTool`
  - From minimaxi (un-prefixed, no collision): `detectNamespace`, `resolveCredential`, `resolveDataDir`, `CredentialOverrides`, `DataDirOptions`, `MiniMaxCredential`, `AuthBuildEnv`, `AuthRegion`, `defaultMaxTokens`, `Effort`, `streamMiniMax`, `MiniMaxRequest`, `fetchMiniMaxQuota`, `MiniMaxCodingPlanQuota`, `MiniMaxCredit`, `MiniMaxQuotaRequest`, `MiniMaxQuotaWindow`, `MiniMaxBlock`, `MiniMaxFinish`, `MiniMaxStreamChunk`, `MiniMaxUsage`, `canDisableThinking`, `MINIMAX_MODELS`

- [ ] **Step 1: Write the disambiguation test**

Create `packages/dsh-acp-agent/tests/merged-exports.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import * as acp from '../src/index.ts'

describe('merged exports', () => {
  it('exports zcode symbols', () => {
    expect(typeof acp.decryptCredential).toBe('function')
    expect(typeof acp.streamGlm).toBe('function')
    expect(typeof acp.fetchCodingPlanQuota).toBe('function')
    expect(typeof acp.BIGMODEL_CODING_PLAN_BASE).toBe('string')
  })

  it('exports minimaxi symbols', () => {
    expect(typeof acp.resolveCredential).toBe('function')
    expect(typeof acp.streamMiniMax).toBe('function')
    expect(typeof acp.fetchMiniMaxQuota).toBe('function')
    expect(typeof acp.canDisableThinking).toBe('function')
  })

  it('disambiguates shared names with MiniMax prefix', () => {
    expect(typeof acp.miniMaxBuildAnthropicBody).toBe('function')
    expect(typeof acp.miniMaxReasoningFields).toBe('function')
    expect(typeof acp.miniMaxMessagesUrl).toBe('function')
    expect(acp.MiniMaxAnthropicBody).toBeDefined()
    expect(acp.MiniMaxPromptInput).toBeDefined()
    expect(acp.miniMaxPromptTool).toBeDefined()
  })

  it('zcode exports remain un-prefixed', () => {
    expect(typeof acp.buildAnthropicBody).toBe('function')
    expect(typeof acp.reasoningFields).toBe('function')
    expect(typeof acp.messagesUrl).toBe('function')
    expect(acp.AnthropicBody).toBeDefined()
    expect(acp.PromptInput).toBeDefined()
    expect(acp.PromptTool).toBeDefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/good/github/threadharbor && npx vitest run packages/dsh-acp-agent/tests/merged-exports.spec.ts 2>&1 | tail -10`
Expected: FAIL.

- [ ] **Step 3: Add re-exports to dsh-acp-agent/src/index.ts**

Append to `packages/dsh-acp-agent/src/index.ts`:

```ts
// ─── GLM (ZCode) model client ────────────────────────────────────────────────
export {
  decryptCredential,
  deriveKey,
  loadApiKey,
} from './zcode/credential.ts'
export {
  BIGMODEL_CODING_PLAN_BASE,
  ZAI_CODING_PLAN_BASE,
  buildAnthropicBody,
  messagesUrl,
  reasoningFields,
} from './zcode/anthropic.ts'
export type { AnthropicBody, PromptInput, PromptTool } from './zcode/anthropic.ts'
export { streamGlm, scrub } from './zcode/glm.ts'
export type { GlmRequest } from './zcode/glm.ts'
export { fetchCodingPlanQuota, parseQuotaLimits, quotaUrl } from './zcode/quota.ts'
export type { GlmCodingPlanQuota, GlmQuotaRequest, GlmQuotaWindow } from './zcode/quota.ts'
export type { GlmBlock, GlmFinish, GlmStreamChunk, GlmUsage } from './zcode/sse.ts'

// ─── MiniMax model client ────────────────────────────────────────────────────
export {
  detectNamespace,
  resolveCredential,
  resolveDataDir,
} from './minimaxi/credential.ts'
export type { CredentialOverrides, DataDirOptions, MiniMaxCredential, AuthBuildEnv, AuthRegion } from './minimaxi/credential.ts'
// Disambiguate: these names collide with zcode exports above.
export {
  buildAnthropicBody as miniMaxBuildAnthropicBody,
  defaultMaxTokens,
  reasoningFields as miniMaxReasoningFields,
  messagesUrl as miniMaxMessagesUrl,
} from './minimaxi/anthropic.ts'
export type { AnthropicBody as MiniMaxAnthropicBody, Effort, PromptInput as MiniMaxPromptInput, PromptTool as miniMaxPromptTool } from './minimaxi/anthropic.ts'
export { streamMiniMax, scrub } from './minimaxi/minimax.ts'
export type { MiniMaxRequest } from './minimaxi/minimax.ts'
export { fetchMiniMaxQuota } from './minimaxi/quota.ts'
export type { MiniMaxCodingPlanQuota, MiniMaxCredit, MiniMaxQuotaRequest, MiniMaxQuotaWindow } from './minimaxi/quota.ts'
export type { MiniMaxBlock, MiniMaxFinish, MiniMaxStreamChunk, MiniMaxUsage } from './minimaxi/sse.ts'
export { canDisableThinking, MINIMAX_MODELS } from './minimaxi/vendor/mcode-runtime/model-catalog.ts'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/good/github/threadharbor && npx vitest run packages/dsh-acp-agent/tests/merged-exports.spec.ts 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-acp-agent/src/index.ts packages/dsh-acp-agent/tests/merged-exports.spec.ts
git commit -m "feat: re-export zcode and minimaxi from dsh-acp-agent barrel"
```

---

### Task 4: Move dsh-preset-dispatch runtime code into dsh-acp-agent

**Files:**
- Create: `packages/dsh-acp-agent/src/entry.ts` (from dsh-preset-dispatch)
- Create: `packages/dsh-acp-agent/src/plugin.ts`
- Create: `packages/dsh-acp-agent/src/dispatch.ts`
- Create: `packages/dsh-acp-agent/src/registry.ts`
- Create: `packages/dsh-acp-agent/src/factory.ts`
- Create: `packages/dsh-acp-agent/src/runner.ts`
- Create: `packages/dsh-acp-agent/src/stream.ts`
- Create: `packages/dsh-acp-agent/src/catalog.ts`
- Create: `packages/dsh-acp-agent/src/catalog-registration.ts`
- Create: `packages/dsh-acp-agent/src/switch.ts`
- Create: `packages/dsh-acp-agent/src/switch-plan.ts`
- Create: `packages/dsh-acp-agent/src/switch-mount.ts`
- Create: `packages/dsh-acp-agent/src/switch-shared.ts`
- Create: `packages/dsh-acp-agent/src/apply-plan.ts`
- Create: `packages/dsh-acp-agent/src/follow.ts`
- Create: `packages/dsh-acp-agent/src/handover.ts`
- Create: `packages/dsh-acp-agent/src/selection.ts`
- Create: `packages/dsh-acp-agent/src/gateway.ts`
- Create: `packages/dsh-acp-agent/src/gateway-feed.ts`
- Create: `packages/dsh-acp-agent/src/service.ts`
- Create: `packages/dsh-acp-agent/src/host-filter.ts`
- Create: `packages/dsh-acp-agent/src/content-writer.ts`
- Create: `packages/dsh-acp-agent/src/approval-bridge.ts`
- Create: `packages/dsh-acp-agent/src/question-bridge.ts`
- Create: `packages/dsh-acp-agent/src/step-position.ts`
- Create: `packages/dsh-acp-agent/src/agent-progress.ts`
- Create: `packages/dsh-acp-agent/src/subagent-sessions.ts`
- Create: `packages/dsh-acp-agent/src/model-plugins.ts`
- Create: `packages/dsh-acp-agent/src/model-plugins-zcode.ts`
- Create: `packages/dsh-acp-agent/src/model-plugins-minimaxi.ts`
- Create: `packages/dsh-acp-agent/src/zcode-model.ts`
- Create: `packages/dsh-acp-agent/src/minimaxi-model.ts`
- Create: `packages/dsh-acp-agent/src/zcode-quota.ts`
- Create: `packages/dsh-acp-agent/src/minimaxi-quota.ts`
- Create: `packages/dsh-acp-agent/src/roster-filter.ts`
- Create: `packages/dsh-acp-agent/src/roster-marks.ts`
- Create: `packages/dsh-acp-agent/src/mermaid-asset.ts`
- Create: `packages/dsh-acp-agent/src/tool-pairing.ts`
- Create: `packages/dsh-acp-agent/src/replay.ts`
- Create: `packages/dsh-acp-agent/src/session-lifecycle.ts`
- Create: `packages/dsh-acp-agent/src/dispatch.ts`
- (All test files from `packages/dsh-preset-dispatch/tests/` → `packages/dsh-acp-agent/tests/`)
- Modify: `packages/dsh-acp-agent/package.json` — add `@deepseek-ai/schemastery` and `mermaid` dependencies
- Modify: `packages/dsh-acp-agent/tsconfig.json` — no change needed (already `src/**/*.ts`)

**Important: Import path rewrites.** Every file that imported from `@threadharbor/dsh-acp-agent` (the old pure library) must now use relative imports (`./client.ts`, `./transport.ts`, etc.) since the code is in the same package. Every file that imported from `@threadharbor/zcode-acp` or `@threadharbor/minimaxi-acp` must now import from `./zcode/index.ts` or `./minimaxi/index.ts` (or the barrel `../index.ts`).

- [ ] **Step 1: Copy all source files from dsh-preset-dispatch/src/ to dsh-acp-agent/src/**

Copy every `.ts` file (except `index.ts` and `entry.ts`) from `packages/dsh-preset-dispatch/src/` into `packages/dsh-acp-agent/src/`. Copy `entry.ts` as-is.

- [ ] **Step 2: Rewrite imports in all moved files**

For each moved file, apply these import rewrites:
- `@threadharbor/zcode-acp` → `./zcode/index.ts` (or `../zcode/index.ts` if in a subdirectory)
- `@threadharbor/minimaxi-acp` → `./minimaxi/index.ts` (or `../minimaxi/index.ts`)
- `@threadharbor/dsh-acp-agent` (for the old pure library imports) → relative paths within the same package:
  - `from '@threadharbor/dsh-acp-agent'` → `from './index.ts'` (or `from '../index.ts'`)
  - `from '@threadharbor/dsh-acp-agent/client'` → `from './client.ts'`
  - `from '@threadharbor/dsh-acp-agent/transport'` → `from './transport.ts'`
  - etc. — check each specific import and rewrite to the relative path

  **Note:** The existing `dsh-acp-agent/src/index.ts` barrel exports are still valid for external consumers. Internal cross-references between the moved files and the original ACP library files should use relative paths.

- [ ] **Step 3: Copy all test files**

Copy all `.spec.ts` files from `packages/dsh-preset-dispatch/tests/` to `packages/dsh-acp-agent/tests/`. Apply the same import rewrites.

- [ ] **Step 4: Update package.json dependencies**

Edit `packages/dsh-acp-agent/package.json` to add:
```json
"dependencies": {
  "@deepseek-ai/schemastery": "^3.18.1",
  "mermaid": "^11.16.0",
  "proper-lockfile": "^4.1.2"
}
```
(Keep `proper-lockfile` from Task 2.)

- [ ] **Step 5: Run typecheck**

Run: `cd /Users/good/github/threadharbor && npx tsc -b packages/dsh-acp-agent/tsconfig.json --noEmit 2>&1 | head -40`
Expected: No errors. Fix any import path issues.

- [ ] **Step 6: Run all tests**

Run: `cd /Users/good/github/threadharbor && npx vitest run packages/dsh-acp-agent/tests/ 2>&1 | tail -20`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/dsh-acp-agent/
git commit -m "refactor: merge dsh-preset-dispatch runtime code into dsh-acp-agent"
```

---

### Task 5: Make dsh-acp-agent a DSH-loadable plugin and add compatibility exports

**Files:**
- Modify: `packages/dsh-acp-agent/src/entry.ts` — ensure `name` and `Config`/`apply` are correct
- Modify: `packages/dsh-acp-agent/package.json` — add `dsh.bundle.patch` and update exports
- Create: `packages/dsh-acp-agent/src/plugin-exports.ts` — re-export subpath entry points (roster-filter, zcode-quota, etc.)

**Interfaces:**
- Produces: `@threadharbor/dsh-acp-agent` becomes a DSH-loadable plugin with:
  - Root entry: `name = 'threadharbor-acp'`, `Config` schema, `apply(ctx, config)` — from `entry.ts`
  - Subpath exports: `./roster-filter`, `./zcode-quota`, `./minimaxi-quota`, `./codex-quota`, `./claude-quota`, `./mermaid-asset`
  - `dsh.bundle.patch` field pointing to the patch file (or remove it if the patch stays at root)

- [ ] **Step 1: Verify entry.ts exports**

`entry.ts` already exports `name`, `Config`, and `apply`. Verify these are the only top-level exports needed by DSH's loader. If `index.ts` also re-exports them, ensure no conflict.

- [ ] **Step 2: Update package.json**

Edit `packages/dsh-acp-agent/package.json`:
- Change `"main"` from `"./src/index.ts"` to `"./src/entry.ts"` (DSH loads `entry.ts` as the plugin entry)
- OR keep `"main"` as `"./src/index.ts"` and ensure `index.ts` re-exports `name`, `Config`, `apply` from `entry.ts`
- Add subpath exports for the plugin rows that `cordis.patch.yml` references:
```json
"exports": {
  ".": { "types": "./src/index.ts", "default": "./src/index.ts" },
  "./entry": { "types": "./src/entry.ts", "default": "./src/entry.ts" },
  "./roster-filter": { "types": "./src/roster-filter.ts", "default": "./src/roster-filter.ts" },
  "./zcode-quota": { "types": "./src/zcode-quota.ts", "default": "./src/zshcode-quota.ts" },
  "./minimaxi-quota": { "types": "./src/minimaxi-quota.ts", "default": "./src/minimaxi-quota.ts" },
  "./codex-quota": { "types": "./src/codex-quota.ts", "default": "./src/codex-quota.ts" },
  "./claude-quota": { "types": "./src/usage-claude.ts", "default": "./src/usage-claude.ts" },
  "./mermaid-asset": { "types": "./src/mermaid-asset.ts", "default": "./src/mermaid-asset.ts" },
  "./package.json": "./package.json"
}
```
(Note: `codex-quota` and `claude-quota` are files that need to be identified from `dsh-preset-dispatch/src/` — check if they exist as `usage-codex.ts` and `usage-claude.ts`.)

- [ ] **Step 3: Run typecheck and tests**

Run: `cd /Users/good/github/threadharbor && npx tsc -b packages/dsh-acp-agent/tsconfig.json --noEmit 2>&1 | head -20`
Expected: No errors.

Run: `cd /Users/good/github/threadharbor && npx vitest run packages/dsh-acp-agent/tests/ 2>&1 | tail -20`
Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add packages/dsh-acp-agent/package.json packages/dsh-acp-agent/src/
git commit -m "feat: configure dsh-acp-agent as DSH-loadable plugin with subpath exports"
```

---

### Task 6: Update cordis.patch.yml and root package.json

**Files:**
- Modify: `cordis.patch.yml` — replace all `@threadharbor/dsh-preset-dispatch` references with `@threadharbor/dsh-acp-agent`
- Modify: `package.json` (root) — update dependencies

**Interfaces:**
- Consumes: `@threadharbor/dsh-acp-agent` with all subpath exports (Task 5)

- [ ] **Step 1: Update cordis.patch.yml**

Replace every occurrence of:
- `'@threadharbor/dsh-preset-dispatch'` → `'@threadharbor/dsh-acp-agent'`
- `'@threadharbor/dsh-preset-dispatch/roster-filter'` → `'@threadharbor/dsh-acp-agent/roster-filter'`
- `'@threadharbor/dsh-preset-dispatch/zcode-quota'` → `'@threadharbor/dsh-acp-agent/zcode-quota'`
- `'@threadharbor/dsh-preset-dispatch/minimaxi-quota'` → `'@threadharbor/dsh-acp-agent/minimaxi-quota'`
- `'@threadharbor/dsh-preset-dispatch/codex-quota'` → `'@threadharbor/dsh-acp-agent/codex-quota'`
- `'@threadharbor/dsh-preset-dispatch/claude-quota'` → `'@threadharbor/dsh-acp-agent/claude-quota'`
- `'@threadharbor/dsh-preset-dispatch/mermaid-asset'` → `'@threadharbor/dsh-acp-agent/mermaid-asset'`

- [ ] **Step 2: Update root package.json**

In `package.json`, change:
```json
"@threadharbor/dsh-preset-dispatch": "workspace:^"
```
to:
```json
"@threadharbor/dsh-acp-agent": "workspace:^"
```
Remove `"@threadharbor/dsh-client"`, `"@threadharbor/dsh-host-federation"`, `"@threadharbor/dsh-mobile-entry"`, `"@threadharbor/dsh-mobile-relay"` from dependencies (they will be handled in a later task; keep them for now to avoid breaking the build).

Actually, keep all existing dependencies for now. Only change the `dsh-preset-dispatch` → `dsh-acp-agent` swap.

- [ ] **Step 3: Run typecheck**

Run: `cd /Users/good/github/threadharbor && npx tsc -b tsconfig.json --noEmit 2>&1 | head -30`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add cordis.patch.yml package.json
git commit -m "refactor: update cordis.patch.yml and root package.json to use dsh-acp-agent"
```

---

### Task 7: Remove old packages and clean up

**Files:**
- Delete: `packages/zcode-acp/` (entire directory)
- Delete: `packages/minimaxi-acp/` (entire directory)
- Delete: `packages/dsh-preset-dispatch/` (entire directory)
- Modify: `tsconfig.base.json` — remove path aliases for deleted packages
- Modify: `tsconfig.json` (root) — remove references to deleted packages
- Modify: `pnpm-workspace.yaml` — no change needed (uses `packages/*` glob)

**Interfaces:**
- Produces: Clean workspace with 5 packages instead of 8.

- [ ] **Step 1: Run full typecheck to confirm no remaining references**

Run: `cd /Users/good/github/threadharbor && npx tsc -b tsconfig.json --noEmit 2>&1 | head -30`
Expected: No errors. Fix any missed references before proceeding.

- [ ] **Step 2: Run full test suite**

Run: `cd /Users/good/github/threadharbor && npx vitest run 2>&1 | tail -30`
Expected: All tests pass.

- [ ] **Step 3: Update tsconfig.base.json paths**

Remove these lines from `paths`:
```json
"@threadharbor/zcode-acp": ["packages/zcode-acp/src/index.ts"],
"@threadharbor/minimaxi-acp": ["packages/minimaxi-acp/src/index.ts"]
```
Keep `@threadharbor/dsh-acp-agent` path (it now points to the merged package).

- [ ] **Step 4: Update root tsconfig.json references**

Remove these entries from `references`:
```json
{ "path": "packages/zcode-acp" },
{ "path": "packages/minimaxi-acp" },
{ "path": "packages/dsh-preset-dispatch" }
```

- [ ] **Step 5: Delete old package directories**

```bash
rm -rf packages/zcode-acp
rm -rf packages/minimaxi-acp
rm -rf packages/dsh-preset-dispatch
```

- [ ] **Step 6: Reinstall dependencies**

Run: `cd /Users/good/github/threadharbor && pnpm install 2>&1 | tail -5`
Expected: Clean install.

- [ ] **Step 7: Run full typecheck and tests**

Run: `cd /Users/good/github/threadharbor && npx tsc -b tsconfig.json --noEmit 2>&1 | head -20`
Expected: No errors.

Run: `cd /Users/good/github/threadharbor && npx vitest run 2>&1 | tail -20`
Expected: All pass.

- [ ] **Step 8: Run full build**

Run: `cd /Users/good/github/threadharbor && npm run build 2>&1 | tail -20`
Expected: Build succeeds.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: remove zcode-acp, minimaxi-acp, and dsh-preset-dispatch packages"
```

---

### Task 8: Add compatibility exports for external consumers

**Files:**
- Create: `packages/dsh-acp-agent/src/compat-dsh-preset-dispatch.ts` — re-export module that allows `@threadharbor/dsh-preset-dispatch` to still resolve during transition

**Note:** If there are no external consumers of `@threadharbor/dsh-preset-dispatch` outside this monorepo, this task can be skipped. Check first with a grep across the repo.

- [ ] **Step 1: Check for external references**

Run: `cd /Users/good/github/threadharbor && grep -r "dsh-preset-dispatch" --include="*.json" --include="*.yml" --include="*.yaml" --include="*.ts" --include="*.md" . 2>/dev/null | grep -v node_modules | grep -v ".git/" | grep -v "docs/superpowers/"`
Expected: Only `cordis.patch.yml` (already updated) and possibly docs.

- [ ] **Step 2: If external references exist, create compatibility layer**

If any external config or documentation still references `@threadharbor/dsh-preset-dispatch`, create a minimal shim. Otherwise skip.

- [ ] **Step 3: Final verification**

Run: `cd /Users/good/github/threadharbor && npm run check 2>&1 | tail -10`
Expected: typecheck + test + build all pass.

- [ ] **Step 4: Final commit (if any changes)**

```bash
git add -A
git commit -m "chore: final cleanup after package merge"
```
