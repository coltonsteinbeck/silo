#!/bin/bash
set -e

echo "Running database migrations..."

# Check if DATABASE_URL is set
if [ -z "$DATABASE_URL" ]; then
    echo "Error: DATABASE_URL environment variable is not set"
    echo "Example: export DATABASE_URL='postgresql://user:pass@host:5432/dbname'"
    exit 1
fi

# Check if psql is available
if ! command -v psql &> /dev/null; then
    echo "Error: psql is not installed"
    echo "Install with: brew install postgresql (macOS) or apt install postgresql-client (Linux)"
    exit 1
fi

# Run migrations
for migration in database/migrations/*.sql; do
    if [ -f "$migration" ]; then
        echo "Running $(basename "$migration")..."
        psql "$DATABASE_URL" < "$migration"
        if [ $? -eq 0 ]; then
            echo "✓ $(basename "$migration") completed successfully"
        else
            echo "✗ $(basename "$migration") failed"
            exit 1
        fi
    fi
done

echo "All migrations completed successfully"
