#!/usr/bin/env bash
set -euo pipefail

export YOUTUBE_DL_HOST="https://github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/yt-dlp"

bun install --frozen-lockfile
bun run radio:verify-runtime
