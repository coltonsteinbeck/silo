# Silo - Multi-Provider Discord AI Bot

Self-hosted Discord bot framework with customizable AI providers, advanced memory, realtime voice, and extensible architecture. Supports both self-hosted and hosted/SaaS deployment modes.

## Quick Start

### Prerequisites

- Bun 1.0+
- PostgreSQL database (local Docker, Supabase, or any Postgres provider)
- Redis (for rate limiting)
- Discord Bot Token

### Local Setup with Docker

```bash
git clone <your-repo>
cd silo
bun run setup  # Installs deps, starts Docker, runs migrations
```

### Setup with Supabase (or any Postgres)

```bash
git clone <your-repo>
cd silo
bun install

# Get your Postgres connection string from Supabase
export DATABASE_URL='postgresql://postgres:[password]@db.[project].supabase.co:5432/postgres'

# Run migrations
bun run migrate:remote

# Start local Redis
docker run -d -p 6379:6379 redis:7-alpine
```

Edit `.env` with your credentials:

```bash
DISCORD_TOKEN=your_bot_token
DISCORD_CLIENT_ID=your_client_id
DATABASE_URL=postgresql://...  # Your Postgres connection string
REDIS_URL=redis://localhost:6379
OPENAI_API_KEY=your_openai_key  # For text, images, and voice
# or
ANTHROPIC_API_KEY=your_anthropic_key  # For text only
```

### Run

```bash
# Development
bun run dev:bot

# Production (with sharding)
bun run start:prod
```

### Deployment Modes & Environments

- `DEPLOYMENT_MODE=production` (hosted) uses `HOSTED_DB_IDENTIFIER` + `SUPABASE_PW` to build `DATABASE_URL`.
- `DEPLOYMENT_MODE=development` uses `DEV_DB_IDENTIFIER` + `SUPABASE_DEV_PW` (Supabase branch-friendly).
- `DEPLOYMENT_MODE=self-hosted` or explicit `DATABASE_URL` keeps full manual control.

Supabase branch examples:

```bash
DEPLOYMENT_MODE=development
DEV_DB_IDENTIFIER=dev-xxxxx.supabase.co
SUPABASE_DEV_PW=your-dev-postgres-password

# For prod/hosted
DEPLOYMENT_MODE=production
HOSTED_DB_IDENTIFIER=prod-xxxxx.supabase.co
SUPABASE_PW=your-prod-postgres-password
```

Local model (Ollama / LM Studio) example:

```bash
ENABLE_LOCAL_MODELS=true
LOCAL_BASE_URL=http://localhost:11434/v1
LOCAL_MODEL=llama3.1
# LOCAL_API_KEY=optional (many local endpoints ignore it)
```

### Docker Deployment

```bash
# Build the image
docker build -t silo-bot .

# Run with environment variables
docker run -d \
  --name silo \
  --env-file .env \
  --restart unless-stopped \
  silo-bot

# Or with docker-compose (includes Postgres + Redis)
docker-compose -f docker-compose.prod.yml up -d
```

## Getting Discord Bot Token

1. Go to https://discord.com/developers/applications
2. Click "New Application"
3. Go to "Bot" tab -> "Reset Token" -> Copy token
4. Enable "Message Content Intent" under Privileged Gateway Intents
5. Go to OAuth2 -> URL Generator:
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions: Read Message History, Send Messages, Embed Links, Attach Files, Connect, Speak
6. Copy URL and invite bot to your server

## Features

### Core Capabilities

- **Multi-Provider AI**: OpenAI (gpt-5-mini), Anthropic, xAI, Google, local OpenAI-compatible (Ollama/LM Studio)
- **Conversational AI**: @mention bot for natural conversations with context
- **Realtime Voice**: Talk to Silo in voice channels with multiple voice options (alloy, ash, ballad, coral, echo, sage, shimmer, verse)
- **Advanced Memory**: User and server memory systems with search
- **Image Generation**: gpt-image-1 with low/medium/high quality options
- **Database Flexibility**: Works with any PostgreSQL (Supabase, Railway, local, etc.)
- **Sharding**: Built-in Discord.js ShardingManager for multi-guild scaling
- **Role-Based Permissions**: Admin, moderator, trusted, member, restricted tiers
- **Daily Quotas**: Per-user and per-guild usage limits with automatic daily reset
- **Audit Logging**: Track all admin actions and moderation events
- **Analytics**: Command usage, AI costs, response times, user feedback

### Commands

#### Memory Management

- `/memory-view [type]` - View stored memories
- `/memory-set <content> <type>` - Store new memory
- `/memory-clear [id|type]` - Clear memories

#### Media Generation

- `/draw <prompt>` - Generate images with gpt-image-1

#### Voice

- `/speak [voice] [channel]` - Start a voice conversation with Silo
  - Voice options: alloy, ash, ballad, coral, echo, sage, shimmer, verse
  - Channel: optionally specify which voice channel to join
- `/stopspeaking` - End your voice session

#### Collaboration

- `/thread [name]` - Create conversation threads (AI auto-names if not specified)
- `/digest [period] [include_stats]` - Server activity summaries (1h, 12h, daily, weekly)

#### Feedback

- `/feedback <type>` - Submit bug reports, feature requests, or general feedback

#### Admin & Moderation

- `/admin` - View server statistics and configuration dashboard
- `/config provider|auto-thread|retention|rate-limit|view` - Configure server settings
- `/mod warn|timeout|purge|history` - Moderation tools
- `/analytics [period]` - View command usage, costs, and feedback stats

### User Feedback

React to bot messages with:

- Thumbs up: Positive feedback
- Thumbs down: Negative feedback
- Recycle: Regenerate response (planned)
- Floppy disk: Save to knowledge base (planned)
- Trash: Delete message (original requester or moderators)

### Daily Quotas

Usage limits reset at midnight UTC:

| Feature       | Member | Trusted | Moderator | Admin |
| ------------- | ------ | ------- | --------- | ----- |
| Text tokens   | 5k     | 10k     | 20k       | 50k   |
| Images        | 1      | 2       | 3         | 5     |
| Voice minutes | 0      | 5       | 10        | 15    |

### AI Models

- **Text**: gpt-5-mini ($0.25/1M input, $2.00/1M output)
- **Images**: gpt-image-1 (low/medium/high quality)
- **Voice**: gpt-4o-mini-realtime-preview (~$0.34/5min session)

### Planned Features

- Web search integration
- Custom user commands (with security sandbox)
- Enhanced memory: stats, updates, server-wide memories
- RAG memory with vector search
- Channel-specific behavior modes
- Ephemeral response options

See `IMPLEMENTATION_PLAN.md` and `DISCORD_FEATURES.md` for detailed roadmap.

## Project Structure

```
silo/
├── packages/
│   ├── core/          # Shared config, types, utilities
│   └── bot/           # Discord bot implementation
├── supabase/
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
