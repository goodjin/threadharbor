#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "$0")/.." && pwd)"
reference_dir="$root_dir/reference/deepseek-harness"
reference_ref="${DSH_REFERENCE_REF:-master}"

if [[ -d "$reference_dir/.git" ]]; then
  git -C "$reference_dir" fetch --prune origin
  git -C "$reference_dir" checkout --detach "$reference_ref"
  exit 0
fi

mkdir -p "$(dirname "$reference_dir")"
git clone https://github.com/deepseek-ai/deepseek-harness.git "$reference_dir"
git -C "$reference_dir" checkout --detach "$reference_ref"
