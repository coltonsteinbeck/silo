import { describe, expect, test } from 'bun:test';
import { findRepoHygieneViolations } from '../../../../../scripts/check-repo-hygiene';

describe('repo hygiene check', () => {
  test('flags local artifacts and secrets', () => {
    const violations = findRepoHygieneViolations([
      '.env',
      'logs/pm2-out.log',
      'fileDump/conversation_messages_rows(4).csv',
      '.claude/agents/example.md',
      'conversation_messages_rows(5).csv',
      '.workflow-local/cases/example.json',
      'exports/messages.jsonl',
      'backup.sqlite3'
    ]);

    expect(violations.map(violation => violation.file)).toEqual([
      '.env',
      'logs/pm2-out.log',
      'fileDump/conversation_messages_rows(4).csv',
      '.claude/agents/example.md',
      'conversation_messages_rows(5).csv',
      '.workflow-local/cases/example.json',
      'exports/messages.jsonl',
      'backup.sqlite3'
    ]);
  });

  test('allows representative test fixtures and env examples', () => {
    const violations = findRepoHygieneViolations([
      '.env.example',
      'packages/bot/src/__tests__/fixtures/conversation-output-safety.csv',
      'docker/postgres-init/000_supabase_compat.sql',
      'supabase/migrations/001_public_schema.sql',
      'logs.md'
    ]);

    expect(violations).toEqual([]);
  });
});
