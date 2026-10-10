#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
  echo 'Release images require a clean, committed checkout.' >&2
  exit 1
fi

commit=$(git rev-parse --verify HEAD)
image=${1:-silo-bot:${commit:0:12}}
git archive --format=tar "$commit" | docker build --build-arg "RELEASE_COMMIT=$commit" -t "$image" -

built_commit=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")
if [[ "$built_commit" != "$commit" ]]; then
  echo 'Built image does not match the committed source revision.' >&2
  exit 1
fi

# Verify the built artifact without credentials, networking, or starting the bot.
git ls-tree -r --name-only "$commit" -- supabase/migrations | \
  docker run --rm -i --network none --read-only --entrypoint bun "$image" --eval '
    import assert from "node:assert/strict";
    import { existsSync } from "node:fs";
    const migrations = (await Bun.stdin.text()).trim().split("\n").filter(Boolean);
    assert(migrations.length > 0, "Committed migrations are missing");
    for (const file of migrations) assert(existsSync(file), `Image is missing ${file}`);
    for (const file of [".env", ".git"]) {
      assert(!existsSync(file), `Image contains private file ${file}`);
    }
  '

printf 'Built %s from %s\n' "$image" "$commit"
