# Silo - Multi-Provider Discord AI Bot

Self-hosted Discord bot framework with customizable AI providers, advanced memory, video generation, and extensible architecture.

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
OPENAI_API_KEY=your_openai_key  # For video, images, and text
# or
ANTHROPIC_API_KEY=your_anthropic_key  # For text only
```

### Run

```bash
bun run dev:bot
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

### Core Capabilities

- **Multi-Provider AI**: OpenAI, Anthropic, xAI, Google support
- **Conversational AI**: @mention bot for natural conversations with context
- **Advanced Memory**: User and server memory systems with search
- **Database Flexibility**: Works with any PostgreSQL (Supabase, Railway, local, etc.)
- **Role-Based Permissions**: Admin, moderator, trusted, member, restricted tiers
- **Audit Logging**: Track all admin actions and moderation events
- **Analytics**: Command usage, AI costs, response times, user feedback

### Commands

#### Memory Management

- `/memory-view [type]` - View stored memories
- `/memory-set <content> <type>` - Store new memory
- `/memory-clear [id|type]` - Clear memories

#### Media Generation

- `/draw <prompt>` - Generate images with DALL-E
- `/video <prompt>` - Generate videos with Sora (5-10s, 720p-1080p)

#### Collaboration

- `/thread [name]` - Create conversation threads (AI auto-names if not specified)
- `/digest [period] [include_stats]` - Server activity summaries (1h, 12h, daily, weekly)

#### Admin & Moderation (NEW)

- `/admin` - View server statistics and configuration dashboard
- `/config provider|auto-thread|retention|rate-limit|view` - Configure server settings
- `/mod warn|timeout|purge|history` - Moderation tools
- `/analytics [period]` - View command usage, costs, and feedback stats

### User Feedback

React to bot messages with:

- 👍 Positive feedback
- 👎 Negative feedback
- 🔄 Regenerate response (planned)
- 💾 Save to knowledge base (planned)
- 🗑️ Delete message (original requester or moderators)

### Planned Features

- Web search integration
- Custom user commands (with security sandbox)
- Realtime voice with `/speak` command
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
