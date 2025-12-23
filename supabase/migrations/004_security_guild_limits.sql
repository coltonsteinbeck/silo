-- Migration 004: Security hardening, guild limits, and content moderation
-- Adds RLS to initial tables, guild registry with activity tracking,
-- FIFO waitlist, and content moderation logging with SHA256 hashes

-- ============================================
-- GUILD REGISTRY (activity tracking + hosted mode limits)
-- ============================================

CREATE TABLE guild_registry (
    guild_id TEXT PRIMARY KEY,
    guild_name TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    member_count INTEGER DEFAULT 0,
    warning_channel_id TEXT,  -- System channel or first text channel for warnings
    is_active BOOLEAN DEFAULT true,
    deployment_mode TEXT NOT NULL DEFAULT 'hosted' CHECK (deployment_mode IN ('hosted', 'self-hosted')),
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    last_activity_at TIMESTAMPTZ DEFAULT NOW(),
    last_warning_sent_at TIMESTAMPTZ,
    deactivated_at TIMESTAMPTZ,
    scheduled_deletion_at TIMESTAMPTZ,  -- 30 days after deactivation
    deactivation_reason TEXT CHECK (deactivation_reason IN ('inactivity', 'manual', 'left', 'kicked')),
    metadata JSONB DEFAULT '{}'
);

CREATE INDEX idx_guild_registry_active ON guild_registry(is_active, deployment_mode) WHERE is_active = true;
CREATE INDEX idx_guild_registry_activity ON guild_registry(last_activity_at) WHERE is_active = true;
CREATE INDEX idx_guild_registry_deletion ON guild_registry(scheduled_deletion_at) WHERE scheduled_deletion_at IS NOT NULL;

-- ============================================
-- FIFO WAITLIST
-- ============================================

CREATE TABLE guild_waitlist (
    guild_id TEXT PRIMARY KEY,
    guild_name TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    member_count INTEGER DEFAULT 0,
    position SERIAL,  -- Auto-incrementing for FIFO order
    requested_at TIMESTAMPTZ DEFAULT NOW(),
    notified_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,  -- 48h after notification to accept
    status TEXT DEFAULT 'waiting' CHECK (status IN ('waiting', 'notified', 'expired', 'joined'))
);

CREATE INDEX idx_waitlist_status_position ON guild_waitlist(status, position) WHERE status = 'waiting';
CREATE INDEX idx_waitlist_expires ON guild_waitlist(expires_at) WHERE status = 'notified';

-- ============================================
-- CONTENT MODERATION LOG (SHA256 hash only, never raw content)
-- ============================================

CREATE TABLE content_moderation_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    content_type TEXT NOT NULL CHECK (content_type IN ('prompt', 'memory', 'feedback', 'message')),
    content_hash CHAR(64) NOT NULL,  -- SHA256 is always 64 hex characters
    content_length INTEGER,  -- Length for analysis without storing content
    flagged_categories TEXT[] DEFAULT '{}',
    moderation_scores JSONB,  -- OpenAI moderation scores
    action_taken TEXT NOT NULL CHECK (action_taken IN ('allowed', 'blocked', 'warned')),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_moderation_hash ON content_moderation_log(content_hash);
CREATE INDEX idx_moderation_user_action ON content_moderation_log(user_id, action_taken);
CREATE INDEX idx_moderation_guild ON content_moderation_log(guild_id, created_at DESC);
CREATE INDEX idx_moderation_blocked ON content_moderation_log(action_taken, created_at DESC) WHERE action_taken = 'blocked';

-- ============================================
-- ROW LEVEL SECURITY ON INITIAL TABLES
-- ============================================

-- Enable RLS on user_memory
ALTER TABLE user_memory ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_user_memory" ON user_memory
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Enable RLS on server_memory
ALTER TABLE server_memory ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_server_memory" ON server_memory
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Enable RLS on conversation_messages
ALTER TABLE conversation_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_conversations" ON conversation_messages
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Enable RLS on user_preferences
ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_preferences" ON user_preferences
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Enable RLS on guild_registry
ALTER TABLE guild_registry ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_guild_registry" ON guild_registry
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Enable RLS on guild_waitlist
ALTER TABLE guild_waitlist ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_guild_waitlist" ON guild_waitlist
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Enable RLS on content_moderation_log
ALTER TABLE content_moderation_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_content_moderation" ON content_moderation_log
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- ============================================
-- HELPER FUNCTIONS
-- ============================================

-- Get count of active hosted guilds
CREATE OR REPLACE FUNCTION get_active_hosted_guild_count()
RETURNS INTEGER AS $$
BEGIN
    RETURN (
        SELECT COUNT(*)::INTEGER 
        FROM guild_registry 
        WHERE is_active = true AND deployment_mode = 'hosted'
    );
END;
$$ LANGUAGE plpgsql;

-- Check if a new guild can join (respects MAX_GUILDS limit)
CREATE OR REPLACE FUNCTION can_add_hosted_guild(max_guilds INTEGER DEFAULT 5)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN get_active_hosted_guild_count() < max_guilds;
END;
$$ LANGUAGE plpgsql;

-- Get next guild from waitlist (FIFO)
CREATE OR REPLACE FUNCTION get_next_waitlist_guild()
RETURNS TABLE(guild_id TEXT, guild_name TEXT, owner_id TEXT, member_count INTEGER, queue_position INTEGER) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        w.guild_id, 
        w.guild_name, 
        w.owner_id,
        w.member_count,
        w.position as queue_position
    FROM guild_waitlist w
    WHERE w.status = 'waiting'
    ORDER BY w.position ASC
    LIMIT 1;
END;
$$ LANGUAGE plpgsql;

-- Get guilds that need inactivity warnings (25-29 days inactive)
CREATE OR REPLACE FUNCTION get_guilds_needing_warning()
RETURNS TABLE(
    guild_id TEXT, 
    guild_name TEXT,
    warning_channel_id TEXT, 
    days_inactive INTEGER,
    owner_id TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        g.guild_id, 
        g.guild_name,
        g.warning_channel_id,
        EXTRACT(DAY FROM NOW() - g.last_activity_at)::INTEGER as days_inactive,
        g.owner_id
    FROM guild_registry g
    WHERE g.is_active = true
      AND g.deployment_mode = 'hosted'
      AND g.last_activity_at < NOW() - INTERVAL '25 days'
      AND g.last_activity_at >= NOW() - INTERVAL '30 days'
      AND (g.last_warning_sent_at IS NULL OR g.last_warning_sent_at::DATE < CURRENT_DATE);
END;
$$ LANGUAGE plpgsql;

-- Get guilds to evict (30+ days inactive)
CREATE OR REPLACE FUNCTION get_guilds_to_evict()
RETURNS TABLE(
    guild_id TEXT, 
    guild_name TEXT,
    warning_channel_id TEXT,
    owner_id TEXT,
    days_inactive INTEGER
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        g.guild_id, 
        g.guild_name,
        g.warning_channel_id,
        g.owner_id,
        EXTRACT(DAY FROM NOW() - g.last_activity_at)::INTEGER as days_inactive
    FROM guild_registry g
    WHERE g.is_active = true
      AND g.deployment_mode = 'hosted'
      AND g.last_activity_at < NOW() - INTERVAL '30 days';
END;
$$ LANGUAGE plpgsql;

-- Get guilds with data ready for permanent deletion (30 days after deactivation)
CREATE OR REPLACE FUNCTION get_guilds_for_data_deletion()
RETURNS TABLE(guild_id TEXT, guild_name TEXT, deactivated_at TIMESTAMPTZ) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        g.guild_id, 
        g.guild_name,
        g.deactivated_at
    FROM guild_registry g
    WHERE g.is_active = false
      AND g.scheduled_deletion_at IS NOT NULL
      AND g.scheduled_deletion_at <= NOW();
END;
$$ LANGUAGE plpgsql;

-- Update guild activity timestamp
CREATE OR REPLACE FUNCTION update_guild_activity(p_guild_id TEXT)
RETURNS VOID AS $$
BEGIN
    UPDATE guild_registry 
    SET last_activity_at = NOW() 
    WHERE guild_id = p_guild_id AND is_active = true;
END;
$$ LANGUAGE plpgsql;

-- Mark warning as sent for today
CREATE OR REPLACE FUNCTION mark_warning_sent(p_guild_id TEXT)
RETURNS VOID AS $$
BEGIN
    UPDATE guild_registry 
    SET last_warning_sent_at = NOW() 
    WHERE guild_id = p_guild_id;
END;
$$ LANGUAGE plpgsql;

-- Deactivate a guild (schedule for deletion in 30 days)
CREATE OR REPLACE FUNCTION deactivate_guild(p_guild_id TEXT, p_reason TEXT)
RETURNS VOID AS $$
BEGIN
    UPDATE guild_registry SET
        is_active = false,
        deactivated_at = NOW(),
        scheduled_deletion_at = NOW() + INTERVAL '30 days',
        deactivation_reason = p_reason
    WHERE guild_id = p_guild_id;
END;
$$ LANGUAGE plpgsql;

-- Promote next guild from waitlist
CREATE OR REPLACE FUNCTION promote_from_waitlist()
RETURNS TABLE(guild_id TEXT, owner_id TEXT, guild_name TEXT) AS $$
DECLARE
    v_next RECORD;
BEGIN
    SELECT * INTO v_next FROM get_next_waitlist_guild();
    
    IF v_next IS NULL THEN
        RETURN;
    END IF;
    
    UPDATE guild_waitlist SET
        status = 'notified',
        notified_at = NOW(),
        expires_at = NOW() + INTERVAL '48 hours'
    WHERE guild_waitlist.guild_id = v_next.guild_id;
    
    RETURN QUERY SELECT v_next.guild_id, v_next.owner_id, v_next.guild_name;
END;
$$ LANGUAGE plpgsql;

-- Expire old waitlist notifications (48h passed without joining)
CREATE OR REPLACE FUNCTION expire_old_waitlist_notifications()
RETURNS INTEGER AS $$
DECLARE
    v_count INTEGER;
BEGIN
    UPDATE guild_waitlist SET status = 'expired'
    WHERE status = 'notified' AND expires_at < NOW();
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$ LANGUAGE plpgsql;

-- Delete all data for a guild (called 30 days after deactivation)
CREATE OR REPLACE FUNCTION delete_guild_data(p_guild_id TEXT)
RETURNS VOID AS $$
BEGIN
    -- Delete server memories
    DELETE FROM server_memory WHERE server_id = p_guild_id;
    
    -- Delete moderation log
    DELETE FROM content_moderation_log WHERE guild_id = p_guild_id;
    
    -- Delete from other tables with guild_id
    DELETE FROM audit_logs WHERE guild_id = p_guild_id;
    DELETE FROM mod_actions WHERE guild_id = p_guild_id;
    DELETE FROM analytics_events WHERE guild_id = p_guild_id;
    DELETE FROM server_config WHERE guild_id = p_guild_id;
    DELETE FROM user_roles WHERE guild_id = p_guild_id;
    DELETE FROM response_feedback WHERE guild_id = p_guild_id;
    DELETE FROM guild_quotas WHERE guild_id = p_guild_id;
    DELETE FROM guild_daily_usage WHERE guild_id = p_guild_id;
    DELETE FROM user_feedback WHERE guild_id = p_guild_id;
    
    -- Finally remove from registry
    DELETE FROM guild_registry WHERE guild_id = p_guild_id;
    
    -- Remove from waitlist if present
    DELETE FROM guild_waitlist WHERE guild_id = p_guild_id;
END;
$$ LANGUAGE plpgsql;

-- Get waitlist position for a guild
CREATE OR REPLACE FUNCTION get_waitlist_position(p_guild_id TEXT)
RETURNS INTEGER AS $$
DECLARE
    v_target_position INTEGER;
    v_count INTEGER;
BEGIN
    -- Get the target guild's position
    SELECT position INTO v_target_position
    FROM guild_waitlist
    WHERE guild_id = p_guild_id;
    
    -- Return NULL if guild not found
    IF v_target_position IS NULL THEN
        RETURN NULL;
    END IF;
    
    -- Count guilds ahead of or at the same position
    SELECT COUNT(*)::INTEGER INTO v_count
    FROM guild_waitlist
    WHERE status = 'waiting'
      AND position <= v_target_position;
    
    RETURN v_count;
END;
$$ LANGUAGE plpgsql;
