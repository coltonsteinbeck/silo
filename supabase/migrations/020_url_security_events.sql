CREATE TABLE
IF NOT EXISTS url_security_events
(
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4
(),
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT,
  -- Store only normalized URL values (no query string or fragment) in this column.
  url TEXT NOT NULL,
  -- Optional deterministic hash for privacy-preserving correlation.
  url_hash TEXT,
  domain TEXT NOT NULL,
  action TEXT NOT NULL CHECK
(action IN
('allowed', 'blocked', 'skipped')),
  reason TEXT NOT NULL,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW
()
);

CREATE INDEX
IF NOT EXISTS idx_url_security_events_guild_created
  ON url_security_events
(guild_id, created_at DESC);

CREATE INDEX
IF NOT EXISTS idx_url_security_events_domain
  ON url_security_events
(domain);

CREATE INDEX
IF NOT EXISTS idx_url_security_events_action
  ON url_security_events
(action, created_at DESC);

CREATE INDEX
IF NOT EXISTS idx_url_security_events_url_hash
  ON url_security_events
(url_hash);

-- ============================================================================
-- DOWN MIGRATION (uncomment to rollback)
-- ============================================================================

-- DROP INDEX IF EXISTS idx_url_security_events_url_hash;
-- DROP INDEX IF EXISTS idx_url_security_events_action;
-- DROP INDEX IF EXISTS idx_url_security_events_domain;
-- DROP INDEX IF EXISTS idx_url_security_events_guild_created;
-- DROP TABLE IF EXISTS url_security_events;
