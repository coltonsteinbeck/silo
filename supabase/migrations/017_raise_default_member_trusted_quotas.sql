-- Migration 017: Raise global default quotas for high-usage tiers
--
-- New defaults:
-- member: text 7000 (from 5000), vision 1500 (from 1000)
-- trusted: text 13000 (from 10000), vision 4000 (from 3000)

UPDATE role_tier_quotas
SET
  text_tokens = CASE role_tier
    WHEN 'member' THEN 7000
    WHEN 'trusted' THEN 13000
    ELSE text_tokens
  END,
  vision_tokens = CASE role_tier
    WHEN 'member' THEN 1500
    WHEN 'trusted' THEN 4000
    ELSE vision_tokens
  END,
  updated_at = NOW()
WHERE guild_id IS NULL
    AND role_tier IN ('member', 'trusted');
