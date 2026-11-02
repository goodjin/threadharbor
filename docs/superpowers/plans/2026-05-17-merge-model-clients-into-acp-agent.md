# Merge zcode-acp + minimaxi-acp into dsh-acp-agent

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge `zcode-acp` and `minimaxi-acp` into `dsh-acp-agent` as subdirectories, eliminating two separate packages.

**Architecture:** Move the source files from `packages/zcode-acp/src/` and `packages/minimaxi-acp/src/` into `packages/dsh-acp-agent/src/zcode/` and `packages/dsh-acp-agent/src/minimaxi/`. Update `dsh-acp-agent/src/index.ts` to re-export their public API. Update all consumers in `dsh-preset-dispatch` to import from the new paths. Delete the two old packages.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest

**Spec:** No formal spec; derived from the brainstorming conversation on 2026-05-17.

## Global Constraints

- All existing tests must continue to pass after each task.
- Public API exports from `zcode-acp` and `minimaxi-acp` must remain available through `dsh-acp-agent`'s barrel export.
- The `@threadharbor/zcode-acp` and `@threadharbor/minimaxi-acp` package names must remain resolvable during transition (via package.json `exports` redirects in `dsh-preset-dispatch`).
- `proper-lockfile` dependency (used by minimaxi-acp) moves to `dsh-acp-agent`'s dependencies.

## Review Focus

- **Vendored files must not be modified:** `packages/minimaxi-acp/src/vendor/` contains third-party code with PROVENANCE.md tracking. Moving it must not alter file contents.
- **Circular imports:** After merging, `dsh-acp-agent` gains `node:crypto` and `node:fs` usage (from zcode credential decryption and minimaxi OAuth). These must not accidentally leak into browser-facing code paths.
- **Export name collisions:** `messagesUrl` exists in both zcode (`anthropic.ts`) and minimaxi (`credential.ts`). They have different signatures. The barrel re-export must disambiguate.
- **Test mocks:** `dsh-preset-dispatch/tests/model-plugin-pairing.spec.ts` uses `vi.mock('@threadharbor/zcode-acp', ...)`. After migration, the mock target must still resolve.

---

### Task 1: Move zcode-acp source into dsh-acp-agent

**Files:**
- Create: `packages/dsh-acp-agent/src/zcode/credential.ts`
- Create: `packages/dsh-acp-agent/src/zcode/anthropic.ts`
- Create: `packages/dsh-acp-agent/src/zcode/glm.ts`
- Create: `packages/dsh-acp-agent/src/zcode/quota.ts`
- Create: `packages/dsh-acp-agent/src/zcode/sse.ts`
- Create: `packages/dsh-acp-agent/src/zcode/index.ts`

**Interfaces:**
- Produces: All zcode public API symbols re-exported from `dsh-acp-agent/src/zcode/index.ts`:
  - `decryptCredential`, `deriveKey`, `loadApiKey` from `./credential.ts`
  - `BIGMODEL_CODING_PLAN_BASE`, `ZAI_CODING_PLAN_BASE`, `buildAnthropicBody`, `messagesUrl`, `reasoningFields`, `AnthropicBody`, `PromptInput`, `PromptTool` from `./anthropic.ts`
  - `streamGlm`, `scrub`, `GlmRequest` from `./glm.ts`
  - `fetchCodingPlanQuota`, `parseQuotaLimits`, `quotaUrl`, `GlmCodingPlanQuota`, `GlmQuotaRequest`, `GlmQuotaWindow` from `./quota.ts`
  - `GlmBlock`, `GlmFinish`, `GlmStreamChunk`, `GlmUsage` from `./sse.ts`

- [ ] **Step 1: Copy source files**

Copy each file from `packages/zcode-acp/src/` to `packages/dsh-acp-agent/src/zcode/`, preserving exact contents. Create `packages/dsh-acp-agent/src/zcode/index.ts` as a barrel that re-exports everything:

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

- [ ] **Step 2: Add proper-lockfile dependency to dsh-acp-agent (for minimaxi, needed later)**

Skip — this task is zcode only. Add `proper-lockfile` in Task 2.

- [ ] **Step 3: Run typecheck to verify no import errors within dsh-acp-agent**

Run: `cd /Users/good/github/threadharbor && npx tsc -b packages/dsh-acp-agent/tsconfig.json --noEmit 2>&1 | head -20`
Expected: No errors (the new files are self-contained, no cross-package imports yet).

- [ ] **Step 4: Commit**

```bash
git add packages/dsh-acp-agent/src/zcode/
git commit -m "refactor: move zcode-acp source into dsh-acp-agent/src/zcode"
```

---

### Task 2: Move minimaxi-acp source into dsh-acp-agent

**Files:**
- Create: `packages/dsh-acp-agent/src/minimaxi/credential.ts`
- Create: `packages/dsh-acp-agent/src/minimaxi/anthropic.ts`
- Create: `packages/dsh-acp-agent/src/minimaxi/minimax.ts`
- Create: `packages/dsh-acp-agent/src/minimaxi/quota.ts`
- Create: `packages/dsh-acp-agent/src/minimaxi/sse.ts`
- Create: `packages/dsh-acp-agent/src/minimaxi/index.ts`
- Create: `packages/dsh-acp-agent/src/minimaxi/vendor/` (entire vendor tree)
- Modify: `packages/dsh-acp-agent/package.json` — add `proper-lockfile` dependency
- Modify: `packages/dsh-acp-agent/tsconfig.json` — include new subdirectories

**Interfaces:**
- Produces: All minimaxi public API symbols re-exported from `dsh-acp-agent/src/minimaxi/index.ts`:
  - `detectNamespace`, `messagesUrl`, `resolveCredential`, `resolveDataDir`, `CredentialOverrides`, `DataDirOptions`, `MiniMaxCredential`, `AuthBuildEnv`, `AuthRegion` from `./credential.ts`
  - `buildAnthropicBody`, `defaultMaxTokens`, `reasoningFields`, `AnthropicBody`, `Effort`, `PromptInput`, `PromptTool` from `./anthropic.ts`
  - `streamMiniMax`, `scrub`, `MiniMaxRequest` from `./minimax.ts`
  - `fetchMiniMaxQuota`, `MiniMaxCodingPlanQuota`, `MiniMaxCredit`, `MiniMaxQuotaRequest`, `MiniMaxQuotaWindow` from `./quota.ts`
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

Edit `packages/dsh-acp-agent/package.json` to add:
```json
"dependencies": {
  "proper-lockfile": "^4.1.2"
}
```

- [ ] **Step 3: Update tsconfig to include new directories**

The existing `packages/dsh-acp-agent/tsconfig.json` already includes `"src/**/*.ts"`, so the new `zcode/` and `minimaxi/` subdirectories are automatically included. No change needed.

- [ ] **Step 4: Run typecheck**

Run: `cd /Users/good/github/threadharbor && npx tsc -b packages/dsh-acp-agent/tsconfig.json --noEmit 2>&1 | head -30`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-acp-agent/src/minimaxi/ packages/dsh-acp-agent/package.json
git commit -m "refactor: move minimaxi-acp source into dsh-acp-agent/src/minimaxi"
```

---

### Task 3: Re-export zcode and minimaxi from dsh-acp-agent barrel

**Files:**
- Modify: `packages/dsh-acp-agent/src/index.ts`

**Interfaces:**
- Produces: The following additional named exports from `@threadharbor/dsh-acp-agent`:
  - From zcode: `decryptCredential`, `deriveKey`, `loadApiKey`, `BIGMODEL_CODING_PLAN_BASE`, `ZAI_CODING_PLAN_BASE`, `buildAnthropicBody`, `messagesUrl`, `reasoningFields`, `AnthropicBody`, `PromptInput`, `PromptTool`, `streamGlm`, `scrub`, `GlmRequest`, `fetchCodingPlanQuota`, `parseQuotaLimits`, `quotaUrl`, `GlmCodingPlanQuota`, `GlmQuotaRequest`, `GlmQuotaWindow`, `GlmBlock`, `GlmFinish`, `GlmStreamChunk`, `GlmUsage`
  - From minimaxi: `detectNamespace`, `resolveCredential`, `resolveDataDir`, `messagesUrl` (DISAMBIGUATION — see below), `CredentialOverrides`, `DataDirOptions`, `MiniMaxCredential`, `AuthBuildEnv`, `AuthRegion`, `buildAnthropicBody` (DISAMBIGUATION — see below), `defaultMaxTokens`, `reasoningFields` (DISAMBIGUATION — see below), `AnthropicBody` (DISAMBIGUATION — see below), `Effort`, `PromptInput` (DISAMBIGUATION — see below), `PromptTool` (DISAMBIGUATION — see below), `streamMiniMax`, `MiniMaxRequest`, `fetchMiniMaxQuota`, `MiniMaxCodingPlanQuota`, `MiniMaxCredit`, `MiniMaxQuotaRequest`, `MiniMaxQuotaWindow`, `canDisableThinking`, `MINIMAX_MODELS`, `MiniMaxBlock`, `MiniMaxFinish`, `MiniMaxStreamChunk`, `MiniMaxUsage`

  **Disambiguation:** `messagesUrl`, `buildAnthropicBody`, `reasoningFields`, `AnthropicBody`, `PromptInput`, `PromptTool` exist in BOTH zcode and minimaxi with different signatures. The barrel MUST disambiguate:
  - zcode versions: export as-is (they are the originals; existing consumers already use these names)
  - minimaxi versions: export with `MiniMax` prefix → `miniMaxMessagesUrl`, `miniMaxBuildAnthropicBody`, `miniMaxReasoningFields`, `MiniMaxAnthropicBody`, `MiniMaxPromptInput`, `miniMaxPromptTool`

  Exception: `messagesUrl` from minimaxi is NOT re-exported at all — it is an internal helper only used by `streamMiniMax`, which is already the exported entry point.

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
Expected: FAIL — `acp.resolveCredential` is undefined, etc.

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
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-acp-agent/src/index.ts packages/dsh-acp-agent/tests/merged-exports.spec.ts
git commit -m "feat: re-export zcode and minimaxi from dsh-acp-agent barrel"
```

---

### Task 4: Update dsh-preset-dispatch imports to use dsh-acp-agent

**Files:**
- Modify: `packages/dsh-preset-dispatch/src/model-plugins.ts`
- Modify: `packages/dsh-preset-dispatch/src/zcode-model.ts`
- Modify: `packages/dsh-preset-dispatch/src/minimaxi-model.ts`
- Modify: `packages/dsh-preset-dispatch/src/catalog.ts`
- Modify: `packages/dsh-preset-dispatch/src/zcode-quota.ts`
- Modify: `packages/dsh-preset-dispatch/src/minimaxi-quota.ts`
- Modify: `packages/dsh-preset-dispatch/package.json`
- Modify: `packages/dsh-preset-dispatch/tests/model-plugin-pairing.spec.ts`
- Modify: `packages/dsh-preset-dispatch/tests/zcode-quota.spec.ts`
- Modify: `packages/dsh-preset-dispatch/tests/minimaxi-quota.spec.ts`
- Modify: `packages/dsh-preset-dispatch/tests/tool-pairing.spec.ts`

**Interfaces:**
- Consumes: All zcode/minimaxi symbols from `@threadharbor/dsh-acp-agent` (Task 3 exports)
- Produces: No new public API; internal import paths change only.

- [ ] **Step 1: Update zcode-model.ts imports**

In `packages/dsh-preset-dispatch/src/zcode-model.ts`, change:
```ts
import { streamGlm } from '@threadharbor/zcode-acp'
import type { GlmStreamChunk } from '@threadharbor/zcode-acp'
```
to:
```ts
import { streamGlm } from '@threadharbor/dsh-acp-agent'
import type { GlmStreamChunk } from '@threadharbor/dsh-acp-agent'
```

- [ ] **Step 2: Update minimaxi-model.ts imports**

In `packages/dsh-preset-dispatch/src/minimaxi-model.ts`, change:
```ts
import { streamMiniMax } from '@threadharbor/minimaxi-acp'
import type { MiniMaxStreamChunk } from '@threadharbor/minimaxi-acp'
```
to:
```ts
import { streamMiniMax } from '@threadharbor/dsh-acp-agent'
import type { MiniMaxStreamChunk } from '@threadharbor/dsh-acp-agent'
```

- [ ] **Step 3: Update model-plugins.ts imports**

In `packages/dsh-preset-dispatch/src/model-plugins.ts`, change:
```ts
import type { MiniMaxStreamChunk } from '@threadharbor/minimaxi-acp'
import type { GlmStreamChunk } from '@threadharbor/zcode-acp'
```
to:
```ts
import type { MiniMaxStreamChunk } from '@threadharbor/dsh-acp-agent'
import type { GlmStreamChunk } from '@threadharbor/dsh-acp-agent'
```

- [ ] **Step 4: Update catalog.ts imports**

In `packages/dsh-preset-dispatch/src/catalog.ts`, change:
```ts
import type { GlmStreamChunk } from '@threadharbor/zcode-acp'
```
to:
```ts
import type { GlmStreamChunk } from '@threadharbor/dsh-acp-agent'
```

- [ ] **Step 5: Update zcode-quota.ts imports**

In `packages/dsh-preset-dispatch/src/zcode-quota.ts`, change:
```ts
import { fetchCodingPlanQuota } from '@threadharbor/zcode-acp'
import type { GlmCodingPlanQuota } from '@threadharbor/zcode-acp'
```
to:
```ts
import { fetchCodingPlanQuota } from '@threadharbor/dsh-acp-agent'
import type { GlmCodingPlanQuota } from '@threadharbor/dsh-acp-agent'
```

- [ ] **Step 6: Update minimaxi-quota.ts imports**

In `packages/dsh-preset-dispatch/src/minimaxi-quota.ts`, change:
```ts
import { fetchMiniMaxQuota } from '@threadharbor/minimaxi-acp'
import type { MiniMaxCodingPlanQuota } from '@threadharbor/minimaxi-acp'
```
to:
```ts
import { fetchMiniMaxQuota } from '@threadharbor/dsh-acp-agent'
import type { MiniMaxCodingPlanQuota } from '@threadharbor/dsh-acp-agent'
```

- [ ] **Step 7: Update test mock imports**

In `packages/dsh-preset-dispatch/tests/model-plugin-pairing.spec.ts`, change:
```ts
vi.mock('@threadharbor/minimaxi-acp', () => ({
  streamMiniMax: (request: Sent) => { ... },
}))

vi.mock('@threadharbor/zcode-acp', () => ({
  streamGlm: (request: Sent) => { ... },
}))
```
to:
```ts
vi.mock('@threadharbor/dsh-acp-agent', () => ({
  streamMiniMax: (request: Sent) => { ... },
  streamGlm: (request: Sent) => { ... },
}))
```

In `packages/dsh-preset-dispatch/tests/zcode-quota.spec.ts`, change:
```ts
import type { GlmCodingPlanQuota } from '@threadharbor/zcode-acp'
```
to:
```ts
import type { GlmCodingPlanQuota } from '@threadharbor/dsh-acp-agent'
```

In `packages/dsh-preset-dispatch/tests/minimaxi-quota.spec.ts`, change:
```ts
import type { MiniMaxCodingPlanQuota } from '@threadharbor/minimaxi-acp'
```
to:
```ts
import type { MiniMaxCodingPlanQuota } from '@threadharbor/dsh-acp-agent'
```

In `packages/dsh-preset-dispatch/tests/tool-pairing.spec.ts`, change:
```ts
import { buildAnthropicBody } from '@threadharbor/minimaxi-acp'
```
to:
```ts
import { miniMaxBuildAnthropicBody as buildAnthropicBody } from '@threadharbor/dsh-acp-agent'
```

- [ ] **Step 8: Update package.json dependencies**

In `packages/dsh-preset-dispatch/package.json`:
- Remove: `"@threadharbor/zcode-acp": "workspace:^"` and `"@threadharbor/minimaxi-acp": "workspace:^"` from `dependencies`
- Ensure `"@threadharbor/dsh-acp-agent": "workspace:^"` is present in `dependencies` (it already is)

- [ ] **Step 9: Run typecheck for dsh-preset-dispatch**

Run: `cd /Users/good/github/threadharbor && npx tsc -b packages/dsh-preset-dispatch/tsconfig.json --noEmit 2>&1 | head -20`
Expected: No errors.

- [ ] **Step 10: Run all dsh-preset-dispatch tests**

Run: `cd /Users/good/github/threadharbor && npx vitest run packages/dsh-preset-dispatch/tests/ 2>&1 | tail -20`
Expected: All tests pass.

- [ ] **Step 11: Commit**

```bash
git add packages/dsh-preset-dispatch/
git commit -m "refactor: update dsh-preset-dispatch imports to use dsh-acp-agent for model clients"
```

---

### Task 5: Remove old packages and update workspace config

**Files:**
- Delete: `packages/zcode-acp/` (entire directory)
- Delete: `packages/minimaxi-acp/` (entire directory)
- Modify: `tsconfig.base.json` — remove path aliases for old packages
- Modify: `pnpm-workspace.yaml` — no change needed (uses `packages/*` glob)
- Modify: `package.json` (root) — no change needed (no direct dependency on old packages)

**Interfaces:**
- Consumes: Nothing new.
- Produces: Clean workspace with 6 packages instead of 8.

- [ ] **Step 1: Run full typecheck to confirm no remaining references**

Run: `cd /Users/good/github/threadharbor && npx tsc -b tsconfig.json --noEmit 2>&1 | head -30`
Expected: No errors. If there are, they indicate missed import references — fix them before proceeding.

- [ ] **Step 2: Run full test suite**

Run: `cd /Users/good/github/threadharbor && npx vitest run 2>&1 | tail -30`
Expected: All tests pass.

- [ ] **Step 3: Remove path aliases from tsconfig.base.json**

In `tsconfig.base.json`, remove these lines from `paths`:
```json
"@threadharbor/zcode-acp": ["packages/zcode-acp/src/index.ts"],
"@threadharbor/minimaxi-acp": ["packages/minimaxi-acp/src/index.ts"]
```

- [ ] **Step 4: Delete old package directories**

```bash
rm -rf packages/zcode-acp
rm -rf packages/minimaxi-acp
```

- [ ] **Step 5: Reinstall dependencies**

Run: `cd /Users/good/github/threadharbor && pnpm install 2>&1 | tail -5`
Expected: Clean install, no errors.

- [ ] **Step 6: Run full typecheck again**

Run: `cd /Users/good/github/threadharbor && npx tsc -b tsconfig.json --noEmit 2>&1 | head -30`
Expected: No errors.

- [ ] **Step 7: Run full test suite again**

Run: `cd /Users/good/github/threadharbor && npx vitest run 2>&1 | tail -30`
Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: remove zcode-acp and minimaxi-acp packages, merged into dsh-acp-agent"
```

---

### Task 6: Update tsconfig.json references and verify build

**Files:**
- Modify: `tsconfig.json` (root) — remove references to deleted packages

**Interfaces:**
- Consumes: Nothing new.
- Produces: Clean build pipeline.

- [ ] **Step 1: Update root tsconfig.json**

In `tsconfig.json`, remove these entries from `references`:
```json
{ "path": "packages/zcode-acp" },
{ "path": "packages/minimaxi-acp" }
```

- [ ] **Step 2: Run full build**

Run: `cd /Users/good/github/threadharbor && npm run build 2>&1 | tail -20`
Expected: Build succeeds with no errors.

- [ ] **Step 3: Run full check (typecheck + test + build)**

Run: `cd /Users/good/github/threadharbor && npm run check 2>&1 | tail -30`
Expected: All three gates pass.

- [ ] **Step 4: Commit**

```bash
git add tsconfig.json
git commit -m "chore: update root tsconfig references after package merge"
```
