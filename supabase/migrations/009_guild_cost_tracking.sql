-- Cost tracking for per-guild 30-day windows
-- Adds provider pricing, cost fields on events, and guild cost summary

-- Provider pricing table (simple, minimal dependencies)
CREATE TABLE IF NOT EXISTS provider_pricing (
    id BIGSERIAL PRIMARY KEY,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    input_cost_per_1k DECIMAL(10,6),
    output_cost_per_1k DECIMAL(10,6),
    image_cost DECIMAL(10,4),
    voice_cost_per_minute DECIMAL(10,4),
    effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
    effective_to DATE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (provider, model, effective_from)
);

CREATE INDEX IF NOT EXISTS idx_provider_pricing_lookup
    ON provider_pricing (provider, model, effective_from DESC);

-- Add cost-related fields to analytics_events
ALTER TABLE analytics_events
    ADD COLUMN IF NOT EXISTS input_tokens INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS output_tokens INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS model TEXT,
    ADD COLUMN IF NOT EXISTS estimated_cost_usd DECIMAL(10,6);

-- Guild cost summary (rolling or periodically refreshed)
CREATE TABLE IF NOT EXISTS guild_cost_summary (
    guild_id TEXT PRIMARY KEY,
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    total_input_tokens BIGINT DEFAULT 0,
    total_output_tokens BIGINT DEFAULT 0,
    total_images INTEGER DEFAULT 0,
    total_voice_minutes INTEGER DEFAULT 0,
    text_cost_usd DECIMAL(12,4) DEFAULT 0,
    image_cost_usd DECIMAL(12,4) DEFAULT 0,
    voice_cost_usd DECIMAL(12,4) DEFAULT 0,
    provider_breakdown JSONB DEFAULT '{}'::jsonb,
    total_cost_usd DECIMAL(12,4) GENERATED ALWAYS AS
        (text_cost_usd + image_cost_usd + voice_cost_usd) STORED,
    last_updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_guild_cost_summary_period
    ON guild_cost_summary (period_start, period_end);

-- Seed starter pricing (can be updated by admins later)
INSERT INTO provider_pricing (provider, model, input_cost_per_1k, output_cost_per_1k, image_cost, voice_cost_per_minute)
VALUES
    ('openai', 'gpt-5-mini', 0.00025, 0.00200, NULL, NULL),
    ('openai', 'gpt-4o', 0.00250, 0.01000, NULL, NULL),
    ('openai', 'gpt-image-1', NULL, NULL, 0.0400, NULL),
    ('openai', 'gpt-realtime-mini', 0.00060, 0.00240, NULL, 0.0600),
    ('anthropic', 'claude-3-5-sonnet-20241022', 0.00300, 0.01500, NULL, NULL),
    ('xai', 'grok-3-mini', 0.00030, 0.00050, NULL, NULL)
ON CONFLICT DO NOTHING;
