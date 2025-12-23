-- Migration 003: Quotas, Usage Tracking, and User Feedback
-- Strict daily reset at midnight UTC, no rollover

-- Guild quotas configuration table
CREATE TABLE guild_quotas (
    guild_id TEXT PRIMARY KEY,
    -- Daily limits (configurable per guild, up to global max)
    daily_text_tokens INTEGER DEFAULT 50000,
    daily_images INTEGER DEFAULT 5,
    daily_voice_minutes INTEGER DEFAULT 15,
    -- Global maximums (cannot exceed these)
    max_text_tokens INTEGER DEFAULT 50000,
    max_images INTEGER DEFAULT 5,
    max_voice_minutes INTEGER DEFAULT 15,
    -- Metadata
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_guild_quotas_guild ON guild_quotas(guild_id);

-- Usage tracking table (per guild, per day)
CREATE TABLE usage_tracking (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    usage_date DATE NOT NULL DEFAULT CURRENT_DATE,
    -- Usage counters
    text_tokens_used INTEGER DEFAULT 0,
    images_used INTEGER DEFAULT 0,
    voice_minutes_used INTEGER DEFAULT 0,
    -- Request counts for analytics
    text_requests INTEGER DEFAULT 0,
    image_requests INTEGER DEFAULT 0,
    voice_requests INTEGER DEFAULT 0,
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    -- Composite unique constraint for daily tracking
    UNIQUE(guild_id, user_id, usage_date)
);

CREATE INDEX idx_usage_tracking_guild_date ON usage_tracking(guild_id, usage_date);
CREATE INDEX idx_usage_tracking_user ON usage_tracking(user_id);
CREATE INDEX idx_usage_tracking_date ON usage_tracking(usage_date);

-- Guild daily aggregate view for quick quota checks
CREATE TABLE guild_daily_usage (
    guild_id TEXT NOT NULL,
    usage_date DATE NOT NULL DEFAULT CURRENT_DATE,
    -- Aggregated totals
    total_text_tokens INTEGER DEFAULT 0,
    total_images INTEGER DEFAULT 0,
    total_voice_minutes INTEGER DEFAULT 0,
    -- Timestamps
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY(guild_id, usage_date)
);

CREATE INDEX idx_guild_daily_usage_date ON guild_daily_usage(usage_date);

-- User feedback table
CREATE TABLE user_feedback (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    channel_id TEXT,
    -- Feedback content
    feedback_type TEXT NOT NULL CHECK (feedback_type IN ('bug', 'feature', 'praise', 'general')),
    message TEXT NOT NULL,
    -- Status tracking
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'resolved', 'rejected')),
    admin_response TEXT,
    reviewed_by TEXT,
    reviewed_at TIMESTAMP WITH TIME ZONE,
    -- Metadata
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_user_feedback_guild ON user_feedback(guild_id);
CREATE INDEX idx_user_feedback_user ON user_feedback(user_id);
CREATE INDEX idx_user_feedback_status ON user_feedback(status);
CREATE INDEX idx_user_feedback_type ON user_feedback(feedback_type);
CREATE INDEX idx_user_feedback_created ON user_feedback(created_at DESC);

-- Voice session tracking for quota enforcement
CREATE TABLE voice_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    started_by TEXT NOT NULL,
    -- Session state
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    ended_at TIMESTAMP WITH TIME ZONE,
    duration_seconds INTEGER,
    -- Participants
    participants JSONB DEFAULT '[]',
    -- Status
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'ended', 'timeout'))
);

CREATE INDEX idx_voice_sessions_guild ON voice_sessions(guild_id);
CREATE INDEX idx_voice_sessions_status ON voice_sessions(status) WHERE status = 'active';
CREATE INDEX idx_voice_sessions_started ON voice_sessions(started_at DESC);

-- Triggers for updated_at
CREATE TRIGGER update_guild_quotas_updated_at 
BEFORE UPDATE ON guild_quotas
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_usage_tracking_updated_at 
BEFORE UPDATE ON usage_tracking
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_user_feedback_updated_at 
BEFORE UPDATE ON user_feedback
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- Function to get or create daily usage record
CREATE OR REPLACE FUNCTION get_or_create_usage(
    p_guild_id TEXT,
    p_user_id TEXT
) RETURNS usage_tracking AS $$
DECLARE
    usage_record usage_tracking;
BEGIN
    -- Try to get existing record for today
    SELECT * INTO usage_record
    FROM usage_tracking
    WHERE guild_id = p_guild_id 
      AND user_id = p_user_id 
      AND usage_date = CURRENT_DATE;
    
    -- If not found, create new record
    IF NOT FOUND THEN
        INSERT INTO usage_tracking (guild_id, user_id, usage_date)
        VALUES (p_guild_id, p_user_id, CURRENT_DATE)
        RETURNING * INTO usage_record;
    END IF;
    
    RETURN usage_record;
END;
$$ LANGUAGE plpgsql;

-- Function to check if guild is within quota
CREATE OR REPLACE FUNCTION check_guild_quota(
    p_guild_id TEXT,
    p_resource TEXT,
    p_amount INTEGER DEFAULT 1
) RETURNS BOOLEAN AS $$
DECLARE
    quota_limit INTEGER;
    current_usage INTEGER;
BEGIN
    -- Get quota limit for this guild (or default)
    SELECT 
        CASE p_resource
            WHEN 'text_tokens' THEN COALESCE(q.daily_text_tokens, 50000)
            WHEN 'images' THEN COALESCE(q.daily_images, 5)
            WHEN 'voice_minutes' THEN COALESCE(q.daily_voice_minutes, 15)
            ELSE 0
        END INTO quota_limit
    FROM guild_quotas q
    WHERE q.guild_id = p_guild_id;
    
    -- Use defaults if no guild quota record
    IF NOT FOUND THEN
        quota_limit := CASE p_resource
            WHEN 'text_tokens' THEN 50000
            WHEN 'images' THEN 5
            WHEN 'voice_minutes' THEN 15
            ELSE 0
        END;
    END IF;
    
    -- Get current usage for today
    SELECT 
        CASE p_resource
            WHEN 'text_tokens' THEN COALESCE(SUM(text_tokens_used), 0)
            WHEN 'images' THEN COALESCE(SUM(images_used), 0)
            WHEN 'voice_minutes' THEN COALESCE(SUM(voice_minutes_used), 0)
            ELSE 0
        END INTO current_usage
    FROM usage_tracking
    WHERE guild_id = p_guild_id AND usage_date = CURRENT_DATE;
    
    RETURN (current_usage + p_amount) <= quota_limit;
END;
$$ LANGUAGE plpgsql;

-- Function to increment usage
CREATE OR REPLACE FUNCTION increment_usage(
    p_guild_id TEXT,
    p_user_id TEXT,
    p_resource TEXT,
    p_amount INTEGER DEFAULT 1
) RETURNS BOOLEAN AS $$
DECLARE
    within_quota BOOLEAN;
BEGIN
    -- Check quota first
    within_quota := check_guild_quota(p_guild_id, p_resource, p_amount);
    
    IF NOT within_quota THEN
        RETURN FALSE;
    END IF;
    
    -- Ensure usage record exists
    PERFORM get_or_create_usage(p_guild_id, p_user_id);
    
    -- Increment the appropriate counter
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
      AND usage_date = CURRENT_DATE;
    
    -- Update guild daily aggregate
    INSERT INTO guild_daily_usage (guild_id, usage_date, total_text_tokens, total_images, total_voice_minutes)
    VALUES (
        p_guild_id, 
        CURRENT_DATE,
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

-- Enable RLS on new tables
ALTER TABLE guild_quotas ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_tracking ENABLE ROW LEVEL SECURITY;
ALTER TABLE guild_daily_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_sessions ENABLE ROW LEVEL SECURITY;

-- Service role full access policies
CREATE POLICY "Service role full access to guild_quotas"
    ON guild_quotas FOR ALL TO service_role
    USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access to usage_tracking"
    ON usage_tracking FOR ALL TO service_role
    USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access to guild_daily_usage"
    ON guild_daily_usage FOR ALL TO service_role
    USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access to user_feedback"
    ON user_feedback FOR ALL TO service_role
    USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access to voice_sessions"
    ON voice_sessions FOR ALL TO service_role
    USING (true) WITH CHECK (true);
