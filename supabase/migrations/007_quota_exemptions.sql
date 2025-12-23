-- Quota and rate limit exemptions per guild
-- Safe to re-run; uses IF NOT EXISTS guards

ALTER TABLE guild_quotas
    ADD COLUMN IF NOT EXISTS quota_exempt BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS rate_limit_exempt BOOLEAN DEFAULT FALSE;

-- Partial index for faster exemption lookups
CREATE INDEX IF NOT EXISTS idx_guild_quotas_exempt
    ON guild_quotas (guild_id)
    WHERE quota_exempt OR rate_limit_exempt;

COMMENT ON COLUMN guild_quotas.quota_exempt IS 'When true, the guild bypasses quota limits';
COMMENT ON COLUMN guild_quotas.rate_limit_exempt IS 'When true, the guild bypasses rate limiting';
