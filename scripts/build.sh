#!/usr/bin/env bash
set -euo pipefail

node_modules/.bin/tsc -b tsconfig.json
# Browser half of the same package: src/client → lib/types/client. Kept out of
# the host tsconfig graph (separate role, jsx + DOM), so it compiles here on its
# own before the client bundle is packaged below.
node_modules/.bin/tsc -p tsconfig.client.json
# tsdown packages from lib/types/index.js (compiled output), so a stale lib/
# ships old code with a silent success. Fail here if any entry is older than the
# src it was compiled from. No-op when lib/ is freshly built by tsc above.
node scripts/check-freshness.mjs
node --import tsx/esm scripts/build.ts
# The browser artifact must self-register with the module loader, ship as one
# file, and carry every export the source declares.
node scripts/verify-client-build.mjs
