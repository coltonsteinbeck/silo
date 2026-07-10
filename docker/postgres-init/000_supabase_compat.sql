-- Minimal Supabase compatibility objects for the plain local Postgres image.
-- Production/dev Supabase projects already provide these roles and auth.uid().

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
END;
$$;

CREATE SCHEMA IF NOT EXISTS auth;

DO $bootstrap$
BEGIN
  IF to_regprocedure('auth.uid()') IS NULL THEN
    EXECUTE $function$
      CREATE FUNCTION auth.uid()
      RETURNS UUID
      LANGUAGE SQL
      STABLE
      AS $body$
        SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::UUID;
      $body$
    $function$;
  END IF;
END;
$bootstrap$;

GRANT USAGE ON SCHEMA auth TO service_role, authenticated, anon;
GRANT EXECUTE ON FUNCTION auth.uid() TO service_role, authenticated, anon;
