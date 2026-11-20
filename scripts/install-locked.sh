#!/usr/bin/env bash
set -euo pipefail

if [[ "$(bun --version)" != "1.4.5" ]]; then
  echo "Silo requires Bun 1.4.5 for dependency installation" >&2
  exit 1
fi

# Native lifecycle scripts commonly invoke `node` through node-pre-gyp. When
# another Node runtime is on PATH, they build for its ABI instead of Bun's.
# Scope this alias to the locked install and remove it even on failure.
bun_binary="$(command -v bun)"
shim_dir="$(mktemp -d)"
trap 'rm -rf "$shim_dir"' EXIT
ln -s "$bun_binary" "$shim_dir/node"
PATH="$shim_dir:$PATH" bun install --frozen-lockfile "$@"
