-- Server configuration table
CREATE TABLE server_config
(
    guild_id TEXT PRIMARY KEY,
    default_provider TEXT,
    auto_thread BOOLEAN DEFAULT false,
    memory_retention_days INTEGER DEFAULT 30,
    rate_limit_multiplier DECIMAL DEFAULT 1.0,
    features_enabled JSONB DEFAULT '{}',
    channel_configs JSONB DEFAULT '{}',
    created_at TIMESTAMP
    WITH TIME ZONE DEFAULT NOW
    (),
  updated_at TIMESTAMP
    WITH TIME ZONE DEFAULT NOW
    ()
);

    -- Audit logs table
    CREATE TABLE audit_logs
    (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        action TEXT NOT NULL,
        target_id TEXT,
        details JSONB,
        created_at TIMESTAMP
        WITH TIME ZONE DEFAULT NOW
        ()
);

        CREATE INDEX idx_audit_logs_guild ON audit_logs(guild_id);
        CREATE INDEX idx_audit_logs_user ON audit_logs(user_id);
        CREATE INDEX idx_audit_logs_created ON audit_logs(created_at DESC);

        -- Moderation actions table
        CREATE TABLE mod_actions
        (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            guild_id TEXT NOT NULL,
            moderator_id TEXT NOT NULL,
            target_user_id TEXT NOT NULL,
            action_type TEXT NOT NULL CHECK (action_type IN ('warn', 'timeout', 'kick', 'ban', 'purge')),
            reason TEXT,
            duration INTEGER,
            message_count INTEGER,
            created_at TIMESTAMP
            WITH TIME ZONE DEFAULT NOW
            ()
);

            CREATE INDEX idx_mod_actions_guild ON mod_actions(guild_id);
            CREATE INDEX idx_mod_actions_target ON mod_actions(target_user_id);
            CREATE INDEX idx_mod_actions_created ON mod_actions(created_at DESC);

            -- Analytics events table
            CREATE TABLE analytics_events
            (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                guild_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                command TEXT,
                provider TEXT,
                tokens_used INTEGER,
                response_time_ms INTEGER,
                success BOOLEAN,
                metadata JSONB DEFAULT '{}',
                created_at TIMESTAMP
                WITH TIME ZONE DEFAULT NOW
                ()
);

                CREATE INDEX idx_analytics_guild ON analytics_events(guild_id, created_at DESC);
                CREATE INDEX idx_analytics_command ON analytics_events(command);
                CREATE INDEX idx_analytics_event_type ON analytics_events(event_type);

                -- User roles/permissions table
                CREATE TABLE user_roles
                (
                    guild_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    role_tier TEXT NOT NULL CHECK (role_tier IN ('admin', 'moderator', 'trusted', 'member', 'restricted')),
                    granted_by TEXT,
                    granted_at TIMESTAMP
                    WITH TIME ZONE DEFAULT NOW
                    (),
  PRIMARY KEY
                    (guild_id, user_id)
);

                    CREATE INDEX idx_user_roles_guild ON user_roles(guild_id);
                    CREATE INDEX idx_user_roles_tier ON user_roles(role_tier);

                    -- Response feedback table (for reaction tracking)
                    CREATE TABLE response_feedback
                    (
                        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                        guild_id TEXT NOT NULL,
                        channel_id TEXT NOT NULL,
                        message_id TEXT NOT NULL,
                        user_id TEXT NOT NULL,
                        feedback_type TEXT NOT NULL CHECK (feedback_type IN ('positive', 'negative', 'regenerate', 'save', 'delete')),
                        original_provider TEXT,
                        created_at TIMESTAMP
                        WITH TIME ZONE DEFAULT NOW
                        ()
);

                        CREATE INDEX idx_response_feedback_message ON response_feedback(message_id);
                        CREATE INDEX idx_response_feedback_guild ON response_feedback(guild_id);

                        -- Trigger to update server_config updated_at
                        CREATE TRIGGER update_server_config_updated_at 
BEFORE
                        UPDATE ON server_config
FOR EACH ROW
                        EXECUTE FUNCTION update_updated_at_column
                        ();
