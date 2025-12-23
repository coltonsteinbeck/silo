-- Per-guild hourly metrics with daily rollup
-- Safe to re-run; uses IF NOT EXISTS guards

CREATE TABLE IF NOT EXISTS guild_metrics_hourly (
    guild_id TEXT NOT NULL,
    hour TIMESTAMPTZ NOT NULL DEFAULT date_trunc('hour', NOW()),
    commands_total INTEGER DEFAULT 0,
    commands_by_type JSONB DEFAULT '{}'::jsonb,
    ai_requests INTEGER DEFAULT 0,
    ai_requests_by_provider JSONB DEFAULT '{}'::jsonb,
    tokens_used BIGINT DEFAULT 0,
    voice_sessions INTEGER DEFAULT 0,
    voice_minutes INTEGER DEFAULT 0,
    images_generated INTEGER DEFAULT 0,
    avg_response_time_ms INTEGER,
    error_count INTEGER DEFAULT 0,
    unique_users TEXT[] DEFAULT '{}'::text[],
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (guild_id, hour)
);

CREATE INDEX IF NOT EXISTS idx_guild_metrics_hour ON guild_metrics_hourly (hour DESC);

-- Daily materialized view for quick analytics
CREATE MATERIALIZED VIEW IF NOT EXISTS guild_metrics_daily AS
SELECT
    guild_id,
    date_trunc('day', hour) AS day,
    SUM(commands_total) AS commands_total,
    SUM(ai_requests) AS ai_requests,
    SUM(tokens_used) AS tokens_used,
    SUM(voice_sessions) AS voice_sessions,
    SUM(voice_minutes) AS voice_minutes,
    SUM(images_generated) AS images_generated,
    AVG(avg_response_time_ms) AS avg_response_time_ms,
    SUM(error_count) AS error_count,
    COUNT(DISTINCT u) AS unique_users
FROM guild_metrics_hourly
LEFT JOIN LATERAL unnest(unique_users) AS u ON true
GROUP BY guild_id, date_trunc('day', hour);

-- Helpful index for view queries
CREATE INDEX IF NOT EXISTS idx_guild_metrics_daily_day
    ON guild_metrics_daily (day DESC);
