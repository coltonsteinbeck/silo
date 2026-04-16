-- Migration 015: Reply-aware conversation context for multimodal tracking
-- Adds optional metadata to preserve reply linkage and normalized image summaries.

ALTER TABLE conversation_messages
  ADD COLUMN IF NOT EXISTS discord_message_id TEXT,
  ADD COLUMN IF NOT EXISTS reply_to_message_id TEXT,
  ADD COLUMN IF NOT EXISTS reply_to_user_id TEXT,
  ADD COLUMN IF NOT EXISTS referenced_content TEXT,
  ADD COLUMN IF NOT EXISTS image_summary TEXT;

CREATE INDEX IF NOT EXISTS idx_conversation_discord_message_id
ON conversation_messages (discord_message_id)
WHERE discord_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conversation_reply_to_message_id
ON conversation_messages (reply_to_message_id)
WHERE reply_to_message_id IS NOT NULL;

COMMENT ON COLUMN conversation_messages.discord_message_id IS 'Discord message ID for source event message.';
COMMENT ON COLUMN conversation_messages.reply_to_message_id IS 'Discord message ID of direct reply target when present.';
COMMENT ON COLUMN conversation_messages.reply_to_user_id IS 'Author ID for direct reply target when present.';
COMMENT ON COLUMN conversation_messages.referenced_content IS 'Normalized text context extracted from reply chain.';
COMMENT ON COLUMN conversation_messages.image_summary IS 'Normalized image understanding summary used for this turn.';
