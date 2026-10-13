-- Claim message ingress before moderation, generation or delivery. Claims survive
-- process restarts; uncertain attempts are never automatically replayed.
CREATE TABLE IF NOT EXISTS assistant_message_ingress (
    message_id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS assistant_message_ingress_created_at_idx
    ON assistant_message_ingress (created_at);
