-- Migration: Add system prompts for guilds
-- Allows each guild to customize the AI's system prompt for responses

-- Add system_prompt column to server_config
ALTER TABLE server_config 
ADD COLUMN IF NOT EXISTS system_prompt TEXT;

-- Add system_prompt_enabled flag (for quick enable/disable without losing prompt)
ALTER TABLE server_config 
ADD COLUMN IF NOT EXISTS system_prompt_enabled BOOLEAN DEFAULT true;

-- Add system_prompt_updated_at for tracking when prompts were last modified
ALTER TABLE server_config 
ADD COLUMN IF NOT EXISTS system_prompt_updated_at TIMESTAMP WITH TIME ZONE;

-- Add voice_system_prompt for separate voice channel behavior (optional)
ALTER TABLE server_config 
ADD COLUMN IF NOT EXISTS voice_system_prompt TEXT;

-- Create index for guilds with custom prompts (for analytics)
CREATE INDEX IF NOT EXISTS idx_server_config_has_system_prompt 
ON server_config ((system_prompt IS NOT NULL)) 
WHERE system_prompt IS NOT NULL;

-- Comments for documentation
COMMENT ON COLUMN server_config.system_prompt IS 
'Custom system prompt prepended to AI responses. Max 4000 characters recommended.';

COMMENT ON COLUMN server_config.system_prompt_enabled IS 
'Whether to use the custom system prompt. Allows quick toggle without losing the prompt content.';

COMMENT ON COLUMN server_config.voice_system_prompt IS 
'Optional separate system prompt for voice interactions. Falls back to system_prompt if null.';

-- Function to update system_prompt_updated_at automatically
CREATE OR REPLACE FUNCTION update_system_prompt_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.system_prompt IS DISTINCT FROM NEW.system_prompt 
     OR OLD.voice_system_prompt IS DISTINCT FROM NEW.voice_system_prompt THEN
    NEW.system_prompt_updated_at = NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-update timestamp when prompt changes
DROP TRIGGER IF EXISTS update_system_prompt_timestamp_trigger ON server_config;
CREATE TRIGGER update_system_prompt_timestamp_trigger
BEFORE UPDATE ON server_config
FOR EACH ROW
EXECUTE FUNCTION update_system_prompt_timestamp();
