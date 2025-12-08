# Implementation Plan - Advanced Features

## Completed

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

### 4. Realtime Voice

- `/speak [voice]` - Start realtime voice session with Silo
- `/stopspeaking` - End your voice session
- Simultaneous multi-speaker support (multiple users can talk at once)
- Voice options: alloy, echo, fable, onyx, nova, shimmer
- Uses gpt-4o-mini-realtime-preview model
- Auto-disconnect when no active speakers

### 5. Daily Quotas System

- Per-user and per-guild daily usage limits
- Automatic reset at midnight UTC
- Role-based limits (member/trusted/moderator/admin)
- Database tracking with `guild_quotas`, `usage_tracking`, `guild_daily_usage` tables
- Quota middleware for checking/recording usage

### 6. Feedback System

- `/feedback <type>` - Submit feedback (bug, feature, general, praise)
- Modal-based input for detailed feedback
- Stored in database for admin review

### 7. Sharding Support

- Discord.js ShardingManager for multi-guild scaling
- Production entry point: `packages/bot/src/shard.ts`
- Run with: `bun run start:prod`

### 8. Admin & Moderation Tools

- `/admin` - Server statistics dashboard
- `/config` - Server configuration
- `/mod` - Moderation tools (warn, timeout, purge, history)
- `/analytics` - Usage analytics

### 9. Models Updated

- Text: gpt-5-mini (default)
- Images: gpt-image-1 (replaced dall-e-3)
- Voice: gpt-4o-mini-realtime-preview

## Removed Features

### Video Generation (Removed)

- Originally planned with Sora API
- Removed due to cost concerns (~$0.10-0.50/video)
- May revisit in future with budget allocation

## Remaining Implementation

### 10. Web Search Integration

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

### 11. Custom Commands System

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
  response: "Weather in {city}: {temp}F"
}
```

**Files to Create:**

- `packages/bot/src/commands/custom-command.ts`
- `packages/bot/src/custom-commands/engine.ts` (safe execution engine)
- `packages/bot/src/custom-commands/validator.ts` (security validation)
- `database/migrations/004_custom_commands.sql` (storage schema)

### 12. Enhanced Memory Commands (Match Bepo)

**New Memory Features:**

- `/memory stats` - View memory usage statistics
- `/updatememory <id> [content] [context_type]` - Update existing memories
- `/servermemory add <content> [title]` - Add server-wide memories
- `/servermemory list [filter] [limit]` - View server memories
- `/servermemory search <query>` - Search server memories
- `/servermemory delete <memory_id>` - Delete server memories
- `/servermemory stats` - Server memory statistics

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
- Max memory per user (1000 memories)
- Auto-cleanup expired data

## Configuration Updates Needed

Add to `.env.example`:

```bash
# Search Provider (pick one)
TAVILY_API_KEY=
BRAVE_SEARCH_API_KEY=
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

1. **Thread support** - DONE
2. **Digest system** - DONE
3. **Realtime voice** - DONE
4. **Quotas system** - DONE
5. **Feedback system** - DONE
6. **Sharding** - DONE
7. **Memory enhancements** - Next priority
8. **Web search** - Medium priority
9. **Custom commands** - Low priority (security critical)

## Testing Checklist

- [x] Migration works with Supabase
- [x] Migration works with local Postgres
- [x] Thread creation and auto-naming
- [x] Digest with different time periods
- [x] Memory CRUD operations
- [x] Voice commands created
- [ ] Voice session handling (integration test)
- [ ] Multi-user voice support (integration test)
- [ ] Quota enforcement
- [ ] Server memory permissions
- [ ] Search rate limiting
- [ ] Custom command sandboxing

## Next Steps

1. Test voice features with real Discord bot
2. Implement enhanced memory commands
3. Add web search integration
4. Consider custom commands with security review
5. Production deployment on Mac Mini
