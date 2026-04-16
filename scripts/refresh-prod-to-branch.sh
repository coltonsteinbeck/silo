#!/bin/bash
set -euo pipefail

# Refresh persistent Supabase dev branch data from production.
#
# Required (choose source):
#   1) PROD_DB_URL=postgresql://...
#   2) HOSTED_DB_IDENTIFIER=... and SUPABASE_PW=...
#   3) DATABASE_PROD_URL=postgresql://... (alias of PROD_DB_URL)
#
# Required (choose target):
#   1) BRANCH_DB_URL=postgresql://...
#   2) DEV_DB_IDENTIFIER=... and SUPABASE_DEV_PW=...
#   3) DATABASE_DEV_URL=postgresql://... (alias of BRANCH_DB_URL)
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
#   ALLOW_LOCAL_TARGET=true|false
#
# Example:
#   HOSTED_DB_IDENTIFIER='db.prod-project.supabase.co' SUPABASE_PW='***' \
#   DEV_DB_IDENTIFIER='db.dev-project.supabase.co' SUPABASE_DEV_PW='***' \
#   DB_SSL=true CONFIRM_REMOTE_RESTORE=true \
#   ./scripts/refresh-prod-to-branch.sh

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)
ENV_FILE=${REFRESH_ENV_FILE:-"$SCRIPT_DIR/../.env"}

# If required vars are missing from the current process environment, try loading
# them from the repo .env file so direct script runs behave like app startup.
if { [ -z "${PROD_DB_URL:-}" ] && { [ -z "${HOSTED_DB_IDENTIFIER:-}" ] || [ -z "${SUPABASE_PW:-}" ]; }; } \
  || { [ -z "${BRANCH_DB_URL:-}" ] && { [ -z "${DEV_DB_IDENTIFIER:-}" ] || [ -z "${SUPABASE_DEV_PW:-}" ]; }; } \
  || [ -z "${CONFIRM_REMOTE_RESTORE:-}" ]; then
  if [ -f "$ENV_FILE" ]; then
    set -a
    # shellcheck source=/dev/null
    . "$ENV_FILE"
    set +a
  fi
fi

DATABASE_PROD_URL=${DATABASE_PROD_URL:-}
DATABASE_DEV_URL=${DATABASE_DEV_URL:-}

PROD_DB_URL=${PROD_DB_URL:-$DATABASE_PROD_URL}
BRANCH_DB_URL=${BRANCH_DB_URL:-$DATABASE_DEV_URL}

HOSTED_DB_IDENTIFIER=${HOSTED_DB_IDENTIFIER:-}
SUPABASE_PW=${SUPABASE_PW:-}
DEV_DB_IDENTIFIER=${DEV_DB_IDENTIFIER:-}
SUPABASE_DEV_PW=${SUPABASE_DEV_PW:-}

DB_SSL=${DB_SSL:-true}
PROD_DB_SSL=${PROD_DB_SSL:-$DB_SSL}
DEV_DB_SSL=${DEV_DB_SSL:-$DB_SSL}

PROD_SCHEMAS=${PROD_SCHEMAS:-public}
INCLUDE_TABLES=${INCLUDE_TABLES:-}
EXCLUDE_TABLES=${EXCLUDE_TABLES:-public._migrations,public.schema_migrations,public.archived_migration_022_backup,public.migration_022_guild_quota_backup,public.migration_022_role_tier_quota_backup}
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
ALLOW_LOCAL_TARGET=${ALLOW_LOCAL_TARGET:-false}

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

extract_user() {
  echo "$1" | sed -nE 's|^[^:]+://([^:@/?]+)(:[^@]*)?@.*|\1|p'
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

is_direct_supabase_host() {
  case "$1" in
    db.*.supabase.co)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

has_ipv6_default_route() {
  if command -v route >/dev/null 2>&1; then
    if route -n get -inet6 default >/dev/null 2>&1; then
      return 0
    fi
  fi

  if command -v ip >/dev/null 2>&1; then
    if ip -6 route show default 2>/dev/null | grep -q .; then
      return 0
    fi
  fi

  return 1
}

extract_port() {
  local url="$1"
  local parsed_port

  parsed_port=$(echo "$url" | sed -nE 's|^[^:]+://([^@]+@)?[^:/?]+:([0-9]+).*|\2|p')
  if [ -n "$parsed_port" ]; then
    echo "$parsed_port"
  else
    echo "5432"
  fi
}

can_reach_ipv6_tcp() {
  local host="$1"
  local port="$2"

  if ! command -v nc >/dev/null 2>&1; then
    return 1
  fi

  if nc -6 -z -G 3 "$host" "$port" >/dev/null 2>&1; then
    return 0
  fi

  if nc -6 -z -w 3 "$host" "$port" >/dev/null 2>&1; then
    return 0
  fi

  return 1
}

preflight_direct_supabase_ipv6() {
  local host="$1"
  local label="$2"
  local url="$3"
  local port

  if ! is_direct_supabase_host "$host"; then
    return 0
  fi

  port=$(extract_port "$url")

  if can_reach_ipv6_tcp "$host" "$port"; then
    return 0
  fi

  echo "Network preflight failed for $label host: $host"
  echo "Detected direct Supabase DB endpoint (db.<project>.supabase.co), which requires IPv6 routing from this machine."
  if ! has_ipv6_default_route; then
    echo "No default IPv6 route was detected."
  else
    echo "IPv6 route may exist, but $host:$port is not reachable over IPv6 from this machine."
  fi
  echo "Fix options:"
  echo "  1) Use Supabase pooler URLs for PROD_DB_URL/BRANCH_DB_URL (or DATABASE_PROD_URL/DATABASE_DEV_URL)."
  echo "  2) Restore outbound IPv6 routing on this host/network and retry."
  exit 1
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
  psql "$db_url" -q -tA -v ON_ERROR_STOP=1 <<'SQL'
CREATE OR REPLACE FUNCTION pg_temp.latest_migration_name()
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  rec RECORD;
  candidate text;
BEGIN
  FOR rec IN
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE (table_schema = 'public' AND table_name = 'schema_migrations')
       OR (table_schema = 'supabase_migrations' AND table_name IN ('schema_migrations', 'migrations'))
    ORDER BY
      CASE
        WHEN table_schema = 'public' AND table_name = 'schema_migrations' THEN 1
        WHEN table_schema = 'supabase_migrations' AND table_name = 'schema_migrations' THEN 2
        ELSE 3
      END
  LOOP
    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = rec.table_schema
        AND table_name = rec.table_name
        AND column_name = 'filename'
    ) THEN
      EXECUTE format(
        'SELECT filename::text FROM %I.%I WHERE filename IS NOT NULL ORDER BY filename DESC LIMIT 1',
        rec.table_schema,
        rec.table_name
      )
      INTO candidate;

      IF candidate IS NOT NULL THEN
        RETURN candidate;
      END IF;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = rec.table_schema
        AND table_name = rec.table_name
        AND column_name = 'version'
    ) THEN
      EXECUTE format(
        'SELECT version::text FROM %I.%I WHERE version IS NOT NULL ORDER BY version DESC LIMIT 1',
        rec.table_schema,
        rec.table_name
      )
      INTO candidate;

      IF candidate IS NOT NULL THEN
        RETURN candidate;
      END IF;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = rec.table_schema
        AND table_name = rec.table_name
        AND column_name = 'name'
    ) THEN
      EXECUTE format(
        'SELECT name::text FROM %I.%I WHERE name IS NOT NULL ORDER BY name DESC LIMIT 1',
        rec.table_schema,
        rec.table_name
      )
      INTO candidate;

      IF candidate IS NOT NULL THEN
        RETURN candidate;
      END IF;
    END IF;
  END LOOP;

  RETURN '';
END;
$$;

SELECT COALESCE(pg_temp.latest_migration_name(), '');
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
PROD_USER=$(extract_user "$PROD_DB_URL")
BRANCH_USER=$(extract_user "$BRANCH_DB_URL")

if is_local_host "$PROD_HOST"; then
  echo "Safety check failed: prod source host appears local ($PROD_HOST)."
  exit 1
fi

if is_local_host "$BRANCH_HOST"; then
  if ! bool_true "$ALLOW_LOCAL_TARGET"; then
    echo "Safety check failed: branch target host appears local ($BRANCH_HOST)."
    echo "Set ALLOW_LOCAL_TARGET=true to explicitly allow local target restores."
    exit 1
  fi
fi

if [ "$PROD_HOST" = "$BRANCH_HOST" ]; then
  if [ -n "$PROD_USER" ] && [ -n "$BRANCH_USER" ] && [ "$PROD_USER" != "$BRANCH_USER" ]; then
    echo "[check] Source and target share host ($PROD_HOST) but use different users; allowing pooled cross-project refresh."
  else
    echo "Safety check failed: source and target hosts are identical ($PROD_HOST)."
    exit 1
  fi
fi

preflight_direct_supabase_ipv6 "$PROD_HOST" "source" "$PROD_DB_URL"
if ! is_local_host "$BRANCH_HOST"; then
  preflight_direct_supabase_ipv6 "$BRANCH_HOST" "target" "$BRANCH_DB_URL"
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
    elif [ -n "$SOURCE_MIGRATION_PREFIX" ] && [ -n "$TARGET_MIGRATION_PREFIX" ]; then
      if ((10#$SOURCE_MIGRATION_PREFIX > 10#$TARGET_MIGRATION_PREFIX)); then
        MIGRATION_MISMATCH=true
      elif ((10#$SOURCE_MIGRATION_PREFIX < 10#$TARGET_MIGRATION_PREFIX)); then
        echo "[check] Target migration is ahead of source; allowing refresh."
      fi
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
