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

            -- ============================================================================
            -- ROW LEVEL SECURITY (RLS) POLICIES
            -- ============================================================================

            -- Enable RLS on all tables
            ALTER TABLE server_config ENABLE ROW LEVEL SECURITY;
            ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
            ALTER TABLE mod_actions ENABLE ROW LEVEL SECURITY;
            ALTER TABLE analytics_events ENABLE ROW LEVEL SECURITY;
            ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
            ALTER TABLE response_feedback ENABLE ROW LEVEL SECURITY;

            -- ============================================================================
            -- SERVER_CONFIG POLICIES
            -- ============================================================================

            -- Allow service role full access (for bot backend)
            CREATE POLICY "Service role has full access to server_config"
  ON server_config
  FOR ALL
  TO service_role
  USING
            (true)
  WITH CHECK
            (true);

            -- Allow authenticated users to read their guild's config
            CREATE POLICY "Users can read their guild config"
  ON server_config
  FOR
            SELECT
              TO authenticated
            USING
            (
    guild_id IN
            (
      SELECT guild_id
            FROM user_roles
            WHERE user_id = auth.uid()
            ::text
    )
  );

            -- Only admins can modify server config
            CREATE POLICY "Admins can modify server config"
  ON server_config
  FOR ALL
  TO authenticated
  USING
            (
    EXISTS
            (
      SELECT 1
            FROM user_roles
            WHERE guild_id = server_config.guild_id
              AND user_id = auth.uid()
            ::text
        AND role_tier = 'admin'
    )
  )
  WITH CHECK
            (
    EXISTS
            (
      SELECT 1
            FROM user_roles
            WHERE guild_id = server_config.guild_id
              AND user_id = auth.uid()
            ::text
        AND role_tier = 'admin'
    )
  );

            -- ============================================================================
            -- AUDIT_LOGS POLICIES
            -- ============================================================================

            -- Service role full access
            CREATE POLICY "Service role has full access to audit_logs"
  ON audit_logs
  FOR ALL
  TO service_role
  USING
            (true)
  WITH CHECK
            (true);

            -- Admins and moderators can read audit logs for their guild
            CREATE POLICY "Admins and moderators can read audit logs"
  ON audit_logs
  FOR
            SELECT
              TO authenticated
            USING
            (
    guild_id IN
            (
      SELECT guild_id
            FROM user_roles
            WHERE user_id = auth.uid()
            ::text
        AND role_tier IN
            ('admin', 'moderator')
    )
  );

            -- Only service role can insert audit logs (prevents tampering)
            CREATE POLICY "Only service role can insert audit logs"
  ON audit_logs
  FOR
            INSERT
  TO service_role
  WITH CHECK (
            true);

            -- ============================================================================
            -- MOD_ACTIONS POLICIES
            -- ============================================================================

            -- Service role full access
            CREATE POLICY "Service role has full access to mod_actions"
  ON mod_actions
  FOR ALL
  TO service_role
  USING
            (true)
  WITH CHECK
            (true);

            -- Admins and moderators can read mod actions for their guild
            CREATE POLICY "Admins and moderators can read mod actions"
  ON mod_actions
  FOR
            SELECT
              TO authenticated
            USING
            (
    guild_id IN
            (
      SELECT guild_id
            FROM user_roles
            WHERE user_id = auth.uid()
            ::text
        AND role_tier IN
            ('admin', 'moderator')
    )
  );

            -- Users can read mod actions where they are the target
            CREATE POLICY "Users can read their own mod history"
  ON mod_actions
  FOR
            SELECT
              TO authenticated
            USING
            (target_user_id = auth.uid
            ()::text);

            -- ============================================================================
            -- ANALYTICS_EVENTS POLICIES
            -- ============================================================================

            -- Service role full access
            CREATE POLICY "Service role has full access to analytics_events"
  ON analytics_events
  FOR ALL
  TO service_role
  USING
            (true)
  WITH CHECK
            (true);

            -- Admins and moderators can read analytics for their guild
            CREATE POLICY "Admins and moderators can read analytics"
  ON analytics_events
  FOR
            SELECT
              TO authenticated
            USING
            (
    guild_id IN
            (
      SELECT guild_id
            FROM user_roles
            WHERE user_id = auth.uid()
            ::text
        AND role_tier IN
            ('admin', 'moderator')
    )
  );

            -- Users can read their own analytics events
            CREATE POLICY "Users can read their own analytics"
  ON analytics_events
  FOR
            SELECT
              TO authenticated
            USING
            (user_id = auth.uid
            ()::text);

            -- ============================================================================
            -- USER_ROLES POLICIES
            -- ============================================================================

            -- Service role full access
            CREATE POLICY "Service role has full access to user_roles"
  ON user_roles
  FOR ALL
  TO service_role
  USING
            (true)
  WITH CHECK
            (true);

            -- Users can read roles in their guilds
            CREATE POLICY "Users can read roles in their guilds"
  ON user_roles
  FOR
            SELECT
              TO authenticated
            USING
            (
    guild_id IN
            (
      SELECT guild_id
            FROM user_roles
            WHERE user_id = auth.uid()
            ::text
    )
  );

            -- Only admins can modify user roles
            CREATE POLICY "Admins can modify user roles"
  ON user_roles
  FOR ALL
  TO authenticated
  USING
            (
    EXISTS
            (
      SELECT 1
            FROM user_roles ur
            WHERE ur.guild_id = user_roles.guild_id
              AND ur.user_id = auth.uid()
            ::text
        AND ur.role_tier = 'admin'
    )
  )
  WITH CHECK
            (
    EXISTS
            (
      SELECT 1
            FROM user_roles ur
            WHERE ur.guild_id = user_roles.guild_id
              AND ur.user_id = auth.uid()
            ::text
        AND ur.role_tier = 'admin'
    )
  );

            -- ============================================================================
            -- RESPONSE_FEEDBACK POLICIES
            -- ============================================================================

            -- Service role full access
            CREATE POLICY "Service role has full access to response_feedback"
  ON response_feedback
  FOR ALL
  TO service_role
  USING
            (true)
  WITH CHECK
            (true);

            -- Users can read feedback in their guilds
            CREATE POLICY "Users can read feedback in their guilds"
  ON response_feedback
  FOR
            SELECT
              TO authenticated
            USING
            (
    guild_id IN
            (
      SELECT guild_id
            FROM user_roles
            WHERE user_id = auth.uid()
            ::text
    )
  );

            -- Users can insert their own feedback
            CREATE POLICY "Users can insert their own feedback"
  ON response_feedback
  FOR
            INSERT
  TO authenticated
  WITH CHECK (
            user_id
            =
            auth
            .uid
            ()::text);

            -- Users can delete their own feedback
            CREATE POLICY "Users can delete their own feedback"
  ON response_feedback
  FOR
            DELETE
  TO authenticated
  USING (user_id = auth.uid()::text);

            -- Admins can view all feedback stats for their guild
            CREATE POLICY "Admins can read all guild feedback"
  ON response_feedback
  FOR
            SELECT
              TO authenticated
            USING
            (
    guild_id IN
            (
      SELECT guild_id
            FROM user_roles
            WHERE user_id = auth.uid()
            ::text
        AND role_tier = 'admin'
    )
  );