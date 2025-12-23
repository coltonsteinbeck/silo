#!/bin/bash
set -e

echo "Running database migrations..."

DB_URL=${DATABASE_URL:-"postgresql://silo:silo_dev@localhost:5432/silo"}

for migration in supabase/migrations/*.sql; do
    if [ -f "$migration" ]; then
        echo "Running $(basename "$migration")..."
        if ! docker exec -i silo-postgres-1 psql "$DB_URL" < "$migration"; then
            echo "Migration failed: $migration" >&2
            exit 1
        fi
    fi
done

echo "Migrations complete"
