-- Migration 023: Remove migration-022 rollback snapshot tables.
--
-- Migration 022 created one-time backup tables to support manual rollback during
-- the pricing-unit alignment rollout. These tables are not runtime dependencies.

DROP TABLE IF EXISTS migration_022_guild_quota_backup;
DROP TABLE IF EXISTS migration_022_role_tier_quota_backup;
