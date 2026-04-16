-- Migration 016: Enforce quota scope uniqueness and stabilize fallback lookup
--
-- Fixes duplicate global rows caused by NULL semantics in UNIQUE(guild_id, role_tier).

-- 1) Deduplicate to one row per (scope, role_tier), keeping most recently updated.
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY COALESCE(guild_id, '__global__'), role_tier
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
    ) AS rn
  FROM role_tier_quotas
)
DELETE FROM role_tier_quotas rtq
USING ranked
WHERE rtq.id = ranked.id
  AND ranked.rn > 1;

-- 2) Enforce actual uniqueness for global+guild scopes.
CREATE UNIQUE INDEX IF NOT EXISTS uq_role_tier_quotas_scope_tier
  ON role_tier_quotas (COALESCE(guild_id, '__global__'), role_tier);

-- 3) Ensure fallback function returns at most one deterministic row.
CREATE OR REPLACE FUNCTION get_role_tier_quota(
  p_guild_id TEXT,
  p_role_tier TEXT
) RETURNS TABLE(text_tokens INTEGER, images INTEGER, voice_minutes INTEGER, vision_tokens INTEGER) AS $$
BEGIN
  RETURN QUERY
  SELECT rtq.text_tokens, rtq.images, rtq.voice_minutes, rtq.vision_tokens
  FROM role_tier_quotas rtq
  WHERE rtq.guild_id = p_guild_id AND rtq.role_tier = p_role_tier
  ORDER BY rtq.updated_at DESC NULLS LAST, rtq.created_at DESC NULLS LAST
  LIMIT 1;

  IF FOUND THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT rtq.text_tokens, rtq.images, rtq.voice_minutes, rtq.vision_tokens
  FROM role_tier_quotas rtq
  WHERE rtq.guild_id IS NULL AND rtq.role_tier = p_role_tier
  ORDER BY rtq.updated_at DESC NULLS LAST, rtq.created_at DESC NULLS LAST
  LIMIT 1;
END;
$$ LANGUAGE plpgsql STABLE;
