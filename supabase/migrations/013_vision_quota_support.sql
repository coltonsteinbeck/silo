-- Migration 013: Vision quota support
-- Adds vision token usage/quota tracking and extends atomic quota updates.

-- Per-user daily usage tracking
ALTER TABLE usage_tracking
  ADD COLUMN IF NOT EXISTS vision_tokens_used INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS vision_requests INTEGER DEFAULT 0;

-- Per-guild daily aggregate tracking
ALTER TABLE guild_daily_usage
  ADD COLUMN IF NOT EXISTS total_vision_tokens BIGINT DEFAULT 0;

-- Guild-level quota ceiling for vision
ALTER TABLE guild_quotas
  ADD COLUMN IF NOT EXISTS daily_vision_tokens INTEGER NOT NULL DEFAULT 20000;

-- Role-tier quota for vision
ALTER TABLE role_tier_quotas
  ADD COLUMN IF NOT EXISTS vision_tokens INTEGER NOT NULL DEFAULT 5000;

-- Seed global defaults for existing tiers
UPDATE role_tier_quotas SET vision_tokens = 10000 WHERE guild_id IS NULL AND role_tier = 'admin';
UPDATE role_tier_quotas SET vision_tokens = 5000 WHERE guild_id IS NULL AND role_tier = 'moderator';
UPDATE role_tier_quotas SET vision_tokens = 3000 WHERE guild_id IS NULL AND role_tier = 'trusted';
UPDATE role_tier_quotas SET vision_tokens = 1000 WHERE guild_id IS NULL AND role_tier = 'member';
UPDATE role_tier_quotas SET vision_tokens = 0 WHERE guild_id IS NULL AND role_tier = 'restricted';

-- Include vision_tokens in tier quota lookup
DROP FUNCTION IF EXISTS get_role_tier_quota(TEXT, TEXT);

CREATE OR REPLACE FUNCTION get_role_tier_quota(
  p_guild_id TEXT,
  p_role_tier TEXT
) RETURNS TABLE(text_tokens INTEGER, images INTEGER, voice_minutes INTEGER, vision_tokens INTEGER) AS $$
BEGIN
  RETURN QUERY
  SELECT rtq.text_tokens, rtq.images, rtq.voice_minutes, rtq.vision_tokens
  FROM role_tier_quotas rtq
  WHERE rtq.guild_id = p_guild_id AND rtq.role_tier = p_role_tier;

  IF FOUND THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT rtq.text_tokens, rtq.images, rtq.voice_minutes, rtq.vision_tokens
  FROM role_tier_quotas rtq
  WHERE rtq.guild_id IS NULL AND rtq.role_tier = p_role_tier;
END;
$$ LANGUAGE plpgsql STABLE;

-- Extend atomic usage increment with vision_tokens branch
CREATE OR REPLACE FUNCTION increment_usage_atomic(
  p_guild_id TEXT,
  p_user_id TEXT,
  p_resource TEXT,
  p_amount INTEGER,
  p_user_limit INTEGER
) RETURNS TABLE(success BOOLEAN, new_total INTEGER, remaining INTEGER) AS $$
DECLARE
  v_current INTEGER;
  v_result RECORD;
BEGIN
  INSERT INTO usage_tracking (guild_id, user_id, usage_date)
  VALUES (p_guild_id, p_user_id, CURRENT_DATE)
  ON CONFLICT (guild_id, user_id, usage_date) DO NOTHING;

  IF p_resource = 'text_tokens' THEN
    UPDATE usage_tracking
    SET text_tokens_used = text_tokens_used + p_amount,
        text_requests = text_requests + 1,
        updated_at = NOW()
    WHERE guild_id = p_guild_id
      AND user_id = p_user_id
      AND usage_date = CURRENT_DATE
      AND text_tokens_used + p_amount <= p_user_limit
    RETURNING TRUE AS success, text_tokens_used AS new_total, p_user_limit - text_tokens_used AS remaining
    INTO v_result;

  ELSIF p_resource = 'images' THEN
    UPDATE usage_tracking
    SET images_used = images_used + p_amount,
        image_requests = image_requests + 1,
        updated_at = NOW()
    WHERE guild_id = p_guild_id
      AND user_id = p_user_id
      AND usage_date = CURRENT_DATE
      AND images_used + p_amount <= p_user_limit
    RETURNING TRUE AS success, images_used AS new_total, p_user_limit - images_used AS remaining
    INTO v_result;

  ELSIF p_resource = 'voice_minutes' THEN
    UPDATE usage_tracking
    SET voice_minutes_used = voice_minutes_used + p_amount,
        voice_requests = voice_requests + 1,
        updated_at = NOW()
    WHERE guild_id = p_guild_id
      AND user_id = p_user_id
      AND usage_date = CURRENT_DATE
      AND voice_minutes_used + p_amount <= p_user_limit
    RETURNING TRUE AS success, voice_minutes_used AS new_total, p_user_limit - voice_minutes_used AS remaining
    INTO v_result;

  ELSIF p_resource = 'vision_tokens' THEN
    UPDATE usage_tracking
    SET vision_tokens_used = vision_tokens_used + p_amount,
        vision_requests = vision_requests + 1,
        updated_at = NOW()
    WHERE guild_id = p_guild_id
      AND user_id = p_user_id
      AND usage_date = CURRENT_DATE
      AND vision_tokens_used + p_amount <= p_user_limit
    RETURNING TRUE AS success, vision_tokens_used AS new_total, p_user_limit - vision_tokens_used AS remaining
    INTO v_result;
  END IF;

  IF FOUND THEN
    INSERT INTO guild_daily_usage (
      guild_id,
      usage_date,
      total_text_tokens,
      total_images,
      total_voice_minutes,
      total_vision_tokens
    )
    VALUES (
      p_guild_id,
      CURRENT_DATE,
      CASE WHEN p_resource = 'text_tokens' THEN p_amount ELSE 0 END,
      CASE WHEN p_resource = 'images' THEN p_amount ELSE 0 END,
      CASE WHEN p_resource = 'voice_minutes' THEN p_amount ELSE 0 END,
      CASE WHEN p_resource = 'vision_tokens' THEN p_amount ELSE 0 END
    )
    ON CONFLICT (guild_id, usage_date) DO UPDATE SET
      total_text_tokens = guild_daily_usage.total_text_tokens + CASE WHEN p_resource = 'text_tokens' THEN p_amount ELSE 0 END,
      total_images = guild_daily_usage.total_images + CASE WHEN p_resource = 'images' THEN p_amount ELSE 0 END,
      total_voice_minutes = guild_daily_usage.total_voice_minutes + CASE WHEN p_resource = 'voice_minutes' THEN p_amount ELSE 0 END,
      total_vision_tokens = guild_daily_usage.total_vision_tokens + CASE WHEN p_resource = 'vision_tokens' THEN p_amount ELSE 0 END,
      updated_at = NOW();

    RETURN QUERY SELECT v_result.success, v_result.new_total, v_result.remaining;
    RETURN;
  END IF;

  SELECT
    CASE p_resource
      WHEN 'text_tokens' THEN text_tokens_used
      WHEN 'images' THEN images_used
      WHEN 'voice_minutes' THEN voice_minutes_used
      WHEN 'vision_tokens' THEN vision_tokens_used
      ELSE 0
    END INTO v_current
  FROM usage_tracking
  WHERE guild_id = p_guild_id AND user_id = p_user_id AND usage_date = CURRENT_DATE;

  v_current := COALESCE(v_current, 0);

  RETURN QUERY SELECT FALSE, v_current, GREATEST(0, p_user_limit - v_current);
END;
$$ LANGUAGE plpgsql;
