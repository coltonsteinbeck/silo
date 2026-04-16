#!/bin/bash
set -e

echo "Setting up Silo..."

command -v bun >/dev/null 2>&1 || { echo "Bun required. Install from https://bun.sh"; exit 1; }

have_cmd() {
    command -v "$1" >/dev/null 2>&1
}

SKIP_DB=${SKIP_DB:-0}
COMPOSE_CMD=""

if [ "$SKIP_DB" != "1" ]; then
    if have_cmd docker; then
        if docker compose version >/dev/null 2>&1; then
            COMPOSE_CMD="docker compose"
        elif have_cmd docker-compose; then
            COMPOSE_CMD="docker-compose"
        else
            echo "Docker detected, but Compose is missing. Install the Compose plugin or docker-compose."
            echo "Tip: on newer Docker versions, 'docker compose' is the expected command."
            exit 1
        fi
    elif have_cmd podman; then
        if have_cmd podman-compose; then
            COMPOSE_CMD="podman-compose"
        else
            echo "Podman detected, but podman-compose is missing. Install podman-compose or install Docker + Compose."
            exit 1
        fi
    else
        echo "Docker (or Podman) is required to run the local Postgres + Redis containers."
        echo "Install Docker: https://docs.docker.com/engine/install/"
        echo "Or set SKIP_DB=1 to skip starting the database and migrations."
        exit 1
    fi
fi

echo "Installing dependencies..."
bun install

if [ ! -f .env ]; then
    echo "Creating .env file..."
    cp .env.example .env
    echo "Please edit .env with your API keys and tokens"
fi

echo "Starting database..."
if [ "$SKIP_DB" = "1" ]; then
    echo "Skipping database startup (SKIP_DB=1)"
else
    $COMPOSE_CMD up -d postgres redis
fi

echo "Waiting for database..."
if [ "$SKIP_DB" = "1" ]; then
    :
else
    sleep 5
fi

echo "Running migrations..."
if [ "$SKIP_DB" = "1" ]; then
    echo "Skipping migrations (SKIP_DB=1)"
else
    bash scripts/migrate.sh
fi

echo ""
echo "Setup complete!"
echo ""
echo "Next steps:"
echo "1. Edit .env with your Discord token and API keys"
echo "2. Run 'bun run dev' to start the bot"

if [ "$SKIP_DB" = "1" ]; then
    echo ""
    echo "Note: Database was skipped (SKIP_DB=1). Some bot features may not work until Postgres/Redis are running and migrations have been applied."
fi
