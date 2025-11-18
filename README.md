# Silo - Multi-Provider Discord AI Bot

Self-hosted Discord bot framework with customizable AI providers, advanced memory, and extensible architecture.

## Quick Start

### Prerequisites

- Bun 1.0+
- Docker & Docker Compose
- Discord Bot Token

### Setup

```bash
git clone <your-repo>
cd silo
bun run setup
```

Edit `.env` with your credentials:

```bash
DISCORD_TOKEN=your_bot_token
DISCORD_CLIENT_ID=your_client_id
OPENAI_API_KEY=your_openai_key  # or other provider
```

### Run

```bash
bun run dev
```

## Getting Discord Bot Token

1. Go to https://discord.com/developers/applications
2. Click "New Application"
3. Go to "Bot" tab → "Reset Token" → Copy token
4. Enable "Message Content Intent" under Privileged Gateway Intents
5. Go to OAuth2 → URL Generator:
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions: Read Messages, Send Messages, Embed Links, Attach Files
6. Copy URL and invite bot to your server

## Features

- Multi-provider AI support (OpenAI, Anthropic, xAI, Google)
- User and server memory systems
- Rate limiting and security controls
- Extensible command system
- Voice channel support (planned)
- RAG memory with vector search (optional)

## Project Structure

```
silo/
├── packages/
│   ├── core/          # Shared config, types, utilities
│   └── bot/           # Discord bot implementation
├── services/
│   └── ml/            # Python ML service (optional)
├── database/
│   └── migrations/    # SQL migrations
├── scripts/           # Setup and deployment scripts
└── docker-compose.yml # Local infrastructure
```

## Configuration

All configuration in `.env`:

- Discord credentials
- AI provider API keys
- Database connection
- Feature flags
- Rate limits

## Commands

- `bun run dev` - Start in development mode
- `bun run build` - Build for production
- `bun run migrate` - Run database migrations
- `bun run type-check` - Check TypeScript types

## License

MIT
