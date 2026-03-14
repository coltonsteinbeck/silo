#!/bin/bash
set -euo pipefail

SCRIPT_NAME=$(basename "$0")

TARGET="local"
DB_URL_OVERRIDE=""
DRY_RUN="false"
STATUS_ONLY="false"
CONFIRM_PROD="false"

print_help() {
    cat <<'EOF'
Usage:
    bash scripts/migrate.sh [options]

Options:
    --target <local|dev|prod|remote>   Migration target (default: local)
    --db-url <postgres-url>            Explicit database URL override
    --dry-run                          Show pending migrations without applying
    --status                           Show migration status without applying
    --confirm-prod                     Required guard for --target prod
    -h, --help                         Show this help message

Target URL resolution:
    local:
        --db-url > LOCAL_DB_URL > DATABASE_URL > postgresql://postgres:postgres@127.0.0.1:54322/postgres
    dev:
        --db-url > DEV_DB_URL > derived from DEV_DB_IDENTIFIER + SUPABASE_DEV_PW
    prod:
        --db-url > PROD_DB_URL > derived from HOSTED_DB_IDENTIFIER + SUPABASE_PW
    remote:
        --db-url > DATABASE_URL

Notes:
    - Only pending migrations are applied.
    - Applied migrations are discovered from schema migration tables if present.
EOF
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

require_cmd() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "Error: required command not found: $1" >&2
        exit 1
    fi
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

resolve_db_url() {
    local shared_ssl
    shared_ssl=${DB_SSL:-true}

    case "$TARGET" in
        local)
            if [ -n "$DB_URL_OVERRIDE" ]; then
                echo "$DB_URL_OVERRIDE"
            elif [ -n "${LOCAL_DB_URL:-}" ]; then
                echo "$LOCAL_DB_URL"
            elif [ -n "${DATABASE_URL:-}" ]; then
                echo "$DATABASE_URL"
            else
                echo "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
            fi
            ;;
        dev)
            if [ -n "$DB_URL_OVERRIDE" ]; then
                echo "$DB_URL_OVERRIDE"
            elif [ -n "${DEV_DB_URL:-}" ]; then
                echo "$DEV_DB_URL"
            elif [ -n "${DEV_DB_IDENTIFIER:-}" ] && [ -n "${SUPABASE_DEV_PW:-}" ]; then
                build_db_url "$DEV_DB_IDENTIFIER" "$SUPABASE_DEV_PW" "${DEV_DB_SSL:-$shared_ssl}"
            else
                echo "Error: unable to resolve dev DB URL. Set --db-url, DEV_DB_URL, or DEV_DB_IDENTIFIER + SUPABASE_DEV_PW" >&2
                exit 1
            fi
            ;;
        prod)
            if [ -n "$DB_URL_OVERRIDE" ]; then
                echo "$DB_URL_OVERRIDE"
            elif [ -n "${PROD_DB_URL:-}" ]; then
                echo "$PROD_DB_URL"
            elif [ -n "${HOSTED_DB_IDENTIFIER:-}" ] && [ -n "${SUPABASE_PW:-}" ]; then
                build_db_url "$HOSTED_DB_IDENTIFIER" "$SUPABASE_PW" "${PROD_DB_SSL:-$shared_ssl}"
            else
                echo "Error: unable to resolve prod DB URL. Set --db-url, PROD_DB_URL, or HOSTED_DB_IDENTIFIER + SUPABASE_PW" >&2
                exit 1
            fi
            ;;
        remote)
            if [ -n "$DB_URL_OVERRIDE" ]; then
                echo "$DB_URL_OVERRIDE"
            elif [ -n "${DATABASE_URL:-}" ]; then
                echo "$DATABASE_URL"
            else
                echo "Error: --target remote requires --db-url or DATABASE_URL" >&2
                exit 1
            fi
            ;;
        *)
            echo "Error: unsupported target '$TARGET'" >&2
            exit 1
            ;;
    esac
}

tracking_table_count() {
    psql "$1" -tA -v ON_ERROR_STOP=1 <<'SQL'
SELECT COUNT(*)
FROM information_schema.tables
WHERE (table_schema = 'public' AND table_name = 'schema_migrations')
     OR (table_schema = 'supabase_migrations' AND table_name IN ('schema_migrations', 'migrations'));
SQL
}

fetch_applied_migration_keys() {
    psql "$1" -tA -v ON_ERROR_STOP=1 <<'SQL'
CREATE OR REPLACE FUNCTION pg_temp.collect_migration_keys()
RETURNS TABLE(migration_key text)
LANGUAGE plpgsql
AS $$
DECLARE
    rec RECORD;
BEGIN
    FOR rec IN
        SELECT table_schema, table_name
        FROM information_schema.tables
        WHERE (table_schema = 'public' AND table_name = 'schema_migrations')
             OR (table_schema = 'supabase_migrations' AND table_name IN ('schema_migrations', 'migrations'))
    LOOP
        IF EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = rec.table_schema
                AND table_name = rec.table_name
                AND column_name = 'filename'
        ) THEN
            RETURN QUERY EXECUTE format(
                'SELECT filename::text FROM %I.%I WHERE filename IS NOT NULL',
                rec.table_schema,
                rec.table_name
            );
        END IF;

        IF EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = rec.table_schema
                AND table_name = rec.table_name
                AND column_name = 'version'
        ) THEN
            RETURN QUERY EXECUTE format(
                'SELECT version::text FROM %I.%I WHERE version IS NOT NULL',
                rec.table_schema,
                rec.table_name
            );
        END IF;

        IF EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = rec.table_schema
                AND table_name = rec.table_name
                AND column_name = 'name'
        ) THEN
            RETURN QUERY EXECUTE format(
                'SELECT name::text FROM %I.%I WHERE name IS NOT NULL',
                rec.table_schema,
                rec.table_name
            );
        END IF;
    END LOOP;
END;
$$;

SELECT migration_key
FROM pg_temp.collect_migration_keys()
WHERE migration_key IS NOT NULL
    AND btrim(migration_key) <> ''
ORDER BY 1;
SQL
}

migration_is_applied() {
    local migration_file="$1"
    local applied_keys="$2"
    local filename
    local stem
    local prefix

    filename=$(basename "$migration_file")
    stem="${filename%.sql}"
    prefix="${stem%%_*}"

    if printf '%s\n' "$applied_keys" | grep -Fxq "$filename"; then
        return 0
    fi

    if printf '%s\n' "$applied_keys" | grep -Fxq "$stem"; then
        return 0
    fi

    if [ -n "$prefix" ] && printf '%s\n' "$applied_keys" | grep -Fxq "$prefix"; then
        return 0
    fi

    return 1
}

while [ $# -gt 0 ]; do
    case "$1" in
        --target)
            if [ $# -lt 2 ]; then
                echo "Error: --target requires a value" >&2
                exit 1
            fi
            TARGET="$2"
            shift 2
            ;;
        --db-url)
            if [ $# -lt 2 ]; then
                echo "Error: --db-url requires a value" >&2
                exit 1
            fi
            DB_URL_OVERRIDE="$2"
            shift 2
            ;;
        --dry-run)
            DRY_RUN="true"
            shift
            ;;
        --status)
            STATUS_ONLY="true"
            shift
            ;;
        --confirm-prod)
            CONFIRM_PROD="true"
            shift
            ;;
        -h|--help)
            print_help
            exit 0
            ;;
        *)
            echo "Error: unknown argument '$1'" >&2
            print_help
            exit 1
            ;;
    esac
done

if [ "$TARGET" = "prod" ] && [ "$CONFIRM_PROD" != "true" ]; then
    echo "Safety check failed: --target prod requires --confirm-prod" >&2
    exit 1
fi

require_cmd psql
require_cmd bun

DB_URL=$(resolve_db_url)
TARGET_HOST=$(extract_host "$DB_URL")

if [ "$TARGET" = "local" ] && ! is_local_host "$TARGET_HOST"; then
    echo "Safety check failed: local target must resolve to localhost; got '$TARGET_HOST'" >&2
    exit 1
fi

if { [ "$TARGET" = "dev" ] || [ "$TARGET" = "prod" ]; } && is_local_host "$TARGET_HOST"; then
    echo "Safety check failed: '$TARGET' target resolved to local host '$TARGET_HOST'" >&2
    exit 1
fi

echo "Running database migrations"
echo "Target:  $TARGET"
echo "DB host: $TARGET_HOST"

MIGRATION_FILES=()
while IFS= read -r migration_file; do
    MIGRATION_FILES+=("$migration_file")
done < <(find supabase/migrations -maxdepth 1 -type f -name '*.sql' | sort)

if [ ${#MIGRATION_FILES[@]} -eq 0 ]; then
    echo "No migration files found in supabase/migrations"
    exit 0
fi

TABLE_COUNT=$(tracking_table_count "$DB_URL" | tr -d '\r')
if [ "$TABLE_COUNT" = "0" ]; then
    echo "Warning: no schema migration tracking table detected; all files will be treated as pending"
fi

APPLIED_KEYS=$(fetch_applied_migration_keys "$DB_URL" | tr -d '\r' || true)

PENDING_FILES=()
APPLIED_FILES=()

for migration in "${MIGRATION_FILES[@]}"; do
    if migration_is_applied "$migration" "$APPLIED_KEYS"; then
        APPLIED_FILES+=("$migration")
    else
        PENDING_FILES+=("$migration")
    fi
done

echo "Total migration files: ${#MIGRATION_FILES[@]}"
echo "Already applied:       ${#APPLIED_FILES[@]}"
echo "Pending:               ${#PENDING_FILES[@]}"

if [ ${#PENDING_FILES[@]} -gt 0 ]; then
    echo "Pending migrations:"
    for migration in "${PENDING_FILES[@]}"; do
        echo "  - $(basename "$migration")"
    done
fi

if [ "$STATUS_ONLY" = "true" ]; then
    exit 0
fi

if [ "$DRY_RUN" = "true" ]; then
    echo "Dry run complete. No migrations were applied."
    exit 0
fi

if [ ${#PENDING_FILES[@]} -eq 0 ]; then
    echo "No pending migrations to apply."
    exit 0
fi

for migration in "${PENDING_FILES[@]}"; do
    echo "Applying $(basename "$migration")..."
    psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$migration"
done

echo "Migrations complete"
