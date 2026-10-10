-- Run with psql -X -v ON_ERROR_STOP=1 against a migrated, disposable database.
-- Requires SET ROLE for API roles; never grant that ability to the application.
BEGIN;
SET LOCAL statement_timeout = '10s';
INSERT INTO public.guild_quotas (guild_id, daily_text_tokens)
VALUES ('quota-role-contract', 100);
INSERT INTO public.role_tier_quotas (guild_id, role_tier, text_tokens, images, voice_minutes)
VALUES ('quota-role-contract', 'member', 100, 0, 0);
SET LOCAL ROLE service_role;
DO $$
DECLARE result record;
BEGIN
  IF current_user <> 'service_role' THEN RAISE EXCEPTION 'wrong role'; END IF;
  SELECT * INTO result FROM public.reserve_quota_usage(
    'quota-role-contract', 'quota-role-contract', 'service-user', 'member', 'text_tokens', 1, 1);
  IF result.allowed IS DISTINCT FROM true THEN RAISE EXCEPTION 'service reservation denied'; END IF;
  SELECT * INTO result FROM public.mark_quota_usage_attempted('quota-role-contract');
  IF result.status IS DISTINCT FROM 'attempted' THEN RAISE EXCEPTION 'attempt transition failed'; END IF;
  SELECT * INTO result FROM public.commit_quota_usage('quota-role-contract', 1);
  IF result.status IS DISTINCT FROM 'committed' OR result.actual_amount IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'commit transition failed';
  END IF;
END $$;
SET LOCAL ROLE anon;
DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.reserve_quota_usage(
      'quota-role-anon', 'quota-role-contract', 'anonymous', 'member', 'text_tokens', 1, 1);
    RAISE EXCEPTION 'anonymous execution was allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.reserve_quota_usage(
      'quota-role-authenticated', 'quota-role-contract', 'authenticated-user', 'member', 'text_tokens', 1, 1);
    RAISE EXCEPTION 'authenticated execution was allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
ROLLBACK;
SELECT 'quota-role-contract-passed';
