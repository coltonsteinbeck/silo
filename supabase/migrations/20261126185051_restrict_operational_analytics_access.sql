-- Keep operational relations on backend connections. Preserve explicit grants
-- to existing backend roles and ownership of the daily materialized view.
ALTER TABLE public.guild_metrics_hourly ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.guild_cost_summary ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_pricing ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.url_security_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.archived_migration_022_backup ENABLE ROW LEVEL SECURITY;

-- Backend access still requires an explicit relation grant. Avoid a policy
-- that silently removes access from an existing non-owner backend role.
DO $$
DECLARE
    relation regclass;
BEGIN
    FOREACH relation IN ARRAY ARRAY[
        'public.guild_metrics_hourly'::regclass,
        'public.guild_cost_summary'::regclass,
        'public.provider_pricing'::regclass,
        'public.url_security_events'::regclass,
        'public.archived_migration_022_backup'::regclass
    ]
    LOOP
        -- The migration is transactional. Replace only this policy so replay
        -- restores the intended predicate even if a prior definition drifted.
        EXECUTE format('DROP POLICY IF EXISTS operational_backend_access ON %s', relation);
        EXECUTE format($policy$
            CREATE POLICY operational_backend_access ON %s
            USING (current_user NOT IN ('anon', 'authenticated', 'authenticator'))
            WITH CHECK (current_user NOT IN ('anon', 'authenticated', 'authenticator'))
        $policy$, relation);
    END LOOP;
END
$$;

REVOKE ALL ON TABLE
    public.guild_metrics_hourly,
    public.guild_metrics_daily,
    public.guild_cost_summary,
    public.provider_pricing,
    public.url_security_events,
    public.archived_migration_022_backup
FROM PUBLIC;

DO $$
DECLARE
    api_role name;
    relation regclass;
BEGIN
    FOR api_role IN SELECT rolname FROM pg_roles
        WHERE rolname IN ('anon', 'authenticated', 'authenticator')
    LOOP
        FOREACH relation IN ARRAY ARRAY[
            'public.guild_metrics_hourly'::regclass,
            'public.guild_metrics_daily'::regclass,
            'public.guild_cost_summary'::regclass,
            'public.provider_pricing'::regclass,
            'public.url_security_events'::regclass,
            'public.archived_migration_022_backup'::regclass
        ]
        LOOP
            EXECUTE format('REVOKE ALL ON TABLE %s FROM %I', relation, api_role);
            IF has_table_privilege(api_role, relation, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
                OR has_any_column_privilege(api_role, relation, 'SELECT, INSERT, UPDATE, REFERENCES')
            THEN
                RAISE EXCEPTION 'Unexpected effective API privileges on operational relation %', relation;
            END IF;
        END LOOP;
    END LOOP;
END
$$;
