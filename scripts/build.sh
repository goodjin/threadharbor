#!/usr/bin/env bash
set -euo pipefail

node_modules/.bin/tsc -b tsconfig.json
node --import tsx/esm scripts/build.ts
node scripts/verify-build.mjs
