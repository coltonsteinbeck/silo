-- Backend-only credentials and durable, at-most-once release delivery claims.
CREATE TABLE IF NOT EXISTS guild_patch_note_webhooks (
    guild_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    webhook_id TEXT NOT NULL UNIQUE,
    encrypted_token TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS guild_patch_note_deliveries (
    guild_id TEXT NOT NULL REFERENCES guild_patch_note_webhooks(guild_id),
    version TEXT NOT NULL,
    notes_sha256 TEXT NOT NULL,
    created_by TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'attempted' CHECK (status IN ('attempted', 'delivered')),
    message_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (guild_id, version),
    CHECK ((status = 'delivered') = (message_id IS NOT NULL))
);

ALTER TABLE guild_patch_note_webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE guild_patch_note_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON guild_patch_note_webhooks, guild_patch_note_deliveries FROM PUBLIC;
DO $$
DECLARE role_name TEXT;
BEGIN
    FOR role_name IN SELECT rolname FROM pg_roles
      WHERE rolname IN ('anon', 'authenticated', 'service_role', 'authenticator')
    LOOP
        EXECUTE format('REVOKE ALL ON guild_patch_note_webhooks, guild_patch_note_deliveries FROM %I', role_name);
    END LOOP;
END $$;
