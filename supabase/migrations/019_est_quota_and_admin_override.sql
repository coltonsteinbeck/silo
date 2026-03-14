-- Migration 019: Quota day boundary to America/New_York and admin override support
--
-- Purpose:
-- - Shift quota reset/usage bucketing from UTC date boundaries to ET (America/New_York).
-- - Add admin quota override with 24-hour cooldown auditing.

-- Canonical quota date in ET.
CREATE OR REPLACE FUNCTION quota_local_date()
RETURNS DATE
AS $$
  SELECT DATE(timezone('America/New_York', NOW()));
$$ LANGUAGE sql STABLE;

-- Legacy helper updated to ET date.
CREATE OR REPLACE FUNCTION get_or_create_usage(
  p_guild_id TEXT,
  p_user_id TEXT
) RETURNS usage_tracking AS $$
DECLARE
  usage_record usage_tracking;
BEGIN
  SELECT * INTO usage_record
  FROM usage_tracking
  WHERE guild_id = p_guild_id
    AND user_id = p_user_id
    AND usage_date = quota_local_date();

  IF NOT FOUND THEN
    INSERT INTO usage_tracking (guild_id, user_id, usage_date)
    VALUES (p_guild_id, p_user_id, quota_local_date())
    RETURNING * INTO usage_record;
  END IF;

  RETURN usage_record;
END;
$$ LANGUAGE plpgsql;

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
      ELSE 0
    END INTO quota_limit
  FROM guild_quotas q
  WHERE q.guild_id = p_guild_id;

  IF NOT FOUND THEN
    quota_limit := CASE p_resource
      WHEN 'text_tokens' THEN 50000
      WHEN 'images' THEN 5
      WHEN 'voice_minutes' THEN 15
      ELSE 0
    END;
  END IF;

  SELECT
    CASE p_resource
      WHEN 'text_tokens' THEN COALESCE(SUM(text_tokens_used), 0)
      WHEN 'images' THEN COALESCE(SUM(images_used), 0)
      WHEN 'voice_minutes' THEN COALESCE(SUM(voice_minutes_used), 0)
      ELSE 0
    END INTO current_usage
  FROM usage_tracking
  WHERE guild_id = p_guild_id
    AND usage_date = quota_local_date();

  RETURN (current_usage + p_amount) <= quota_limit;
END;
$$ LANGUAGE plpgsql;

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
    text_requests = CASE WHEN p_resource = 'text_tokens' THEN text_requests + 1 ELSE text_requests END,
    image_requests = CASE WHEN p_resource = 'images' THEN image_requests + 1 ELSE image_requests END,
    voice_requests = CASE WHEN p_resource = 'voice_minutes' THEN voice_requests + 1 ELSE voice_requests END,
    updated_at = NOW()
  WHERE guild_id = p_guild_id
    AND user_id = p_user_id
    AND usage_date = quota_local_date();

  INSERT INTO guild_daily_usage (guild_id, usage_date, total_text_tokens, total_images, total_voice_minutes)
  VALUES (
    p_guild_id,
    quota_local_date(),
    CASE WHEN p_resource = 'text_tokens' THEN p_amount ELSE 0 END,
    CASE WHEN p_resource = 'images' THEN p_amount ELSE 0 END,
    CASE WHEN p_resource = 'voice_minutes' THEN p_amount ELSE 0 END
  )
  ON CONFLICT (guild_id, usage_date) DO UPDATE SET
    total_text_tokens = guild_daily_usage.total_text_tokens + CASE WHEN p_resource = 'text_tokens' THEN p_amount ELSE 0 END,
    total_images = guild_daily_usage.total_images + CASE WHEN p_resource = 'images' THEN p_amount ELSE 0 END,
    total_voice_minutes = guild_daily_usage.total_voice_minutes + CASE WHEN p_resource = 'voice_minutes' THEN p_amount ELSE 0 END,
    updated_at = NOW();

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- Main atomic increment updated to ET date.
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
      quota_local_date(),
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

CREATE OR REPLACE FUNCTION cleanup_old_usage(p_days INTEGER DEFAULT 90)
RETURNS TABLE(usage_deleted INTEGER, guild_usage_deleted INTEGER)
AS $$
DECLARE
  v_usage_deleted INTEGER;
  v_guild_deleted INTEGER;
BEGIN
  DELETE FROM usage_tracking WHERE usage_date < quota_local_date() - p_days;
  GET DIAGNOSTICS v_usage_deleted = ROW_COUNT;

  DELETE FROM guild_daily_usage WHERE usage_date < quota_local_date() - p_days;
  GET DIAGNOSTICS v_guild_deleted = ROW_COUNT;

  RETURN QUERY SELECT v_usage_deleted, v_guild_deleted;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION get_users_needing_reset_notification()
RETURNS TABLE(
  guild_id TEXT,
  user_id TEXT,
  channel_id TEXT,
  exhausted_at TIMESTAMP WITH TIME ZONE
) AS $$
  SELECT qrn.guild_id, qrn.user_id, qrn.channel_id, qrn.exhausted_at
  FROM quota_reset_notifications qrn
  WHERE DATE(timezone('America/New_York', qrn.exhausted_at)) < quota_local_date();
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION get_guild_quota_stats(p_guild_id TEXT)
RETURNS TABLE(
  text_tokens_used BIGINT,
  images_used BIGINT,
  voice_minutes_used BIGINT,
  unique_users BIGINT,
  pending_reset_notifications BIGINT
) AS $$
  SELECT
    COALESCE(SUM(ut.text_tokens_used), 0) as text_tokens_used,
    COALESCE(SUM(ut.images_used), 0) as images_used,
    COALESCE(SUM(ut.voice_minutes_used), 0) as voice_minutes_used,
    COUNT(DISTINCT ut.user_id) as unique_users,
    (SELECT COUNT(*) FROM quota_reset_notifications WHERE guild_id = p_guild_id) as pending_reset_notifications
  FROM usage_tracking ut
  WHERE ut.guild_id = p_guild_id AND ut.usage_date = quota_local_date();
$$ LANGUAGE sql STABLE;

-- Admin override audit with one-call-per-24h cooldown enforced in application logic.
CREATE TABLE IF NOT EXISTS quota_override_audit (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  admin_user_id TEXT NOT NULL,
  target_user_id TEXT,
  scope TEXT NOT NULL CHECK (scope IN ('user', 'all')),
  usage_date DATE NOT NULL DEFAULT quota_local_date(),
  applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quota_override_audit_admin_time
  ON quota_override_audit(guild_id, admin_user_id, applied_at DESC);

CREATE INDEX IF NOT EXISTS idx_quota_override_audit_usage_date
  ON quota_override_audit(guild_id, usage_date DESC);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'quota_override_audit' AND schemaname = 'public') THEN
    EXECUTE 'ALTER TABLE quota_override_audit ENABLE ROW LEVEL SECURITY';
  END IF;
END $$;

DROP POLICY IF EXISTS "Service role full access to quota_override_audit" ON quota_override_audit;
CREATE POLICY "Service role full access to quota_override_audit"
  ON quota_override_audit FOR ALL TO service_role
  USING (true) WITH CHECK (true);
