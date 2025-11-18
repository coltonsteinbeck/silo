#!/bin/bash
set -e

echo "Running database migrations..."

DB_URL=${DATABASE_URL:-"postgresql://silo:silo_dev@localhost:5432/silo"}

for migration in database/migrations/*.sql; do
    if [ -f "$migration" ]; then
        echo "Running $(basename "$migration")..."
        docker exec -i silo-postgres-1 psql "$DB_URL" < "$migration" 2>&1 || true
    fi
done

echo "Migrations complete"
