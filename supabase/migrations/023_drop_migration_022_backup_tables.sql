-- Migration 023: Archive migration-022 rollback snapshots before cleanup.
--
-- Migration 022 created backup tables to support rollback during the pricing
-- alignment rollout. Preserve snapshot rows in an archive table before dropping
-- the original backup tables.

CREATE TABLE
IF NOT EXISTS archived_migration_022_backup
(
	id BIGSERIAL PRIMARY KEY,
	source_table TEXT NOT NULL,
	row_data JSONB NOT NULL,
	archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW
()
);

CREATE INDEX
IF NOT EXISTS idx_archived_migration_022_backup_source
	ON archived_migration_022_backup
(source_table, archived_at DESC);

CREATE UNIQUE INDEX
IF NOT EXISTS uq_archived_migration_022_backup_source_row
	ON archived_migration_022_backup
(source_table, md5
(row_data::text));

DO $$
BEGIN
    IF to_regclass('public.migration_022_guild_quota_backup') IS NOT NULL THEN
    INSERT INTO archived_migration_022_backup
        (source_table, row_data)
    SELECT 'migration_022_guild_quota_backup', to_jsonb(t)
    FROM migration_022_guild_quota_backup t
    ON CONFLICT DO NOTHING;
END
IF;

	IF to_regclass('public.migration_022_role_tier_quota_backup') IS NOT NULL THEN
INSERT INTO archived_migration_022_backup
    (source_table, row_data)
SELECT 'migration_022_role_tier_quota_backup', to_jsonb(t)
FROM migration_022_role_tier_quota_backup t
ON CONFLICT DO NOTHING;
END
IF;
END $$;

DROP TABLE IF EXISTS migration_022_guild_quota_backup;
DROP TABLE IF EXISTS migration_022_role_tier_quota_backup;

-- ============================================================================
-- DOWN MIGRATION (uncomment to rollback)
-- ============================================================================

-- CREATE TABLE IF NOT EXISTS migration_022_guild_quota_backup (
--   guild_scope TEXT PRIMARY KEY,
--   guild_id TEXT,
--   daily_video_tokens INTEGER,
--   updated_at TIMESTAMPTZ,
--   captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
-- );
--
-- CREATE TABLE IF NOT EXISTS migration_022_role_tier_quota_backup (
--   guild_id TEXT,
--   role_tier TEXT NOT NULL,
--   video_tokens INTEGER,
--   updated_at TIMESTAMPTZ,
--   captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
-- );
--
-- INSERT INTO migration_022_guild_quota_backup (guild_scope, guild_id, daily_video_tokens, updated_at)
-- SELECT
--   COALESCE((row_data->>'guild_scope')::TEXT, COALESCE(row_data->>'guild_id', '__global__')),
--   NULLIF(row_data->>'guild_id', ''),
--   NULLIF(row_data->>'daily_video_tokens', '')::INTEGER,
--   NULLIF(row_data->>'updated_at', '')::TIMESTAMPTZ
-- FROM archived_migration_022_backup
-- WHERE source_table = 'migration_022_guild_quota_backup'
-- ON CONFLICT (guild_scope) DO NOTHING;
--
-- INSERT INTO migration_022_role_tier_quota_backup (guild_id, role_tier, video_tokens, updated_at)
-- SELECT
--   NULLIF(row_data->>'guild_id', ''),
--   row_data->>'role_tier',
--   NULLIF(row_data->>'video_tokens', '')::INTEGER,
--   NULLIF(row_data->>'updated_at', '')::TIMESTAMPTZ
-- FROM archived_migration_022_backup
-- WHERE source_table = 'migration_022_role_tier_quota_backup';
