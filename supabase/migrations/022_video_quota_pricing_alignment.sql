-- Migration 022: Align video token quotas with media pricing units.
-- Unit definition: 1 video token ~= one image-input unit ($0.002).

-- Backup current values so this migration can be reversed.
CREATE TABLE IF NOT EXISTS migration_022_guild_quota_backup (
  guild_scope TEXT PRIMARY KEY,
  guild_id TEXT,
  daily_video_tokens INTEGER,
  updated_at TIMESTAMPTZ,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS migration_022_role_tier_quota_backup (
  guild_id TEXT,
  role_tier TEXT NOT NULL,
  video_tokens INTEGER,
  updated_at TIMESTAMPTZ,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_migration_022_role_tier_quota_backup
  ON migration_022_role_tier_quota_backup (COALESCE(guild_id, '__global__'), role_tier);

INSERT INTO migration_022_guild_quota_backup (guild_scope, guild_id, daily_video_tokens, updated_at)
SELECT COALESCE(gq.guild_id, '__global__'), gq.guild_id, gq.daily_video_tokens, gq.updated_at
FROM guild_quotas gq
WHERE NOT EXISTS (
  SELECT 1
  FROM migration_022_guild_quota_backup b
  WHERE b.guild_scope = COALESCE(gq.guild_id, '__global__')
);

INSERT INTO migration_022_role_tier_quota_backup (guild_id, role_tier, video_tokens, updated_at)
SELECT rtq.guild_id, rtq.role_tier, rtq.video_tokens, rtq.updated_at
FROM role_tier_quotas rtq
WHERE NOT EXISTS (
  SELECT 1
  FROM migration_022_role_tier_quota_backup b
  WHERE b.role_tier = rtq.role_tier
    AND b.guild_id IS NOT DISTINCT FROM rtq.guild_id
);

-- Raise default guild ceiling from "count-like" units to pricing units.
ALTER TABLE guild_quotas
  ALTER COLUMN daily_video_tokens SET DEFAULT 500;

-- Normalize existing default-shaped guild quotas.
UPDATE guild_quotas
SET daily_video_tokens = 500
WHERE daily_video_tokens = 20;

-- Normalize global role-tier defaults.
UPDATE role_tier_quotas
SET video_tokens = CASE role_tier
  WHEN 'admin' THEN 500
  WHEN 'moderator' THEN 300
  WHEN 'trusted' THEN 200
  WHEN 'member' THEN 100
  WHEN 'restricted' THEN 0
  ELSE video_tokens
END
WHERE guild_id IS NULL
  AND role_tier IN ('admin', 'moderator', 'trusted', 'member', 'restricted')
  AND (
    video_tokens IS NULL
    OR video_tokens = 0
    OR video_tokens IN (4, 8, 12, 20)
  );

-- Ensure role-tier lookup has sane fallbacks for video tokens.
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
  SELECT
    rtq.text_tokens,
    rtq.images,
    rtq.voice_minutes,
    rtq.vision_tokens,
    COALESCE(
      rtq.video_tokens,
      CASE p_role_tier
        WHEN 'admin' THEN 500
        WHEN 'moderator' THEN 300
        WHEN 'trusted' THEN 200
        WHEN 'member' THEN 100
        ELSE 0
      END
    ) AS video_tokens
  FROM role_tier_quotas rtq
  WHERE rtq.guild_id = p_guild_id AND rtq.role_tier = p_role_tier
  ORDER BY rtq.updated_at DESC NULLS LAST, rtq.created_at DESC NULLS LAST
  LIMIT 1;

  IF FOUND THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    rtq.text_tokens,
    rtq.images,
    rtq.voice_minutes,
    rtq.vision_tokens,
    COALESCE(
      rtq.video_tokens,
      CASE p_role_tier
        WHEN 'admin' THEN 500
        WHEN 'moderator' THEN 300
        WHEN 'trusted' THEN 200
        WHEN 'member' THEN 100
        ELSE 0
      END
    ) AS video_tokens
  FROM role_tier_quotas rtq
  WHERE rtq.guild_id IS NULL AND rtq.role_tier = p_role_tier
  ORDER BY rtq.updated_at DESC NULLS LAST, rtq.created_at DESC NULLS LAST
  LIMIT 1;
END;
$$ LANGUAGE plpgsql STABLE;

-- Keep guild-level fallback logic aligned with new default units.
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
      WHEN 'video_tokens' THEN COALESCE(q.daily_video_tokens, 500)
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
      WHEN 'video_tokens' THEN 500
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

-- ============================================================================
-- DOWN MIGRATION (uncomment to rollback)
-- ============================================================================

-- ALTER TABLE guild_quotas
--   ALTER COLUMN daily_video_tokens SET DEFAULT 20;
--
-- UPDATE guild_quotas gq
-- SET daily_video_tokens = b.daily_video_tokens,
--     updated_at = COALESCE(b.updated_at, gq.updated_at)
-- FROM migration_022_guild_quota_backup b
-- WHERE gq.guild_id IS NOT DISTINCT FROM b.guild_id;
--
-- UPDATE role_tier_quotas rtq
-- SET video_tokens = b.video_tokens,
--     updated_at = COALESCE(b.updated_at, rtq.updated_at)
-- FROM migration_022_role_tier_quota_backup b
-- WHERE rtq.role_tier = b.role_tier
--   AND rtq.guild_id IS NOT DISTINCT FROM b.guild_id;
