#!/bin/bash
set -e

echo "Setting up Silo..."

command -v bun >/dev/null 2>&1 || { echo "Bun required. Install from https://bun.sh"; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "Docker required for database"; exit 1; }

echo "Installing dependencies..."
bun install

if [ ! -f .env ]; then
    echo "Creating .env file..."
    cp .env.example .env
    echo "Please edit .env with your API keys and tokens"
fi

echo "Starting database..."
docker-compose up -d postgres redis

echo "Waiting for database..."
sleep 5

echo "Running migrations..."
bash scripts/migrate.sh

echo ""
echo "Setup complete!"
echo ""
echo "Next steps:"
echo "1. Edit .env with your Discord token and API keys"
echo "2. Run 'bun run dev' to start the bot"
