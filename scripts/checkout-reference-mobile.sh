#!/usr/bin/env bash
# Vendors the DSH Remote reference sources under reference/ds-harness-remote/.
# Reference material only: not a runtime or build dependency, and the tree is
# git-ignored, so nothing here ships. See docs/mobile-client.zh.md for what we
# borrow from it and what we deliberately do not.
set -euo pipefail

root_dir="$(cd "$(dirname "$0")/.." && pwd)"
reference_dir="$root_dir/reference/ds-harness-remote"
reference_ref="${DSH_MOBILE_REFERENCE_REF:-main}"

if [[ -d "$reference_dir/.git" ]]; then
  git -C "$reference_dir" fetch --prune origin
  git -C "$reference_dir" checkout --detach "origin/$reference_ref"
  exit 0
fi

mkdir -p "$(dirname "$reference_dir")"
git clone https://github.com/liguobao/ds-harness-remote.git "$reference_dir"
git -C "$reference_dir" checkout --detach "origin/$reference_ref"
