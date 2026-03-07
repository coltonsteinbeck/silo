-- Migration 014: Memory arbitration metadata indexes
-- Prepares deterministic conflict resolution by indexing metadata fields
-- used for conflict key, trust score, and source priority.

-- Generic metadata path lookup acceleration
CREATE INDEX IF NOT EXISTS idx_user_memory_metadata_gin
ON user_memory USING gin (metadata jsonb_path_ops);

CREATE INDEX IF NOT EXISTS idx_server_memory_metadata_gin
ON server_memory USING gin (metadata jsonb_path_ops);

-- Conflict key lookups/grouping
CREATE INDEX IF NOT EXISTS idx_user_memory_conflict_key
ON user_memory ((metadata->>'conflictKey'))
WHERE metadata ? 'conflictKey';

CREATE INDEX IF NOT EXISTS idx_server_memory_conflict_key
ON server_memory ((metadata->>'conflictKey'))
WHERE metadata ? 'conflictKey';

-- Trust and source ranking fields
CREATE INDEX IF NOT EXISTS idx_user_memory_trust_score
ON user_memory (((metadata->>'trustScore')::DOUBLE PRECISION))
WHERE metadata ? 'trustScore' AND (metadata->>'trustScore') ~ '^-?[0-9]+(\\.[0-9]+)?$';

CREATE INDEX IF NOT EXISTS idx_server_memory_trust_score
ON server_memory (((metadata->>'trustScore')::DOUBLE PRECISION))
WHERE metadata ? 'trustScore' AND (metadata->>'trustScore') ~ '^-?[0-9]+(\\.[0-9]+)?$';

CREATE INDEX IF NOT EXISTS idx_user_memory_source_priority
ON user_memory (((metadata->>'sourcePriority')::INTEGER))
WHERE metadata ? 'sourcePriority' AND (metadata->>'sourcePriority') ~ '^-?[0-9]+$';

CREATE INDEX IF NOT EXISTS idx_server_memory_source_priority
ON server_memory (((metadata->>'sourcePriority')::INTEGER))
WHERE metadata ? 'sourcePriority' AND (metadata->>'sourcePriority') ~ '^-?[0-9]+$';

COMMENT ON INDEX idx_user_memory_conflict_key IS 'Expression index for metadata.conflictKey used by deterministic memory conflict arbitration.';
COMMENT ON INDEX idx_server_memory_conflict_key IS 'Expression index for metadata.conflictKey used by deterministic memory conflict arbitration.';
COMMENT ON INDEX idx_user_memory_trust_score IS 'Expression index for metadata.trustScore used by memory trust-based ranking.';
COMMENT ON INDEX idx_server_memory_trust_score IS 'Expression index for metadata.trustScore used by memory trust-based ranking.';
COMMENT ON INDEX idx_user_memory_source_priority IS 'Expression index for metadata.sourcePriority used by source-priority arbitration.';
COMMENT ON INDEX idx_server_memory_source_priority IS 'Expression index for metadata.sourcePriority used by source-priority arbitration.';