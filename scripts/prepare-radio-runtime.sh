#!/usr/bin/env bash
set -euo pipefail

export YOUTUBE_DL_HOST="https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp"

bash scripts/install-locked.sh --force
bun run radio:verify-runtime
