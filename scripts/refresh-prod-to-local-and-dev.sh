#!/bin/bash
set -euo pipefail

# Runs two refresh lanes in order:
# 1) prod -> local Supabase docker DB
# 2) prod -> persistent dev branch DB
#
# Required source env (one of):
#   - PROD_DB_URL
#   - HOSTED_DB_IDENTIFIER + SUPABASE_PW
#
# Required branch target env (one of):
#   - TARGET_BRANCH_DB_URL
#   - BRANCH_DB_URL
#   - DEV_DB_IDENTIFIER + SUPABASE_DEV_PW
#
# Required safety env:
#   - CONFIRM_REMOTE_RESTORE=true
#
# Optional:
#   - LOCAL_DB_URL (default: postgresql://postgres:postgres@127.0.0.1:54322/postgres)
#   - DATABASE_LOCAL_URL (alias of LOCAL_DB_URL)
#   - DATABASE_DEV_URL (alias of TARGET_BRANCH_DB_URL/BRANCH_DB_URL)
#   - DATABASE_PROD_URL (alias of SOURCE_DB_URL/PROD_DB_URL)
#   - AUTO_RUN_MIGRATIONS=true|false (default: true)
#   - TRUNCATE_TARGET=true|false (default: true)
#   - REFRESH_ENV_FILE (default: ../.env)

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)
ENV_FILE=${REFRESH_ENV_FILE:-"$SCRIPT_DIR/../.env"}

bool_true() {
  local lowered
  lowered=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  case "$lowered" in
    1|true|yes|y)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$ENV_FILE"
  set +a
fi

CONFIRM_REMOTE_RESTORE=${CONFIRM_REMOTE_RESTORE:-false}
DATABASE_LOCAL_URL=${DATABASE_LOCAL_URL:-}
DATABASE_DEV_URL=${DATABASE_DEV_URL:-}
DATABASE_PROD_URL=${DATABASE_PROD_URL:-}
AUTO_RUN_MIGRATIONS=${AUTO_RUN_MIGRATIONS:-true}
TRUNCATE_TARGET=${TRUNCATE_TARGET:-true}

LOCAL_DB_URL=${LOCAL_DB_URL:-${DATABASE_LOCAL_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}}
TARGET_BRANCH_DB_URL=${TARGET_BRANCH_DB_URL:-${BRANCH_DB_URL:-${DATABASE_DEV_URL:-}}}
SOURCE_DB_URL=${SOURCE_DB_URL:-${PROD_DB_URL:-${DATABASE_PROD_URL:-}}}

if [ "$CONFIRM_REMOTE_RESTORE" != "true" ]; then
  echo "Safety check failed: set CONFIRM_REMOTE_RESTORE=true"
  exit 1
fi

if [ -z "$SOURCE_DB_URL" ]; then
  echo "Error: unable to resolve source DB URL. Set SOURCE_DB_URL, PROD_DB_URL, or DATABASE_PROD_URL."
  exit 1
fi

if [ -z "$TARGET_BRANCH_DB_URL" ]; then
  echo "Error: unable to resolve branch target DB URL. Set TARGET_BRANCH_DB_URL, BRANCH_DB_URL, or DATABASE_DEV_URL."
  exit 1
fi

if bool_true "$AUTO_RUN_MIGRATIONS"; then
  echo "== Pre-step: Run migrations (local, then dev) =="
  bash "$SCRIPT_DIR/migrate.sh" --target local --db-url "$LOCAL_DB_URL"
  bash "$SCRIPT_DIR/migrate.sh" --target dev --db-url "$TARGET_BRANCH_DB_URL"
  echo
fi

echo "== Lane 1/2: Refresh prod -> local DB =="
echo "Local target: $LOCAL_DB_URL"
ALLOW_LOCAL_TARGET=true \
PROD_DB_URL="$SOURCE_DB_URL" \
TRUNCATE_TARGET="$TRUNCATE_TARGET" \
BRANCH_DB_URL="$LOCAL_DB_URL" \
"$SCRIPT_DIR/refresh-prod-to-branch.sh"

echo
echo "== Lane 2/2: Refresh prod -> persistent dev branch =="
ALLOW_LOCAL_TARGET=false \
PROD_DB_URL="$SOURCE_DB_URL" \
TRUNCATE_TARGET="$TRUNCATE_TARGET" \
BRANCH_DB_URL="$TARGET_BRANCH_DB_URL" \
"$SCRIPT_DIR/refresh-prod-to-branch.sh"

echo
echo "Both refresh lanes completed."
