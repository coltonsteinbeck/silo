# Project Map For Agents

## Workspace

- `packages/core`: shared config, provider/database/admin types, logger, and utilities.
- `packages/bot`: Discord bot runtime, commands, providers, security, telemetry, services, voice, and graph orchestration.
- `supabase/migrations`: ordered database schema changes.
- `scripts`: setup, migrations, and database refresh operations.
- `docs`: deployment, Discord features, database refresh, graph, and contribution docs.

## Runtime Flow

1. `packages/bot/src/shard.ts` starts production shards.
2. `packages/bot/src/index.ts` wires config, providers, database adapters, permissions, commands, health, and Discord events.
3. Discord messages run through input safety, context assembly, optional graph orchestration, output safety, reply delivery, and persistence.
4. Slash commands remain command-owned but should share services with graph-owned natural-language tools where practical.

## Cleanup Priorities

- Keep `index.ts` extraction behavior-preserving and test-backed.
- Keep provider capability definitions synchronized across core types, provider adapters, registry, and graph capability registry.
- Keep safety changes observable in Langfuse metadata and covered by regression fixtures.
