-- Migration 021: Dedicated video quota support
-- Adds video quota tracking and enforces a separate video resource for quota checks.

-- Per-user daily usage tracking
ALTER TABLE usage_tracking
  ADD COLUMN IF NOT EXISTS video_tokens_used INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS video_requests INTEGER DEFAULT 0;

-- Per-guild daily aggregate tracking
ALTER TABLE guild_daily_usage
  ADD COLUMN IF NOT EXISTS total_video_tokens BIGINT DEFAULT 0;

-- Guild-level quota ceiling for video
ALTER TABLE guild_quotas
  ADD COLUMN IF NOT EXISTS daily_video_tokens INTEGER NOT NULL DEFAULT 20;

-- Role-tier quota for video
ALTER TABLE role_tier_quotas
  ADD COLUMN IF NOT EXISTS video_tokens INTEGER NOT NULL DEFAULT 0;

-- Seed global defaults for existing tiers
UPDATE role_tier_quotas SET video_tokens = 20 WHERE guild_id IS NULL AND role_tier = 'admin';
UPDATE role_tier_quotas SET video_tokens = 12 WHERE guild_id IS NULL AND role_tier = 'moderator';
UPDATE role_tier_quotas SET video_tokens = 8 WHERE guild_id IS NULL AND role_tier = 'trusted';
UPDATE role_tier_quotas SET video_tokens = 4 WHERE guild_id IS NULL AND role_tier = 'member';
UPDATE role_tier_quotas SET video_tokens = 0 WHERE guild_id IS NULL AND role_tier = 'restricted';

-- Include video_tokens in tier quota lookup
DROP FUNCTION IF EXISTS get_role_tier_quota(TEXT, TEXT);

CREATE OR REPLACE FUNCTION get_role_tier_quota(
  p_guild_id TEXT,
  p_role_tier TEXT
) RETURNS TABLE(
  text_tokens INTEGER,
  images INTEGER,
  voice_minutes INTEGER,
  vision_tokens INTEGER,
  video_tokens INTEGER
) AS $$
BEGIN
  RETURN QUERY
  SELECT rtq.text_tokens, rtq.images, rtq.voice_minutes, rtq.vision_tokens, rtq.video_tokens
  FROM role_tier_quotas rtq
  WHERE rtq.guild_id = p_guild_id AND rtq.role_tier = p_role_tier
  ORDER BY rtq.updated_at DESC NULLS LAST, rtq.created_at DESC NULLS LAST
  LIMIT 1;

  IF FOUND THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT rtq.text_tokens, rtq.images, rtq.voice_minutes, rtq.vision_tokens, rtq.video_tokens
  FROM role_tier_quotas rtq
  WHERE rtq.guild_id IS NULL AND rtq.role_tier = p_role_tier
  ORDER BY rtq.updated_at DESC NULLS LAST, rtq.created_at DESC NULLS LAST
  LIMIT 1;
END;
$$ LANGUAGE plpgsql STABLE;

-- Extend guild quota checks with video_tokens
CREATE OR REPLACE FUNCTION check_guild_quota(
  p_guild_id TEXT,
  p_resource TEXT,
  p_amount INTEGER DEFAULT 1
) RETURNS BOOLEAN AS $$
DECLARE
  quota_limit INTEGER;
  current_usage INTEGER;
BEGIN
  SELECT
    CASE p_resource
      WHEN 'text_tokens' THEN COALESCE(q.daily_text_tokens, 50000)
      WHEN 'images' THEN COALESCE(q.daily_images, 5)
      WHEN 'voice_minutes' THEN COALESCE(q.daily_voice_minutes, 15)
      WHEN 'vision_tokens' THEN COALESCE(q.daily_vision_tokens, 20000)
      WHEN 'video_tokens' THEN COALESCE(q.daily_video_tokens, 20)
      ELSE 0
    END INTO quota_limit
  FROM guild_quotas q
  WHERE q.guild_id = p_guild_id;

  IF NOT FOUND THEN
    quota_limit := CASE p_resource
      WHEN 'text_tokens' THEN 50000
      WHEN 'images' THEN 5
      WHEN 'voice_minutes' THEN 15
      WHEN 'vision_tokens' THEN 20000
      WHEN 'video_tokens' THEN 20
      ELSE 0
    END;
  END IF;

  SELECT
    CASE p_resource
      WHEN 'text_tokens' THEN COALESCE(SUM(text_tokens_used), 0)
      WHEN 'images' THEN COALESCE(SUM(images_used), 0)
      WHEN 'voice_minutes' THEN COALESCE(SUM(voice_minutes_used), 0)
      WHEN 'vision_tokens' THEN COALESCE(SUM(vision_tokens_used), 0)
      WHEN 'video_tokens' THEN COALESCE(SUM(video_tokens_used), 0)
      ELSE 0
    END INTO current_usage
  FROM usage_tracking
  WHERE guild_id = p_guild_id
    AND usage_date = quota_local_date();

  RETURN (current_usage + p_amount) <= quota_limit;
END;
$$ LANGUAGE plpgsql;

-- Extend non-atomic increment with video_tokens
CREATE OR REPLACE FUNCTION increment_usage(
  p_guild_id TEXT,
  p_user_id TEXT,
  p_resource TEXT,
  p_amount INTEGER DEFAULT 1
) RETURNS BOOLEAN AS $$
DECLARE
  within_quota BOOLEAN;
BEGIN
  within_quota := check_guild_quota(p_guild_id, p_resource, p_amount);

  IF NOT within_quota THEN
    RETURN FALSE;
  END IF;

  PERFORM get_or_create_usage(p_guild_id, p_user_id);

  UPDATE usage_tracking
  SET
    text_tokens_used = CASE WHEN p_resource = 'text_tokens' THEN text_tokens_used + p_amount ELSE text_tokens_used END,
    images_used = CASE WHEN p_resource = 'images' THEN images_used + p_amount ELSE images_used END,
    voice_minutes_used = CASE WHEN p_resource = 'voice_minutes' THEN voice_minutes_used + p_amount ELSE voice_minutes_used END,
    vision_tokens_used = CASE WHEN p_resource = 'vision_tokens' THEN vision_tokens_used + p_amount ELSE vision_tokens_used END,
    video_tokens_used = CASE WHEN p_resource = 'video_tokens' THEN video_tokens_used + p_amount ELSE video_tokens_used END,
    text_requests = CASE WHEN p_resource = 'text_tokens' THEN text_requests + 1 ELSE text_requests END,
    image_requests = CASE WHEN p_resource = 'images' THEN image_requests + 1 ELSE image_requests END,
    voice_requests = CASE WHEN p_resource = 'voice_minutes' THEN voice_requests + 1 ELSE voice_requests END,
    vision_requests = CASE WHEN p_resource = 'vision_tokens' THEN vision_requests + 1 ELSE vision_requests END,
    video_requests = CASE WHEN p_resource = 'video_tokens' THEN video_requests + 1 ELSE video_requests END,
    updated_at = NOW()
  WHERE guild_id = p_guild_id
    AND user_id = p_user_id
    AND usage_date = quota_local_date();

  INSERT INTO guild_daily_usage (
    guild_id,
    usage_date,
    total_text_tokens,
    total_images,
    total_voice_minutes,
    total_vision_tokens,
    total_video_tokens
  )
  VALUES (
    p_guild_id,
    quota_local_date(),
    CASE WHEN p_resource = 'text_tokens' THEN p_amount ELSE 0 END,
    CASE WHEN p_resource = 'images' THEN p_amount ELSE 0 END,
    CASE WHEN p_resource = 'voice_minutes' THEN p_amount ELSE 0 END,
    CASE WHEN p_resource = 'vision_tokens' THEN p_amount ELSE 0 END,
    CASE WHEN p_resource = 'video_tokens' THEN p_amount ELSE 0 END
  )
  ON CONFLICT (guild_id, usage_date) DO UPDATE SET
    total_text_tokens = guild_daily_usage.total_text_tokens + CASE WHEN p_resource = 'text_tokens' THEN p_amount ELSE 0 END,
    total_images = guild_daily_usage.total_images + CASE WHEN p_resource = 'images' THEN p_amount ELSE 0 END,
    total_voice_minutes = guild_daily_usage.total_voice_minutes + CASE WHEN p_resource = 'voice_minutes' THEN p_amount ELSE 0 END,
    total_vision_tokens = guild_daily_usage.total_vision_tokens + CASE WHEN p_resource = 'vision_tokens' THEN p_amount ELSE 0 END,
    total_video_tokens = guild_daily_usage.total_video_tokens + CASE WHEN p_resource = 'video_tokens' THEN p_amount ELSE 0 END,
    updated_at = NOW();

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- Extend atomic increment with video_tokens branch
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
  VALUES (p_guild_id, p_user_id, quota_local_date())
  ON CONFLICT (guild_id, user_id, usage_date) DO NOTHING;

  IF p_resource = 'text_tokens' THEN
    UPDATE usage_tracking
    SET text_tokens_used = text_tokens_used + p_amount,
        text_requests = text_requests + 1,
        updated_at = NOW()
    WHERE guild_id = p_guild_id
      AND user_id = p_user_id
      AND usage_date = quota_local_date()
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
      AND usage_date = quota_local_date()
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
      AND usage_date = quota_local_date()
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
      AND usage_date = quota_local_date()
      AND vision_tokens_used + p_amount <= p_user_limit
    RETURNING TRUE AS success, vision_tokens_used AS new_total, p_user_limit - vision_tokens_used AS remaining
    INTO v_result;

  ELSIF p_resource = 'video_tokens' THEN
    UPDATE usage_tracking
    SET video_tokens_used = video_tokens_used + p_amount,
        video_requests = video_requests + 1,
        updated_at = NOW()
    WHERE guild_id = p_guild_id
      AND user_id = p_user_id
      AND usage_date = quota_local_date()
      AND video_tokens_used + p_amount <= p_user_limit
    RETURNING TRUE AS success, video_tokens_used AS new_total, p_user_limit - video_tokens_used AS remaining
    INTO v_result;
  END IF;

  IF FOUND THEN
    INSERT INTO guild_daily_usage (
      guild_id,
      usage_date,
      total_text_tokens,
      total_images,
      total_voice_minutes,
      total_vision_tokens,
      total_video_tokens
    )
    VALUES (
      p_guild_id,
      quota_local_date(),
      CASE WHEN p_resource = 'text_tokens' THEN p_amount ELSE 0 END,
      CASE WHEN p_resource = 'images' THEN p_amount ELSE 0 END,
      CASE WHEN p_resource = 'voice_minutes' THEN p_amount ELSE 0 END,
      CASE WHEN p_resource = 'vision_tokens' THEN p_amount ELSE 0 END,
      CASE WHEN p_resource = 'video_tokens' THEN p_amount ELSE 0 END
    )
    ON CONFLICT (guild_id, usage_date) DO UPDATE SET
      total_text_tokens = guild_daily_usage.total_text_tokens + CASE WHEN p_resource = 'text_tokens' THEN p_amount ELSE 0 END,
      total_images = guild_daily_usage.total_images + CASE WHEN p_resource = 'images' THEN p_amount ELSE 0 END,
      total_voice_minutes = guild_daily_usage.total_voice_minutes + CASE WHEN p_resource = 'voice_minutes' THEN p_amount ELSE 0 END,
      total_vision_tokens = guild_daily_usage.total_vision_tokens + CASE WHEN p_resource = 'vision_tokens' THEN p_amount ELSE 0 END,
      total_video_tokens = guild_daily_usage.total_video_tokens + CASE WHEN p_resource = 'video_tokens' THEN p_amount ELSE 0 END,
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
      WHEN 'video_tokens' THEN video_tokens_used
      ELSE 0
    END
  INTO v_current
  FROM usage_tracking
  WHERE guild_id = p_guild_id
    AND user_id = p_user_id
    AND usage_date = quota_local_date();

  v_current := COALESCE(v_current, 0);

  RETURN QUERY SELECT FALSE, v_current, GREATEST(0, p_user_limit - v_current);
END;
$$ LANGUAGE plpgsql;

-- Extend stats helper with video token usage
CREATE OR REPLACE FUNCTION get_guild_quota_stats(p_guild_id TEXT)
RETURNS TABLE(
  text_tokens_used BIGINT,
  images_used BIGINT,
  voice_minutes_used BIGINT,
  vision_tokens_used BIGINT,
  video_tokens_used BIGINT,
  unique_users BIGINT,
  pending_reset_notifications BIGINT
) AS $$
  SELECT
    COALESCE(SUM(ut.text_tokens_used), 0) as text_tokens_used,
    COALESCE(SUM(ut.images_used), 0) as images_used,
    COALESCE(SUM(ut.voice_minutes_used), 0) as voice_minutes_used,
    COALESCE(SUM(ut.vision_tokens_used), 0) as vision_tokens_used,
    COALESCE(SUM(ut.video_tokens_used), 0) as video_tokens_used,
    COUNT(DISTINCT ut.user_id) as unique_users,
    (SELECT COUNT(*) FROM quota_reset_notifications WHERE guild_id = p_guild_id) as pending_reset_notifications
  FROM usage_tracking ut
  WHERE ut.guild_id = p_guild_id AND ut.usage_date = quota_local_date();
$$ LANGUAGE sql STABLE;
