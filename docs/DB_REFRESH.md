# Database Refresh Runbook

This runbook describes the safe sequence for production-derived data refreshes.

## Lanes

1. Local lane (`prod -> local Docker Supabase`)
2. Branch lane (`prod -> persistent remote dev branch`)

Always run lane 1 before lane 2.

## Local Lane

Use your local-only script (ignored by git) to refresh local data:

```bash
./scripts/clone-prod-to-local.sh
```

Expected local target format:

```bash
postgresql://postgres:postgres@127.0.0.1:54322/postgres
```

## Branch Lane

Use the tracked branch refresh script:

```bash
bun run db:refresh:branch
```

The script resolves:

- Source: `HOSTED_DB_IDENTIFIER` + `SUPABASE_PW` (or `PROD_DB_URL`)
- Target: `DEV_DB_IDENTIFIER` + `SUPABASE_DEV_PW` (or `BRANCH_DB_URL`)

Required safety confirmation:

```bash
CONFIRM_REMOTE_RESTORE=true
```

The branch script also performs:

- source/target host safety validation
- migration compatibility check (unless explicitly overridden)
- optional pre-refresh backup of the branch target

## Optional Controls

All controls are passed as environment variables.

- `PROD_SCHEMAS=public`
- `INCLUDE_TABLES=public.users,public.messages`
- `EXCLUDE_TABLES=public.audit_log`
- `TRUNCATE_TARGET=true|false`
- `POST_RESTORE_ANALYZE=true|false`
- `SMOKE_SQL='SELECT NOW();'`
- `ALLOW_MIGRATION_DRIFT=true|false`
- `BACKUP_TARGET_BEFORE_RESTORE=true|false`
- `PRE_RESTORE_SQL_FILE=path/to/pre.sql`
- `POST_RESTORE_SQL_FILE=path/to/post.sql`

## Rollback Checklist (Branch Lane)

Before every branch refresh:

1. Ensure `BACKUP_TARGET_BEFORE_RESTORE=true` (default).
2. Confirm backup artifact exists in `backups/branch_pre_refresh_*.dump`.
3. Record source and target hosts printed by the script in run notes.

If restore quality checks fail:

1. Stop app traffic pointed at branch.
2. Restore the pre-refresh branch backup manually with `pg_restore`.
3. Re-run smoke checks and migration head checks.
4. Investigate and adjust include/exclude/masking settings before retry.

## CI Trigger

Use GitHub Actions workflow:

- `Refresh Dev Branch DB`
- manual dispatch only
- uploads backup artifacts from `backups/`
- includes pre/post migration head check steps

## Guardrails

- Never restore to production host.
- Never run branch refresh without explicit confirmation.
- Do not store credentials in scripts.
- Keep `.env` and local scripts out of git.

## Migration Notes

- Migration `022_video_quota_pricing_alignment.sql` created temporary rollback snapshot tables:
  - `migration_022_guild_quota_backup`
  - `migration_022_role_tier_quota_backup`
- These snapshot tables are non-runtime artifacts. Runtime quota logic uses canonical tables such as `guild_quotas`, `role_tier_quotas`, and `usage_tracking`.
- Migration `023_drop_migration_022_backup_tables.sql` removes the snapshot tables after rollout stabilization.
- If rollback is ever required after migration 023, use database backups rather than migration-022 snapshot tables.
