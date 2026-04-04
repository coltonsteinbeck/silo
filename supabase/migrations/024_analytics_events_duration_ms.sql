-- Migration 024: Track real voice duration for analytics rollups.
--
-- response_time_ms captures request latency, not media duration. Add duration_ms
-- so voice usage and billing summaries can aggregate true spoken minutes.

ALTER TABLE analytics_events
  ADD COLUMN
IF NOT EXISTS duration_ms INTEGER;

CREATE INDEX
IF NOT EXISTS idx_analytics_events_duration_ms
  ON analytics_events
(duration_ms)
  WHERE duration_ms IS NOT NULL;

-- ============================================================================
-- DOWN MIGRATION (uncomment to rollback)
-- ============================================================================

-- DROP INDEX IF EXISTS idx_analytics_events_duration_ms;
-- ALTER TABLE analytics_events DROP COLUMN IF EXISTS duration_ms;
