#!/usr/bin/env bash
set -euo pipefail

node_modules/.bin/tsc -b tsconfig.json
# tsdown packages from lib/types/index.js (compiled output), so a stale lib/
# ships old code with a silent success. Fail here if any entry is older than the
# src it was compiled from. No-op when lib/ is freshly built by tsc above.
node scripts/check-freshness.mjs
node --import tsx/esm scripts/build.ts
node scripts/verify-build.mjs
