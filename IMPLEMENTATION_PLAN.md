# Implementation Plan - Advanced Features

## Completed ✅

### 1. Flexible Postgres Migration

- Created `scripts/migrate-universal.sh` for any Postgres database (Supabase, local, cloud)
- Usage: `export DATABASE_URL='...' && bun run migrate:remote`

### 2. Thread Support

- `/thread [name]` - Create dedicated conversation threads
- AI-powered auto-naming if no name provided
- Auto-archives after 1 hour of inactivity
- Bot responds to ALL messages in bot-created threads (no @ needed)

### 3. Server Digest System

- `/digest [period] [include_stats]` - Generate activity summaries
- Periods: 1h, 12h, daily, weekly
- AI-powered summary of conversations
- Optional detailed stats: top users, busiest channels, message counts

### 4. Video Generation (Sora API)

- `/video prompt model duration size` - Generate videos with Sora
- Models: sora-2 (fast), sora-2-pro (high quality)
- Durations: 5s, 8s, 10s
- Resolutions: 720p, 1080p
- Content safety filters built-in
- Progress tracking with polling
- Discord file size check (25MB limit)

## Remaining Implementation 🔨

### 5. Web Search Integration

**Command:** `/search <query>`

**Security Considerations:**

- Rate limit: 5 searches per user per hour
- Query sanitization to prevent injection
- Respect robots.txt
- Cache results to reduce API calls
- Content filtering for inappropriate results

**Implementation Approach:**

```typescript
// Use Tavily, Brave, or SerpAPI for web search
// Store search results in database with TTL
// Return formatted results with source links
// Add to conversation context when relevant
```

**Files to Create:**

- `packages/bot/src/commands/search.ts`
- `packages/bot/src/providers/search.ts` (abstraction for multiple search providers)

### 6. Custom Commands System

**Command:** `/custom-command create name description action`

**Security Risks & Mitigations:**

1. **Code Injection** - No eval(), exec(), or dynamic code execution
2. **XSS** - Sanitize all inputs, escape outputs
3. **Rate Abuse** - Limit custom commands per user (max 10)
4. **Resource Exhaustion** - Timeout custom commands after 5s
5. **Data Leaks** - No access to env vars or sensitive data

**Safe Approach:**

- Template-based system with predefined variables
- Allowlist of safe actions: send message, fetch URL (whitelist domains), simple math
- Sandbox execution with VM2 or similar
- Admin approval required for server-wide custom commands
- Audit log for all custom command executions

**Example Safe Template:**

```typescript
{
  trigger: "!weather",
  action: "fetch",
  url: "https://api.weather.com/...",
  response: "Weather in {city}: {temp}°F"
}
```

**Files to Create:**

- `packages/bot/src/commands/custom-command.ts`
- `packages/bot/src/custom-commands/engine.ts` (safe execution engine)
- `packages/bot/src/custom-commands/validator.ts` (security validation)
- `database/migrations/002_custom_commands.sql` (storage schema)

### 7. Realtime Voice (/speak)

**Command:** `/speak` - Start realtime voice session

**Implementation:**

- Uses OpenAI Realtime API with WebSocket connection
- Discord voice channel integration via @discordjs/voice
- Supports multiple users in same voice channel
- Push-to-talk or voice-activated modes
- Real-time transcription display in text channel

**Security Considerations:**

- Limit concurrent voice sessions per guild (max 3)
- Max session duration: 30 minutes with auto-disconnect
- Audio data not stored/recorded
- User opt-in required (privacy notice)

**Technical Requirements:**

```bash
npm install @discordjs/voice libsodium-wrappers @discordjs/opus
```

**Files to Create:**

- `packages/bot/src/commands/speak.ts`
- `packages/bot/src/voice/realtime-session.ts` (WebSocket management)
- `packages/bot/src/voice/audio-handler.ts` (Discord voice integration)

**Implementation Steps:**

1. User runs `/speak` in text channel
2. Bot joins their voice channel
3. Establishes WebSocket to OpenAI Realtime API
4. Pipes Discord voice input → OpenAI
5. Pipes OpenAI audio output → Discord voice
6. Displays transcriptions in text channel
7. Auto-disconnects on silence or timeout

### 8. Enhanced Memory Commands (Match Bepo)

**New Memory Features:**

- `/memory stats` - View memory usage statistics
- `/updatememory <id> [content] [context_type]` - Update existing memories
- `/servermemory add <content> [title]` - Add server-wide memories
- `/servermemory list [filter] [limit]` - View server memories
- `/servermemory search <query>` - Search server memories
- `/servermemory delete <memory_id>` - Delete server memories
- `/servermemory stats` - Server memory statistics
- `/servermemory my [limit]` - View your server contributions
- `/updateservermemory <id> [content] [title] [context_type]` - Update server memories

**Database Schema Updates:**

```sql
-- Already have user_memory and server_memory tables
-- Add indexes for search performance
CREATE INDEX idx_user_memory_content_gin ON user_memory USING gin(to_tsvector('english', memory_content));
CREATE INDEX idx_server_memory_content_gin ON server_memory USING gin(to_tsvector('english', memory_content));
```

**Permission Model:**

- Users can update/delete their own memories
- Admins can update/delete any server memory
- Server memories visible to all guild members
- Personal memories private to user

**Files to Update:**

- `packages/bot/src/commands/memory/view.ts` (add stats)
- `packages/bot/src/commands/memory/update.ts` (new file)
- `packages/bot/src/commands/server-memory/*.ts` (new directory)

## Security Best Practices Summary

### Input Validation

- Zod schemas for all command inputs
- Sanitize HTML/markdown in user content
- Validate URLs before fetching
- Limit string lengths (prompts, names, etc.)

### Rate Limiting

- Per-user command limits (10/min)
- Per-guild AI request limits (50/min)
- Per-user search limits (5/hour)
- Per-guild voice session limits (3 concurrent)

### Permission Checks

- Admin-only commands: server memory delete, custom command approval
- Voice channel permissions: verify user is in channel
- Thread creation: check channel permissions

### Data Protection

- No storage of voice audio
- Encrypt sensitive data in database
- Sanitize logs (no API keys, tokens)
- Audit trail for admin actions

### Resource Management

- Timeout long-running operations (5-30s)
- Limit concurrent video generations per guild (1)
- Max memory per user (1000 memories)
- Auto-cleanup expired data

## Configuration Updates Needed

Add to `.env.example`:

```bash
# Search Provider
TAVILY_API_KEY=
# or
BRAVE_SEARCH_API_KEY=
# or
SERPAPI_KEY=

# Custom Commands (optional)
ENABLE_CUSTOM_COMMANDS=false
CUSTOM_COMMANDS_REQUIRE_ADMIN_APPROVAL=true

# Voice Features
ENABLE_REALTIME_VOICE=true
MAX_VOICE_SESSIONS_PER_GUILD=3
VOICE_SESSION_TIMEOUT_MINUTES=30
```

## Recommended Implementation Order

1. **Memory enhancements** (low complexity, high value)
2. **Web search** (medium complexity, high value)
3. **Thread support** (✅ already done)
4. **Digest system** (✅ already done)
5. **Video generation** (✅ already done)
6. **Custom commands** (high complexity, security critical)
7. **Realtime voice** (highest complexity, requires careful testing)

## Testing Checklist

- [ ] Migration works with Supabase
- [ ] Migration works with local Postgres
- [ ] Thread creation and auto-naming
- [ ] Digest with different time periods
- [ ] Video generation with content filters
- [ ] Memory CRUD operations
- [ ] Server memory permissions
- [ ] Search rate limiting
- [ ] Custom command sandboxing
- [ ] Voice session handling
- [ ] Multi-user voice support

## Next Steps

1. Review this plan
2. Prioritize which features to implement first
3. Test existing features with Supabase
4. Implement remaining features iteratively
5. Comprehensive security audit before production
