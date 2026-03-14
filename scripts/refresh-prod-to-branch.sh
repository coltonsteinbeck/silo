#!/bin/bash
set -euo pipefail

# Refresh persistent Supabase dev branch data from production.
#
# Required (choose source):
#   1) PROD_DB_URL=postgresql://...
#   2) HOSTED_DB_IDENTIFIER=... and SUPABASE_PW=...
#
# Required (choose target):
#   1) BRANCH_DB_URL=postgresql://...
#   2) DEV_DB_IDENTIFIER=... and SUPABASE_DEV_PW=...
#
# Safety requirement:
#   CONFIRM_REMOTE_RESTORE=true
#
# Optional:
#   PROD_SCHEMAS=public
#   INCLUDE_TABLES=public.users,public.messages
#   EXCLUDE_TABLES=public.audit_log,public.tokens
#   BACKUP_DIR=backups
#   BACKUP_TARGET_BEFORE_RESTORE=true
#   DB_SSL=true|false
#   PROD_DB_SSL=true|false
#   DEV_DB_SSL=true|false
#   TRUNCATE_TARGET=false
#   POST_RESTORE_ANALYZE=true
#   SMOKE_SQL=
#   CHECK_MIGRATION_COMPATIBILITY=true
#   ALLOW_MIGRATION_DRIFT=false
#   PRE_RESTORE_SQL_FILE=path/to/pre.sql
#   POST_RESTORE_SQL_FILE=path/to/post.sql
#
# Example:
#   HOSTED_DB_IDENTIFIER='db.prod-project.supabase.co' SUPABASE_PW='***' \
#   DEV_DB_IDENTIFIER='db.dev-project.supabase.co' SUPABASE_DEV_PW='***' \
#   DB_SSL=true CONFIRM_REMOTE_RESTORE=true \
#   ./scripts/refresh-prod-to-branch.sh

PROD_DB_URL=${PROD_DB_URL:-}
BRANCH_DB_URL=${BRANCH_DB_URL:-}

HOSTED_DB_IDENTIFIER=${HOSTED_DB_IDENTIFIER:-}
SUPABASE_PW=${SUPABASE_PW:-}
DEV_DB_IDENTIFIER=${DEV_DB_IDENTIFIER:-}
SUPABASE_DEV_PW=${SUPABASE_DEV_PW:-}

DB_SSL=${DB_SSL:-true}
PROD_DB_SSL=${PROD_DB_SSL:-$DB_SSL}
DEV_DB_SSL=${DEV_DB_SSL:-$DB_SSL}

PROD_SCHEMAS=${PROD_SCHEMAS:-public}
INCLUDE_TABLES=${INCLUDE_TABLES:-}
EXCLUDE_TABLES=${EXCLUDE_TABLES:-public._migrations,public.schema_migrations}
BACKUP_DIR=${BACKUP_DIR:-backups}
BACKUP_TARGET_BEFORE_RESTORE=${BACKUP_TARGET_BEFORE_RESTORE:-true}
TRUNCATE_TARGET=${TRUNCATE_TARGET:-false}
POST_RESTORE_ANALYZE=${POST_RESTORE_ANALYZE:-true}
SMOKE_SQL=${SMOKE_SQL:-}
CHECK_MIGRATION_COMPATIBILITY=${CHECK_MIGRATION_COMPATIBILITY:-true}
ALLOW_MIGRATION_DRIFT=${ALLOW_MIGRATION_DRIFT:-false}
PRE_RESTORE_SQL_FILE=${PRE_RESTORE_SQL_FILE:-}
POST_RESTORE_SQL_FILE=${POST_RESTORE_SQL_FILE:-}

CONFIRM_REMOTE_RESTORE=${CONFIRM_REMOTE_RESTORE:-false}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Error: required command not found: $1"
    exit 1
  fi
}

normalize_identifier() {
  local value="$1"
  value=$(echo "$value" | xargs)
  if [[ "$value" == db.* ]]; then
    echo "${value#db.}"
  else
    echo "$value"
  fi
}

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

extract_host() {
  echo "$1" | sed -E 's|^[^:]+://([^@]+@)?([^:/?]+).*|\2|'
}

is_local_host() {
  case "$1" in
    localhost|127.0.0.1|host.docker.internal|::1)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

build_db_url() {
  local identifier="$1"
  local password="$2"
  local ssl_enabled="$3"
  local normalized
  local encoded_password
  local suffix=""

  normalized=$(normalize_identifier "$identifier")
  encoded_password=$(bun -e 'console.log(encodeURIComponent(process.argv[1]))' "$password")

  if bool_true "$ssl_enabled"; then
    suffix='?sslmode=require'
  fi

  echo "postgresql://postgres:${encoded_password}@db.${normalized}:5432/postgres${suffix}"
}

require_cmd pg_dump
require_cmd psql
require_cmd bun

latest_migration() {
  local db_url="$1"
  psql "$db_url" -tA -v ON_ERROR_STOP=1 <<'SQL'
SELECT COALESCE(
  (
    SELECT filename
    FROM schema_migrations
    ORDER BY filename DESC
    LIMIT 1
  ),
  ''
)
WHERE to_regclass('public.schema_migrations') IS NOT NULL
UNION ALL
SELECT ''
WHERE to_regclass('public.schema_migrations') IS NULL
LIMIT 1;
SQL
}

migration_version_prefix() {
  local name="$1"
  if [[ "$name" =~ ^([0-9]+)_ ]]; then
    echo "${BASH_REMATCH[1]}"
  else
    echo ""
  fi
}

ensure_sql_file_if_set() {
  local path="$1"
  local label="$2"
  if [ -n "$path" ] && [ ! -f "$path" ]; then
    echo "Error: $label not found at $path"
    exit 1
  fi
}

if [ -z "$PROD_DB_URL" ]; then
  if [ -z "$HOSTED_DB_IDENTIFIER" ] || [ -z "$SUPABASE_PW" ]; then
    echo "Error: set PROD_DB_URL, or set HOSTED_DB_IDENTIFIER + SUPABASE_PW"
    exit 1
  fi
  PROD_DB_URL=$(build_db_url "$HOSTED_DB_IDENTIFIER" "$SUPABASE_PW" "$PROD_DB_SSL")
fi

if [ -z "$BRANCH_DB_URL" ]; then
  if [ -z "$DEV_DB_IDENTIFIER" ] || [ -z "$SUPABASE_DEV_PW" ]; then
    echo "Error: set BRANCH_DB_URL, or set DEV_DB_IDENTIFIER + SUPABASE_DEV_PW"
    exit 1
  fi
  BRANCH_DB_URL=$(build_db_url "$DEV_DB_IDENTIFIER" "$SUPABASE_DEV_PW" "$DEV_DB_SSL")
fi

if ! bool_true "$CONFIRM_REMOTE_RESTORE"; then
  echo "Safety check failed: set CONFIRM_REMOTE_RESTORE=true to allow remote branch restore."
  exit 1
fi

PROD_HOST=$(extract_host "$PROD_DB_URL")
BRANCH_HOST=$(extract_host "$BRANCH_DB_URL")

if is_local_host "$PROD_HOST"; then
  echo "Safety check failed: prod source host appears local ($PROD_HOST)."
  exit 1
fi

if is_local_host "$BRANCH_HOST"; then
  echo "Safety check failed: branch target host appears local ($BRANCH_HOST). Use local script for local restores."
  exit 1
fi

if [ "$PROD_HOST" = "$BRANCH_HOST" ]; then
  echo "Safety check failed: source and target hosts are identical ($PROD_HOST)."
  exit 1
fi

mkdir -p "$BACKUP_DIR"
STAMP=$(date +%Y%m%d_%H%M%S)
FULL_DUMP="$BACKUP_DIR/prod_full_${STAMP}.dump"
SCHEMA_TAG=$(echo "$PROD_SCHEMAS" | tr ',' '_')
DATA_DUMP="$BACKUP_DIR/prod_data_${SCHEMA_TAG}_${STAMP}.sql"
TARGET_DUMP="$BACKUP_DIR/branch_pre_refresh_${STAMP}.dump"

echo "== Refresh Prod -> Persistent Branch =="
echo "Source host: $PROD_HOST"
echo "Target host: $BRANCH_HOST"
echo "Schemas:     $PROD_SCHEMAS"
echo "Includes:    ${INCLUDE_TABLES:-<all tables in selected schemas>}"
echo "Excludes:    ${EXCLUDE_TABLES:-<none>}"
echo "Backup dir:  $BACKUP_DIR"

ensure_sql_file_if_set "$PRE_RESTORE_SQL_FILE" "PRE_RESTORE_SQL_FILE"
ensure_sql_file_if_set "$POST_RESTORE_SQL_FILE" "POST_RESTORE_SQL_FILE"

# Ensure target branch is reachable before dumping/restoring.
echo "[check] Verifying target branch connectivity"
psql "$BRANCH_DB_URL" -v ON_ERROR_STOP=1 -c 'SELECT 1;' >/dev/null

SOURCE_MIGRATION=""
TARGET_MIGRATION=""
if bool_true "$CHECK_MIGRATION_COMPATIBILITY"; then
  echo "[check] Comparing latest tracked migration between source and target"
  SOURCE_MIGRATION=$(latest_migration "$PROD_DB_URL" | tr -d '\r')
  TARGET_MIGRATION=$(latest_migration "$BRANCH_DB_URL" | tr -d '\r')
  SOURCE_MIGRATION_PREFIX=$(migration_version_prefix "$SOURCE_MIGRATION")
  TARGET_MIGRATION_PREFIX=$(migration_version_prefix "$TARGET_MIGRATION")
  echo "[check] Source latest migration: ${SOURCE_MIGRATION:-<none>}"
  echo "[check] Target latest migration: ${TARGET_MIGRATION:-<none>}"
  if [ -n "$SOURCE_MIGRATION_PREFIX" ] && [ -n "$TARGET_MIGRATION_PREFIX" ]; then
    echo "[check] Source/target migration prefixes: $SOURCE_MIGRATION_PREFIX / $TARGET_MIGRATION_PREFIX"
  fi

  MIGRATION_MISMATCH=false
  if [ "$SOURCE_MIGRATION" != "$TARGET_MIGRATION" ]; then
    if [ -n "$SOURCE_MIGRATION_PREFIX" ] && [ -n "$TARGET_MIGRATION_PREFIX" ] && [ "$SOURCE_MIGRATION_PREFIX" = "$TARGET_MIGRATION_PREFIX" ]; then
      echo "[check] Latest migration filenames differ but version prefixes match; treating as compatible."
    else
      MIGRATION_MISMATCH=true
    fi
  fi

  if bool_true "$MIGRATION_MISMATCH" && ! bool_true "$ALLOW_MIGRATION_DRIFT"; then
    echo "Safety check failed: migration drift detected and ALLOW_MIGRATION_DRIFT=false"
    exit 1
  fi
fi

SCHEMA_ARGS=()
IFS=',' read -r -a SCHEMA_LIST <<< "$PROD_SCHEMAS"
for schema in "${SCHEMA_LIST[@]}"; do
  trimmed=$(echo "$schema" | xargs)
  if [ -n "$trimmed" ]; then
    SCHEMA_ARGS+=(--schema "$trimmed")
  fi
done

if [ ${#SCHEMA_ARGS[@]} -eq 0 ]; then
  echo "Error: no schemas parsed from PROD_SCHEMAS=$PROD_SCHEMAS"
  exit 1
fi

INCLUDE_TABLE_ARGS=()
if [ -n "$INCLUDE_TABLES" ]; then
  IFS=',' read -r -a INCLUDE_TABLE_LIST <<< "$INCLUDE_TABLES"
  for table in "${INCLUDE_TABLE_LIST[@]}"; do
    trimmed=$(echo "$table" | xargs)
    if [ -n "$trimmed" ]; then
      INCLUDE_TABLE_ARGS+=(--table "$trimmed")
    fi
  done
fi

EXCLUDE_TABLE_ARGS=()
if [ -n "$EXCLUDE_TABLES" ]; then
  IFS=',' read -r -a EXCLUDE_TABLE_LIST <<< "$EXCLUDE_TABLES"
  for table in "${EXCLUDE_TABLE_LIST[@]}"; do
    trimmed=$(echo "$table" | xargs)
    if [ -n "$trimmed" ]; then
      EXCLUDE_TABLE_ARGS+=(--exclude-table-data "$trimmed")
    fi
  done
fi

echo "[1/8] Creating full production backup -> $FULL_DUMP"
pg_dump "$PROD_DB_URL" \
  --format=custom \
  --compress=9 \
  --no-owner \
  --no-privileges \
  --file "$FULL_DUMP"

if bool_true "$BACKUP_TARGET_BEFORE_RESTORE"; then
  echo "[2/8] Creating pre-refresh backup of target branch -> $TARGET_DUMP"
  pg_dump "$BRANCH_DB_URL" \
    --format=custom \
    --compress=9 \
    --no-owner \
    --no-privileges \
    --file "$TARGET_DUMP"
else
  echo "[2/8] Skipping target pre-refresh backup (BACKUP_TARGET_BEFORE_RESTORE=false)"
fi

echo "[3/8] Exporting production data-only snapshot -> $DATA_DUMP"
DATA_DUMP_ARGS=(
  --data-only
  --column-inserts
  --no-owner
  --no-privileges
)

DATA_DUMP_ARGS+=("${SCHEMA_ARGS[@]}")
if [ ${#INCLUDE_TABLE_ARGS[@]} -gt 0 ]; then
  DATA_DUMP_ARGS+=("${INCLUDE_TABLE_ARGS[@]}")
fi
if [ ${#EXCLUDE_TABLE_ARGS[@]} -gt 0 ]; then
  DATA_DUMP_ARGS+=("${EXCLUDE_TABLE_ARGS[@]}")
fi
DATA_DUMP_ARGS+=(--file "$DATA_DUMP")

pg_dump "$PROD_DB_URL" "${DATA_DUMP_ARGS[@]}"

if bool_true "$TRUNCATE_TARGET"; then
  echo "[4/8] Truncating target schema tables before restore"
  psql "$BRANCH_DB_URL" -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE
  stmt text;
BEGIN
  SELECT 'TRUNCATE TABLE ' || string_agg(format('%I.%I', schemaname, tablename), ', ') || ' CASCADE'
    INTO stmt
  FROM pg_tables
  WHERE schemaname = 'public'
    AND tablename <> 'schema_migrations';

  IF stmt IS NOT NULL THEN
    EXECUTE stmt;
  END IF;
END $$;
SQL
else
  echo "[4/8] Skipping target truncate (TRUNCATE_TARGET=false)"
fi

if [ -n "$PRE_RESTORE_SQL_FILE" ]; then
  echo "[5/8] Running pre-restore SQL hook: $PRE_RESTORE_SQL_FILE"
  psql "$BRANCH_DB_URL" -v ON_ERROR_STOP=1 -f "$PRE_RESTORE_SQL_FILE"
else
  echo "[5/8] Skipping pre-restore SQL hook"
fi

echo "[6/8] Restoring data snapshot into persistent branch"
psql "$BRANCH_DB_URL" -v ON_ERROR_STOP=1 -q -f "$DATA_DUMP" >/dev/null

if bool_true "$POST_RESTORE_ANALYZE"; then
  echo "[7/8] Running ANALYZE on target branch"
  psql "$BRANCH_DB_URL" -v ON_ERROR_STOP=1 -c 'ANALYZE;' >/dev/null
else
  echo "[7/8] Skipping ANALYZE (POST_RESTORE_ANALYZE=false)"
fi

if [ -n "$POST_RESTORE_SQL_FILE" ]; then
  echo "[8/8] Running post-restore SQL hook: $POST_RESTORE_SQL_FILE"
  psql "$BRANCH_DB_URL" -v ON_ERROR_STOP=1 -f "$POST_RESTORE_SQL_FILE"
elif [ -n "$SMOKE_SQL" ]; then
  echo "[8/8] Running smoke SQL"
  psql "$BRANCH_DB_URL" -v ON_ERROR_STOP=1 -c "$SMOKE_SQL"
else
  echo "[8/8] Skipping post-restore checks (POST_RESTORE_SQL_FILE and SMOKE_SQL not provided)"
fi

echo "\nDone."
echo "Source host: $PROD_HOST"
echo "Target host: $BRANCH_HOST"
echo "Full backup: $FULL_DUMP"
if bool_true "$BACKUP_TARGET_BEFORE_RESTORE"; then
  echo "Target backup: $TARGET_DUMP"
fi
echo "Data dump:   $DATA_DUMP"
