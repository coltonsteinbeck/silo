-- Only the schema is distributed. Policy rows are administrator-owned data migrations.
CREATE SCHEMA IF NOT EXISTS app_private;
REVOKE ALL ON SCHEMA app_private FROM PUBLIC;
CREATE TABLE app_private.guild_persona_policies (
  guild_id TEXT PRIMARY KEY CHECK (guild_id ~ '^[0-9]{15,22}$'),
  policy JSONB NOT NULL CHECK (jsonb_typeof(policy) = 'object'),
  revision TEXT NOT NULL CHECK (length(revision) BETWEEN 1 AND 100),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE app_private.guild_persona_policies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.guild_persona_policies FROM PUBLIC;
-- Remove direct/default API grants too; ordinary backend roles require explicit grants and RLS policies.
DO $permissions$
DECLARE api_role TEXT;
BEGIN
  FOR api_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role', 'authenticator') LOOP
    EXECUTE format('REVOKE ALL ON SCHEMA app_private FROM %I', api_role);
    EXECUTE format('REVOKE ALL ON app_private.guild_persona_policies FROM %I', api_role);
  END LOOP;
END $permissions$;
