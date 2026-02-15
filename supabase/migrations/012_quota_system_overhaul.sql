-- Migration 012: Quota System Overhaul
-- Migrates hardcoded quotas to database, adds atomic increment, accuracy logging,
-- and reset notifications for per-user-per-guild quota tracking.
-- All quotas are now stored in the database with proper defaults.

-- ============================================================================
-- ROLE TIER QUOTAS TABLE (replaces hardcoded DEFAULT_QUOTAS)
-- ============================================================================

-- Global defaults (guild_id IS NULL) and guild-specific overrides
CREATE TABLE IF NOT EXISTS role_tier_quotas (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  guild_id TEXT,  -- NULL = global default
  role_tier TEXT NOT NULL CHECK (role_tier IN ('admin', 'moderator', 'trusted', 'member', 'restricted')),
  text_tokens INTEGER NOT NULL CHECK (text_tokens >= 0),
  images INTEGER NOT NULL CHECK (images >= 0),
  voice_minutes INTEGER NOT NULL CHECK (voice_minutes >= 0),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(guild_id, role_tier)
);

CREATE INDEX IF NOT EXISTS idx_role_tier_quotas_guild ON role_tier_quotas(guild_id);
CREATE INDEX IF NOT EXISTS idx_role_tier_quotas_tier ON role_tier_quotas(role_tier);

-- Pre-populate global defaults (immutable by admins, managed by system only)
INSERT INTO role_tier_quotas (guild_id, role_tier, text_tokens, images, voice_minutes) VALUES
  (NULL, 'admin', 50000, 5, 15),
  (NULL, 'moderator', 20000, 3, 10),
  (NULL, 'trusted', 10000, 2, 5),
  (NULL, 'member', 5000, 1, 0),
  (NULL, 'restricted', 0, 0, 0)
ON CONFLICT (guild_id, role_tier) DO NOTHING;

-- ============================================================================
-- QUOTA ACCURACY LOG (for 7-day rolling estimate tuning)
-- ============================================================================

CREATE TABLE IF NOT EXISTS quota_accuracy_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  input_length INTEGER NOT NULL,
  estimated_tokens INTEGER NOT NULL,
  actual_tokens INTEGER NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_accuracy_log_created ON quota_accuracy_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_accuracy_log_guild ON quota_accuracy_log(guild_id);
-- Standard index on created_at for efficient 7-day rolling queries
-- (partial indexes with NOW() are not allowed as NOW() is not immutable)

-- ============================================================================
-- QUOTA RESET NOTIFICATIONS (track users needing reset notification)
-- ============================================================================

CREATE TABLE IF NOT EXISTS quota_reset_notifications (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  exhausted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  PRIMARY KEY (guild_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_reset_notifications_exhausted ON quota_reset_notifications(exhausted_at);

-- ============================================================================
-- TRIGGERS FOR UPDATED_AT
-- ============================================================================

DROP TRIGGER IF EXISTS update_role_tier_quotas_updated_at ON role_tier_quotas;
CREATE TRIGGER update_role_tier_quotas_updated_at 
BEFORE UPDATE ON role_tier_quotas
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- FUNCTION: Get role tier quota (guild-specific or global fallback)
-- ============================================================================

CREATE OR REPLACE FUNCTION get_role_tier_quota(
  p_guild_id TEXT,
  p_role_tier TEXT
) RETURNS TABLE(text_tokens INTEGER, images INTEGER, voice_minutes INTEGER) AS $fn_get_role_tier_quota$
BEGIN
  -- Try guild-specific first
  RETURN QUERY
  SELECT rtq.text_tokens, rtq.images, rtq.voice_minutes
  FROM role_tier_quotas rtq
  WHERE rtq.guild_id = p_guild_id AND rtq.role_tier = p_role_tier;
  
  IF FOUND THEN
    RETURN;
  END IF;
  
  -- Fall back to global defaults
  RETURN QUERY
  SELECT rtq.text_tokens, rtq.images, rtq.voice_minutes
  FROM role_tier_quotas rtq
  WHERE rtq.guild_id IS NULL AND rtq.role_tier = p_role_tier;
END;
$fn_get_role_tier_quota$ LANGUAGE plpgsql STABLE;

-- ============================================================================
-- FUNCTION: Atomic increment usage (race-condition safe)
-- ============================================================================

CREATE OR REPLACE FUNCTION increment_usage_atomic(
  p_guild_id TEXT,
  p_user_id TEXT,
  p_resource TEXT,
  p_amount INTEGER,
  p_user_limit INTEGER
) RETURNS TABLE(success BOOLEAN, new_total INTEGER, remaining INTEGER) AS $fn_increment_usage_atomic$
WITH ensured AS (
  INSERT INTO usage_tracking (guild_id, user_id, usage_date)
  VALUES (p_guild_id, p_user_id, CURRENT_DATE)
  ON CONFLICT (guild_id, user_id, usage_date) DO NOTHING
  RETURNING 1
), updated AS (
  UPDATE usage_tracking
  SET text_tokens_used = text_tokens_used + CASE WHEN p_resource = 'text_tokens' THEN p_amount ELSE 0 END,
      images_used = images_used + CASE WHEN p_resource = 'images' THEN p_amount ELSE 0 END,
      voice_minutes_used = voice_minutes_used + CASE WHEN p_resource = 'voice_minutes' THEN p_amount ELSE 0 END,
      text_requests = text_requests + CASE WHEN p_resource = 'text_tokens' THEN 1 ELSE 0 END,
      image_requests = image_requests + CASE WHEN p_resource = 'images' THEN 1 ELSE 0 END,
      voice_requests = voice_requests + CASE WHEN p_resource = 'voice_minutes' THEN 1 ELSE 0 END,
      updated_at = NOW()
  WHERE guild_id = p_guild_id
    AND user_id = p_user_id
    AND usage_date = CURRENT_DATE
    AND CASE
      WHEN p_resource = 'text_tokens' THEN text_tokens_used + p_amount <= p_user_limit
      WHEN p_resource = 'images' THEN images_used + p_amount <= p_user_limit
      WHEN p_resource = 'voice_minutes' THEN voice_minutes_used + p_amount <= p_user_limit
      ELSE FALSE
    END
  RETURNING CASE
    WHEN p_resource = 'text_tokens' THEN text_tokens_used
    WHEN p_resource = 'images' THEN images_used
    WHEN p_resource = 'voice_minutes' THEN voice_minutes_used
    ELSE 0
  END AS new_total
), aggregate_update AS (
  INSERT INTO guild_daily_usage (guild_id, usage_date, total_text_tokens, total_images, total_voice_minutes)
  SELECT
    p_guild_id,
    CURRENT_DATE,
    CASE WHEN p_resource = 'text_tokens' THEN p_amount ELSE 0 END,
    CASE WHEN p_resource = 'images' THEN p_amount ELSE 0 END,
    CASE WHEN p_resource = 'voice_minutes' THEN p_amount ELSE 0 END
  FROM updated
  ON CONFLICT (guild_id, usage_date) DO UPDATE SET
    total_text_tokens = guild_daily_usage.total_text_tokens + CASE WHEN p_resource = 'text_tokens' THEN p_amount ELSE 0 END,
    total_images = guild_daily_usage.total_images + CASE WHEN p_resource = 'images' THEN p_amount ELSE 0 END,
    total_voice_minutes = guild_daily_usage.total_voice_minutes + CASE WHEN p_resource = 'voice_minutes' THEN p_amount ELSE 0 END,
    updated_at = NOW()
  RETURNING 1
), current_values AS (
  SELECT COALESCE(CASE
    WHEN p_resource = 'text_tokens' THEN text_tokens_used
    WHEN p_resource = 'images' THEN images_used
    WHEN p_resource = 'voice_minutes' THEN voice_minutes_used
    ELSE 0
  END, 0) AS current_total
  FROM usage_tracking
  WHERE guild_id = p_guild_id
    AND user_id = p_user_id
    AND usage_date = CURRENT_DATE
)
SELECT TRUE, u.new_total, GREATEST(0, p_user_limit - u.new_total)
FROM updated u
UNION ALL
SELECT FALSE, COALESCE(cv.current_total, 0), GREATEST(0, p_user_limit - COALESCE(cv.current_total, 0))
FROM current_values cv
WHERE NOT EXISTS (SELECT 1 FROM updated)
LIMIT 1;
$fn_increment_usage_atomic$ LANGUAGE sql;

-- ============================================================================
-- FUNCTION: Get 7-day accuracy stats for estimate tuning
-- ============================================================================

CREATE OR REPLACE FUNCTION get_accuracy_stats(p_days INTEGER DEFAULT 7)
RETURNS TABLE(avg_ratio NUMERIC, sample_count BIGINT, std_dev NUMERIC) AS $fn_get_accuracy_stats$
  SELECT 
    AVG(actual_tokens::NUMERIC / NULLIF(input_length, 0)) as avg_ratio,
    COUNT(*) as sample_count,
    STDDEV(actual_tokens::NUMERIC / NULLIF(input_length, 0)) as std_dev
  FROM quota_accuracy_log
  WHERE created_at > NOW() - (p_days || ' days')::INTERVAL
    AND input_length > 0
    AND actual_tokens > 0;
$fn_get_accuracy_stats$ LANGUAGE sql STABLE;

-- ============================================================================
-- FUNCTION: Cleanup old accuracy logs (>30 days)
-- ============================================================================

CREATE OR REPLACE FUNCTION cleanup_old_accuracy_logs(p_days INTEGER DEFAULT 30)
RETURNS INTEGER AS $fn_cleanup_old_accuracy_logs$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM quota_accuracy_log WHERE created_at < NOW() - (p_days || ' days')::INTERVAL;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$fn_cleanup_old_accuracy_logs$ LANGUAGE plpgsql;

-- ============================================================================
-- FUNCTION: Cleanup old usage data (>90 days)
-- ============================================================================

CREATE OR REPLACE FUNCTION cleanup_old_usage(p_days INTEGER DEFAULT 90)
RETURNS TABLE(usage_deleted INTEGER, guild_usage_deleted INTEGER) AS $fn_cleanup_old_usage$
DECLARE
  v_usage_deleted INTEGER;
  v_guild_deleted INTEGER;
BEGIN
  DELETE FROM usage_tracking WHERE usage_date < CURRENT_DATE - p_days;
  GET DIAGNOSTICS v_usage_deleted = ROW_COUNT;
  
  DELETE FROM guild_daily_usage WHERE usage_date < CURRENT_DATE - p_days;
  GET DIAGNOSTICS v_guild_deleted = ROW_COUNT;
  
  RETURN QUERY SELECT v_usage_deleted, v_guild_deleted;
END;
$fn_cleanup_old_usage$ LANGUAGE plpgsql;

-- ============================================================================
-- FUNCTION: Get users needing reset notification
-- ============================================================================

CREATE OR REPLACE FUNCTION get_users_needing_reset_notification()
RETURNS TABLE(
  guild_id TEXT,
  user_id TEXT,
  channel_id TEXT,
  exhausted_at TIMESTAMP WITH TIME ZONE
) AS $fn_get_users_needing_reset_notification$
  SELECT qrn.guild_id, qrn.user_id, qrn.channel_id, qrn.exhausted_at
  FROM quota_reset_notifications qrn
  -- Only return if it is a new day (quota has reset)
  WHERE DATE(qrn.exhausted_at) < CURRENT_DATE;
$fn_get_users_needing_reset_notification$ LANGUAGE sql STABLE;

-- ============================================================================
-- FUNCTION: Get guild quota stats for admin view
-- ============================================================================

CREATE OR REPLACE FUNCTION get_guild_quota_stats(p_guild_id TEXT)
RETURNS TABLE(
  text_tokens_used BIGINT,
  images_used BIGINT,
  voice_minutes_used BIGINT,
  unique_users BIGINT,
  pending_reset_notifications BIGINT
) AS $fn_get_guild_quota_stats$
  SELECT 
    COALESCE(SUM(ut.text_tokens_used), 0) as text_tokens_used,
    COALESCE(SUM(ut.images_used), 0) as images_used,
    COALESCE(SUM(ut.voice_minutes_used), 0) as voice_minutes_used,
    COUNT(DISTINCT ut.user_id) as unique_users,
    (SELECT COUNT(*) FROM quota_reset_notifications WHERE guild_id = p_guild_id) as pending_reset_notifications
  FROM usage_tracking ut
  WHERE ut.guild_id = p_guild_id AND ut.usage_date = CURRENT_DATE;
$fn_get_guild_quota_stats$ LANGUAGE sql STABLE;

-- ============================================================================
-- RLS POLICIES
-- ============================================================================

DO $do_enable_rls_role_tier_quotas$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'role_tier_quotas' AND schemaname = 'public') THEN
    EXECUTE 'ALTER TABLE role_tier_quotas ENABLE ROW LEVEL SECURITY';
  END IF;
END $do_enable_rls_role_tier_quotas$;

DO $do_enable_rls_quota_accuracy_log$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'quota_accuracy_log' AND schemaname = 'public') THEN
    EXECUTE 'ALTER TABLE quota_accuracy_log ENABLE ROW LEVEL SECURITY';
  END IF;
END $do_enable_rls_quota_accuracy_log$;

DO $do_enable_rls_quota_reset_notifications$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'quota_reset_notifications' AND schemaname = 'public') THEN
    EXECUTE 'ALTER TABLE quota_reset_notifications ENABLE ROW LEVEL SECURITY';
  END IF;
END $do_enable_rls_quota_reset_notifications$;

-- Service role full access policies
DROP POLICY IF EXISTS "Service role full access to role_tier_quotas" ON role_tier_quotas;
CREATE POLICY "Service role full access to role_tier_quotas"
    ON role_tier_quotas FOR ALL TO service_role
    USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access to quota_accuracy_log" ON quota_accuracy_log;
CREATE POLICY "Service role full access to quota_accuracy_log"
    ON quota_accuracy_log FOR ALL TO service_role
    USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access to quota_reset_notifications" ON quota_reset_notifications;
CREATE POLICY "Service role full access to quota_reset_notifications"
    ON quota_reset_notifications FOR ALL TO service_role
    USING (true) WITH CHECK (true);

-- ============================================================================
-- DOWN MIGRATION (uncomment to rollback)
-- ============================================================================

-- DROP POLICY IF EXISTS "Service role full access to quota_reset_notifications" ON quota_reset_notifications;
-- DROP POLICY IF EXISTS "Service role full access to quota_accuracy_log" ON quota_accuracy_log;
-- DROP POLICY IF EXISTS "Service role full access to role_tier_quotas" ON role_tier_quotas;
-- 
-- ALTER TABLE quota_reset_notifications DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE quota_accuracy_log DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE role_tier_quotas DISABLE ROW LEVEL SECURITY;
-- 
-- DROP FUNCTION IF EXISTS get_guild_quota_stats(TEXT);
-- DROP FUNCTION IF EXISTS get_users_needing_reset_notification();
-- DROP FUNCTION IF EXISTS cleanup_old_usage(INTEGER);
-- DROP FUNCTION IF EXISTS cleanup_old_accuracy_logs(INTEGER);
-- DROP FUNCTION IF EXISTS get_accuracy_stats(INTEGER);
-- DROP FUNCTION IF EXISTS increment_usage_atomic(TEXT, TEXT, TEXT, INTEGER, INTEGER);
-- DROP FUNCTION IF EXISTS get_role_tier_quota(TEXT, TEXT);
-- 
-- DROP TRIGGER IF EXISTS update_role_tier_quotas_updated_at ON role_tier_quotas;
-- 
-- DROP INDEX IF EXISTS idx_reset_notifications_exhausted;
-- DROP INDEX IF EXISTS idx_accuracy_log_7day;
-- DROP INDEX IF EXISTS idx_accuracy_log_guild;
-- DROP INDEX IF EXISTS idx_accuracy_log_created;
-- DROP INDEX IF EXISTS idx_role_tier_quotas_tier;
-- DROP INDEX IF EXISTS idx_role_tier_quotas_guild;
-- 
-- DROP TABLE IF EXISTS quota_reset_notifications CASCADE;
-- DROP TABLE IF EXISTS quota_accuracy_log CASCADE;
-- DROP TABLE IF EXISTS role_tier_quotas CASCADE;
