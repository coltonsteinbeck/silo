-- Migration: Add guild_id and prompt_hash to conversation_messages
-- This migration wipes existing conversations to:
-- 1. Clear stale/hallucinated context from old AI responses
-- 2. Ensure all records have the new columns populated

-- First, truncate the table to clear old conversation history
-- This stops hallucination from cached "I'm GPT-3.5" type responses
TRUNCATE TABLE conversation_messages;

-- Add guild_id column (required for per-guild conversation management)
ALTER TABLE conversation_messages
ADD COLUMN IF NOT EXISTS guild_id TEXT NOT NULL DEFAULT '';

-- Add prompt_hash column to track which prompt context this message belongs to
-- 'default' = using provider default prompt, otherwise SHA256 hash of custom prompt
ALTER TABLE conversation_messages
ADD COLUMN IF NOT EXISTS prompt_hash TEXT NOT NULL DEFAULT 'default';

-- Add index for guild-based queries
CREATE INDEX IF NOT EXISTS idx_conversation_guild_id 
ON conversation_messages(guild_id);

-- Add composite index for efficient guild+channel lookups
CREATE INDEX IF NOT EXISTS idx_conversation_guild_channel 
ON conversation_messages(guild_id, channel_id);

-- Add index for prompt-based conversation isolation
CREATE INDEX IF NOT EXISTS idx_conversation_prompt_hash
ON conversation_messages(channel_id, prompt_hash);

-- Add composite index for per-user conversation context (guild + prompt + user)
CREATE INDEX IF NOT EXISTS idx_conversation_user_context
ON conversation_messages(guild_id, prompt_hash, user_id, created_at DESC);

-- Add composite index for full conversation context lookups
CREATE INDEX IF NOT EXISTS idx_conversation_channel_prompt
ON conversation_messages(channel_id, prompt_hash, created_at DESC);

-- Update RLS policy to include guild_id awareness (if RLS is enabled)
DROP POLICY IF EXISTS "service_role_all_conversations" ON conversation_messages;
CREATE POLICY "service_role_all_conversations" ON conversation_messages
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON COLUMN conversation_messages.guild_id IS 
'Discord guild/server ID for per-server conversation isolation';

COMMENT ON COLUMN conversation_messages.prompt_hash IS 
'Hash of the system prompt used for this message. "default" means provider default prompt was used. Allows conversation history isolation per prompt context.';
