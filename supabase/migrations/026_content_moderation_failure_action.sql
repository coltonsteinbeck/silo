-- Migration 026: Preserve fail-closed moderation decisions in the audit log.
-- The runtime emits api_error_fail_closed when a suspicious turn cannot be
-- evaluated safely, so the database constraint must accept that stable action.

ALTER TABLE content_moderation_log
  DROP CONSTRAINT IF EXISTS content_moderation_log_action_taken_check;

ALTER TABLE content_moderation_log
  ADD CONSTRAINT content_moderation_log_action_taken_check
  CHECK (action_taken IN ('allowed', 'blocked', 'warned', 'api_error_fail_closed'));
