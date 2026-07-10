-- Migration 025: Turn-aware, prompt-safe conversation context.
-- Legacy rows remain available for audit/export but are deliberately ineligible
-- for prompt reuse until they have explicit turn and safety metadata.

ALTER TABLE conversation_messages
  ADD COLUMN IF NOT EXISTS turn_id UUID,
  ADD COLUMN IF NOT EXISTS turn_sequence SMALLINT,
  ADD COLUMN IF NOT EXISTS requester_user_id TEXT,
  ADD COLUMN IF NOT EXISTS prompt_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS safety_state TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS safety_categories JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE conversation_messages
  DROP CONSTRAINT IF EXISTS conversation_messages_turn_sequence_check,
  ADD CONSTRAINT conversation_messages_turn_sequence_check
    CHECK (
      turn_sequence IS NULL OR
      (turn_sequence = 0 AND role = 'user') OR
      (turn_sequence = 1 AND role = 'assistant')
    );

ALTER TABLE conversation_messages
  DROP CONSTRAINT IF EXISTS conversation_messages_turn_metadata_check,
  ADD CONSTRAINT conversation_messages_turn_metadata_check
    CHECK (
      (turn_id IS NULL AND turn_sequence IS NULL AND requester_user_id IS NULL) OR
      (turn_id IS NOT NULL AND turn_sequence IS NOT NULL AND requester_user_id IS NOT NULL)
    );

ALTER TABLE conversation_messages
  DROP CONSTRAINT IF EXISTS conversation_messages_turn_requester_check,
  ADD CONSTRAINT conversation_messages_turn_requester_check
    CHECK (turn_sequence IS NULL OR turn_sequence <> 0 OR requester_user_id = user_id);

ALTER TABLE conversation_messages
  DROP CONSTRAINT IF EXISTS conversation_messages_new_turn_safety_state_check,
  ADD CONSTRAINT conversation_messages_new_turn_safety_state_check
    CHECK (turn_id IS NULL OR safety_state <> 'legacy');

ALTER TABLE conversation_messages
  DROP CONSTRAINT IF EXISTS conversation_messages_prompt_eligible_turn_check,
  ADD CONSTRAINT conversation_messages_prompt_eligible_turn_check
    CHECK (
      NOT prompt_eligible OR
      (
        turn_id IS NOT NULL AND
        turn_sequence IS NOT NULL AND
        requester_user_id IS NOT NULL AND
        safety_state IN ('allowed', 'output_repaired', 'quality_repaired')
      )
    );

ALTER TABLE conversation_messages
  DROP CONSTRAINT IF EXISTS conversation_messages_safety_categories_check,
  ADD CONSTRAINT conversation_messages_safety_categories_check
    CHECK (jsonb_typeof(safety_categories) = 'array');

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_turn_sequence
ON conversation_messages (turn_id, turn_sequence)
WHERE turn_id IS NOT NULL AND turn_sequence IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conversation_prompt_context_same_user
ON conversation_messages (
  guild_id,
  channel_id,
  prompt_hash,
  requester_user_id,
  created_at DESC,
  turn_id,
  turn_sequence
)
WHERE prompt_eligible = TRUE;

CREATE INDEX IF NOT EXISTS idx_conversation_prompt_context_candidates
ON conversation_messages (
  guild_id,
  channel_id,
  prompt_hash,
  requester_user_id,
  created_at DESC,
  turn_id
)
WHERE turn_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conversation_prompt_context_reply
ON conversation_messages (guild_id, channel_id, prompt_hash, discord_message_id, turn_id)
WHERE prompt_eligible = TRUE AND discord_message_id IS NOT NULL;

COMMENT ON COLUMN conversation_messages.turn_id IS
  'Stable identifier shared by the user and assistant rows for one completed turn.';
COMMENT ON COLUMN conversation_messages.turn_sequence IS
  'Causal ordering within a turn: 0=user, 1=assistant.';
COMMENT ON COLUMN conversation_messages.requester_user_id IS
  'Discord user who initiated the turn; present on both user and assistant rows.';
COMMENT ON COLUMN conversation_messages.prompt_eligible IS
  'Whether the row belongs to a completed safe turn that may be reused as model context.';
COMMENT ON COLUMN conversation_messages.safety_state IS
  'Final turn safety outcome such as allowed, output_repaired, redirected, or blocked.';
COMMENT ON COLUMN conversation_messages.safety_categories IS
  'Stable safety categories associated with the final turn outcome.';
