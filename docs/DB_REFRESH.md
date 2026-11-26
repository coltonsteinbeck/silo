# Database refresh and recovery

Use the local database and synthetic fixtures when developing or running tests.
The operator refresh workflow is for an authorized data transfer in a private
environment. The supported targets are an isolated local database and a
non-production branch database.

## Before refreshing

1. Verify the source and target independently and confirm the approved data
   scope. Apply any required target migrations separately.
2. Create or select an owner-only backup directory outside the repository.
   Verify its storage access and retention policy. The script rejects an
   unprotected location and requires a nonempty target backup before restore.
3. Supply `PROD_DB_URL` and `BRANCH_DB_URL` through the operator's private
   configuration. Set `BACKUP_DIR` to the approved directory,
   `INCLUDE_TABLES` to a comma-separated list of explicit schema-qualified
   tables, and `CONFIRM_REMOTE_RESTORE=true` after checking the destination.
4. Run `bun run db:refresh:branch` from the operator environment. If restoring
   to an explicitly approved local target, also set `ALLOW_LOCAL_TARGET=true`.

The script creates a new restricted subdirectory for each run. It retains the
target rollback backup, the selected data export, and diagnostics there. Its
public-facing receipt contains only completion status. Keep run output, dumps,
diagnostics, and connection configuration out of Git and CI artifacts.

## Rollback

1. Stop application writers connected to the target.
2. Verify the selected `target-before-refresh.dump` and restore it using
   `pg_restore` under the approved restore procedure.
3. Verify migration history, expected permissions, and a smoke query before
   reconnecting the bot.
4. Apply the approved retention policy to backup and diagnostic files after the
   run. Confirm recovery using synthetic data before a live transfer.
