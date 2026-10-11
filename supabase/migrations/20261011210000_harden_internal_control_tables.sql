-- Keep migration history and assistant-ingress claims on direct backend connections.
-- This follow-up also repairs databases that applied the original ingress migration.
ALTER TABLE public.schema_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assistant_message_ingress ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.schema_migrations FROM PUBLIC;
REVOKE ALL ON TABLE public.assistant_message_ingress FROM PUBLIC;

DO $$
DECLARE role_name TEXT;
BEGIN
    FOR role_name IN SELECT rolname FROM pg_roles
      WHERE rolname IN ('anon', 'authenticated', 'service_role', 'authenticator')
    LOOP
        EXECUTE format(
            'REVOKE ALL ON TABLE public.schema_migrations, public.assistant_message_ingress FROM %I',
            role_name
        );
    END LOOP;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policy
        WHERE polrelid = 'public.schema_migrations'::regclass
          AND polname = 'schema_migrations_backend_acl'
    ) THEN
        EXECUTE 'CREATE POLICY schema_migrations_backend_acl ON public.schema_migrations FOR ALL TO PUBLIC USING (true) WITH CHECK (true)';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policy
        WHERE polrelid = 'public.assistant_message_ingress'::regclass
          AND polname = 'assistant_message_ingress_backend_acl'
    ) THEN
        EXECUTE 'CREATE POLICY assistant_message_ingress_backend_acl ON public.assistant_message_ingress FOR ALL TO PUBLIC USING (true) WITH CHECK (true)';
    END IF;
END
$$;
