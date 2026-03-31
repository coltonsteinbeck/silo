CREATE TABLE IF NOT EXISTS url_security_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT,
  url TEXT NOT NULL,
  domain TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('allowed', 'blocked', 'skipped')),
  reason TEXT NOT NULL,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_url_security_events_guild_created
  ON url_security_events (guild_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_url_security_events_domain
  ON url_security_events (domain);

CREATE INDEX IF NOT EXISTS idx_url_security_events_action
  ON url_security_events (action, created_at DESC);
