import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migrationPath = resolve(
  import.meta.dir,
  '../../../../../supabase/migrations/027_atomic_quota_reservations.sql'
);
const migration = readFileSync(migrationPath, 'utf8');
const normalized = migration.replace(/\s+/g, ' ').trim();

function functionBody(tag: string): string {
  const delimiter = `$${tag}$`;
  const start = migration.indexOf(delimiter);
  const end = migration.indexOf(delimiter, start + delimiter.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return migration.slice(start + delimiter.length, end);
}

describe('atomic quota reservation migration contract', () => {
  test('defines a constrained active ledger with minimal indexes', () => {
    expect(normalized).toContain('CREATE TABLE public.quota_usage_reservations');
    expect(normalized).toContain("status IN ('reserved', 'attempted', 'committed', 'released')");
    expect(normalized).toContain('requested_amount > 0');
    expect(normalized).toContain('minimum_amount > 0 AND minimum_amount <= requested_amount');
    expect(normalized).toContain('idempotency_key = btrim(idempotency_key)');
    expect(normalized).toContain("status <> 'released' OR reason IS NOT NULL");
    expect(normalized).toContain(
      "resource NOT IN ('images', 'video_tokens') OR minimum_amount = requested_amount"
    );
    expect(normalized).toContain('AND actual_amount > 0');
    expect(normalized).toContain('reported_actual_amount INTEGER');
    expect(normalized).toContain("status <> 'committed' OR reported_actual_amount = actual_amount");
    expect(normalized).toContain('CREATE INDEX idx_quota_usage_reservations_active_scope');
    expect(normalized).toContain('CREATE INDEX idx_quota_usage_reservations_expiry');
  });

  test('exposes stable reserve and lifecycle row shapes', () => {
    expect(normalized).toContain(
      'CREATE OR REPLACE FUNCTION public.reserve_quota_usage( p_idempotency_key TEXT, p_guild_id TEXT, p_user_id TEXT, p_role_tier TEXT, p_resource TEXT, p_requested_amount INTEGER, p_minimum_amount INTEGER ) RETURNS TABLE( idempotency_key TEXT, status TEXT, allowed BOOLEAN, reason TEXT, requested_amount INTEGER, reserved_amount INTEGER, remaining INTEGER, user_limit INTEGER, guild_limit INTEGER, usage_date DATE, quota_exempt BOOLEAN )'
    );

    for (const signature of [
      'public.mark_quota_usage_attempted( p_idempotency_key TEXT )',
      'public.commit_quota_usage( p_idempotency_key TEXT, p_actual_amount INTEGER )',
      'public.release_quota_usage( p_idempotency_key TEXT, p_reason TEXT )'
    ]) {
      expect(normalized).toContain(
        `CREATE OR REPLACE FUNCTION ${signature} RETURNS TABLE( idempotency_key TEXT, status TEXT, reserved_amount INTEGER, actual_amount INTEGER, usage_date DATE, idempotent BOOLEAN )`
      );
    }
    expect(normalized).toContain(
      'CREATE OR REPLACE FUNCTION public.record_quota_usage_actual( p_idempotency_key TEXT, p_actual_amount INTEGER ) RETURNS INTEGER'
    );
  });

  test('locks guild capacity before user usage in every mutating path', () => {
    expect(migration).not.toMatch(/ON CONFLICT \([^)]*usage_date[^)]*\)/);
    expect(normalized).toContain('ON CONFLICT ON CONSTRAINT guild_daily_usage_pkey DO NOTHING');
    expect(normalized).toContain(
      'ON CONFLICT ON CONSTRAINT usage_tracking_guild_id_user_id_usage_date_key DO NOTHING'
    );

    for (const tag of [
      'mark_quota_usage_attempted',
      'commit_quota_usage',
      'release_quota_usage',
      'reserve_quota_usage',
      'increment_usage_atomic'
    ]) {
      const body = functionBody(tag);
      const guildLock = body.indexOf('FROM public.guild_daily_usage');
      const guildForUpdate = body.indexOf('FOR UPDATE', guildLock);
      const userLock = body.indexOf('FROM public.usage_tracking', guildForUpdate);
      const userForUpdate = body.indexOf('FOR UPDATE', userLock);

      expect(guildLock, `${tag} must read the guild aggregate`).toBeGreaterThanOrEqual(0);
      expect(guildForUpdate, `${tag} must lock the guild aggregate`).toBeGreaterThan(guildLock);
      expect(userLock, `${tag} must read user usage after the guild lock`).toBeGreaterThan(
        guildForUpdate
      );
      expect(userForUpdate, `${tag} must lock user usage`).toBeGreaterThan(userLock);
    }
  });

  test('counts active leases and settles expired attempted work conservatively', () => {
    const reserve = functionBody('reserve_quota_usage');
    const reconcile = functionBody('reconcile_expired_quota_reservations').replace(/\s+/g, ' ');

    expect(reserve).toContain("r.status = 'attempted'");
    expect(reserve).toContain("r.status = 'reserved' AND r.expires_at > NOW()");
    expect(reserve).toContain('pg_catalog.pg_advisory_xact_lock');
    expect(reserve).toContain("'silo:quota-reservation:' || p_idempotency_key");
    expect(reserve).toContain('public.settle_expired_quota_reservations_scope');
    expect(reserve).toContain(
      'v_reserved_amount := LEAST(p_requested_amount::BIGINT, v_available)::INTEGER'
    );
    expect(reserve).toContain('v_allowed := v_reserved_amount >= p_minimum_amount');
    expect(reconcile).toContain(
      'public.commit_quota_usage( v_candidate.idempotency_key, COALESCE(v_candidate.reported_actual_amount, v_candidate.reserved_amount) )'
    );
    expect(reconcile).toContain("'expired_before_attempt'");
  });

  test('rejects a repeated reservation key before another provider attempt', () => {
    const reserve = functionBody('reserve_quota_usage').replace(/\s+/g, ' ');
    expect(reserve).toContain(
      'IF FOUND THEN IF v_reservation.guild_id IS DISTINCT FROM p_guild_id'
    );
    expect(reserve).toContain(
      "RETURN QUERY SELECT v_reservation.idempotency_key, v_reservation.status, FALSE, 'idempotency_key_already_' || v_reservation.status"
    );
  });

  test('settles exact provider overage with explicit overflow protection', () => {
    const commit = functionBody('commit_quota_usage').replace(/\s+/g, ' ');

    expect(commit).not.toContain('p_actual_amount > v_reservation.reserved_amount');
    expect(commit).toContain('v_user_current > 2147483647::BIGINT - p_actual_amount::BIGINT');
    expect(commit).toContain("v_reservation.resource IN ('vision_tokens', 'video_tokens')");
    expect(commit).toContain(
      "RAISE EXCEPTION 'quota counter overflow while committing exact provider usage'"
    );
    expect(commit).toContain('actual_amount = p_actual_amount');
  });

  test('hardens compatibility accounting against guild races', () => {
    const compatibility = functionBody('increment_usage_atomic');

    expect(compatibility).toContain('public.settle_expired_quota_reservations_scope');
    expect(compatibility).toContain('v_guild_current + v_guild_active + p_amount > v_guild_limit');
    expect(compatibility).toContain('p_user_limit::BIGINT - v_user_current - v_user_active');
  });

  test('uses invoker rights, RLS, and explicit backend-only grants', () => {
    expect(migration).not.toContain('SECURITY DEFINER');
    expect(normalized).toContain(
      'ALTER TABLE public.quota_usage_reservations ENABLE ROW LEVEL SECURITY'
    );
    expect(normalized).toContain(
      'REVOKE ALL ON TABLE public.quota_usage_reservations FROM PUBLIC, anon, authenticated'
    );
    expect(normalized).toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE public.quota_usage_reservations TO service_role'
    );
    expect(normalized).toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE public.usage_tracking TO service_role'
    );
    expect(normalized).toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE public.guild_daily_usage TO service_role'
    );

    for (const functionName of [
      'reserve_quota_usage',
      'mark_quota_usage_attempted',
      'record_quota_usage_actual',
      'commit_quota_usage',
      'release_quota_usage',
      'settle_expired_quota_reservations_scope',
      'reconcile_expired_quota_reservations',
      'increment_usage_atomic'
    ]) {
      expect(normalized).toContain(`REVOKE EXECUTE ON FUNCTION public.${functionName}`);
      expect(normalized).toContain(`GRANT EXECUTE ON FUNCTION public.${functionName}`);
    }
  });
});
