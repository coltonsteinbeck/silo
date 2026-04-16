#!/bin/bash
set -euo pipefail

# Compatibility shim for previous migrate:remote entrypoint.
exec "$(dirname "$0")/migrate.sh" --target remote "$@"
