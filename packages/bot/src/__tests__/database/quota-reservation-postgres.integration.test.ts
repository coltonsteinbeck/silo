import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PostgresAdapter } from '../../database/postgres';
import { Pool, type PoolClient } from 'pg';

const RUN_DATABASE_TESTS = process.env.RUN_QUOTA_DB_TESTS === 'true';

type QuotaLimits = {
  textTokens: number;
  images: number;
  voiceMinutes: number;
  visionTokens: number;
  videoTokens: number;
};

type ReserveRow = {
  idempotency_key: string;
  status: 'reserved' | 'attempted' | 'committed' | 'released';
  allowed: boolean;
  reason: string | null;
  requested_amount: number;
  reserved_amount: number;
  remaining: number | null;
  user_limit: number | null;
  guild_limit: number | null;
  usage_date: string | Date;
  quota_exempt: boolean;
};

type LifecycleRow = {
  idempotency_key: string;
  status: 'reserved' | 'attempted' | 'committed' | 'released';
  reserved_amount: number;
  actual_amount: number | null;
  usage_date: string | Date;
  idempotent: boolean;
};

const generousLimits: QuotaLimits = {
  textTokens: 100,
  images: 10,
  voiceMinutes: 100,
  visionTokens: 100,
  videoTokens: 100
};

const zeroLimits: QuotaLimits = {
  textTokens: 0,
  images: 0,
  voiceMinutes: 0,
  visionTokens: 0,
  videoTokens: 0
};

function localConnectionString(): string {
  const connectionString = process.env.QUOTA_TEST_DATABASE_URL;
  if (!connectionString) throw new Error('QUOTA_TEST_DATABASE_URL is required');
  const parsed = new URL(connectionString);
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname.toLowerCase()) ||
    ['/', '/postgres', '/template0', '/template1'].includes(parsed.pathname)
  ) {
    throw new Error('Quota integration tests refuse to mutate a non-loopback database');
  }
  return connectionString;
}

test('quota database tests require an explicit dedicated local database', () => {
  const previous = process.env.QUOTA_TEST_DATABASE_URL;
  try {
    delete process.env.QUOTA_TEST_DATABASE_URL;
    expect(localConnectionString).toThrow('QUOTA_TEST_DATABASE_URL is required');
    process.env.QUOTA_TEST_DATABASE_URL = 'postgresql://example.invalid/fixture';
    expect(localConnectionString).toThrow('non-loopback database');
  } finally {
    if (previous === undefined) delete process.env.QUOTA_TEST_DATABASE_URL;
    else process.env.QUOTA_TEST_DATABASE_URL = previous;
  }
});

async function openPool(): Promise<Pool> {
  const pool = new Pool({
    connectionString: localConnectionString(),
    connectionTimeoutMillis: 3_000,
    max: 8
  });
  await pool.query('SELECT 1');
  return pool;
}

async function assertMigrationInstalled(pool: Pool): Promise<void> {
  const result = await pool.query<{
    reserve: string | null;
    recordActual: string | null;
    reconcile: string | null;
  }>(
    `SELECT
       to_regprocedure(
         'public.reserve_quota_usage(text,text,text,text,text,integer,integer)'
       )::text AS reserve,
       to_regprocedure(
         'public.reconcile_expired_quota_reservations(integer)'
       )::text AS reconcile,
       to_regprocedure(
         'public.record_quota_usage_actual(text,integer)'
       )::text AS "recordActual"`
  );
  expect(result.rows[0]?.reserve).not.toBeNull();
  expect(result.rows[0]?.recordActual).not.toBeNull();
  expect(result.rows[0]?.reconcile).not.toBeNull();
}

async function installFixture(
  pool: Pool,
  guildId: string,
  guildLimits: QuotaLimits,
  userLimits: QuotaLimits = guildLimits,
  quotaExempt = false
): Promise<void> {
  await pool.query(
    `INSERT INTO public.guild_quotas (
       guild_id,
       daily_text_tokens,
       daily_images,
       daily_voice_minutes,
       daily_vision_tokens,
       daily_video_tokens,
       quota_exempt
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (guild_id) DO UPDATE SET
       daily_text_tokens = EXCLUDED.daily_text_tokens,
       daily_images = EXCLUDED.daily_images,
       daily_voice_minutes = EXCLUDED.daily_voice_minutes,
       daily_vision_tokens = EXCLUDED.daily_vision_tokens,
       daily_video_tokens = EXCLUDED.daily_video_tokens,
       quota_exempt = EXCLUDED.quota_exempt`,
    [
      guildId,
      guildLimits.textTokens,
      guildLimits.images,
      guildLimits.voiceMinutes,
      guildLimits.visionTokens,
      guildLimits.videoTokens,
      quotaExempt
    ]
  );

  await pool.query(
    `INSERT INTO public.role_tier_quotas (
       guild_id,
       role_tier,
       text_tokens,
       images,
       voice_minutes,
       vision_tokens,
       video_tokens
     ) VALUES ($1, 'member', $2, $3, $4, $5, $6)
     ON CONFLICT (guild_id, role_tier) DO UPDATE SET
       text_tokens = EXCLUDED.text_tokens,
       images = EXCLUDED.images,
       voice_minutes = EXCLUDED.voice_minutes,
       vision_tokens = EXCLUDED.vision_tokens,
       video_tokens = EXCLUDED.video_tokens`,
    [
      guildId,
      userLimits.textTokens,
      userLimits.images,
      userLimits.voiceMinutes,
      userLimits.visionTokens,
      userLimits.videoTokens
    ]
  );
}

async function cleanupFixtures(pool: Pool, guildIds: string[]): Promise<void> {
  if (guildIds.length === 0) return;
  for (const table of [
    'quota_usage_reservations',
    'usage_tracking',
    'guild_daily_usage',
    'role_tier_quotas',
    'guild_quotas'
  ]) {
    await pool.query(`DELETE FROM public.${table} WHERE guild_id = ANY($1::text[])`, [guildIds]);
  }
}

async function reserve(
  queryable: Pool | PoolClient,
  params: {
    key: string;
    guildId: string;
    userId: string;
    resource: string;
    requested: number;
    minimum: number;
  }
): Promise<ReserveRow> {
  const result = await queryable.query<ReserveRow>(
    `SELECT *
     FROM public.reserve_quota_usage($1, $2, $3, 'member', $4, $5, $6)`,
    [params.key, params.guildId, params.userId, params.resource, params.requested, params.minimum]
  );
  if (!result.rows[0]) throw new Error('reserve_quota_usage returned no row');
  return result.rows[0];
}

async function lifecycle(
  queryable: Pool | PoolClient,
  functionName: 'mark_quota_usage_attempted' | 'commit_quota_usage' | 'release_quota_usage',
  key: string,
  value?: number | string
): Promise<LifecycleRow> {
  const parameters = value === undefined ? [key] : [key, value];
  const placeholders = value === undefined ? '$1' : '$1, $2';
  const result = await queryable.query<LifecycleRow>(
    `SELECT * FROM public.${functionName}(${placeholders})`,
    parameters
  );
  if (!result.rows[0]) throw new Error(`${functionName} returned no row`);
  return result.rows[0];
}

describe.skipIf(!RUN_DATABASE_TESTS)('atomic quota reservations on local Postgres', () => {
  test('serializes guild capacity and globally idempotent keys', async () => {
    const pool = await openPool();
    const runId = randomUUID();
    const guildIds = [
      `quota-image-${runId}`,
      `quota-partial-${runId}`,
      `quota-user-${runId}`,
      `quota-exempt-${runId}`,
      `quota-key-a-${runId}`,
      `quota-key-b-${runId}`
    ];

    try {
      await assertMigrationInstalled(pool);
      await installFixture(pool, guildIds[0]!, { ...generousLimits, images: 2 });
      await installFixture(pool, guildIds[1]!, { ...generousLimits, textTokens: 10 });
      await installFixture(pool, guildIds[2]!, generousLimits, {
        ...generousLimits,
        textTokens: 3
      });
      await installFixture(pool, guildIds[3]!, zeroLimits, zeroLimits, true);
      await installFixture(pool, guildIds[4]!, generousLimits);
      await installFixture(pool, guildIds[5]!, generousLimits);

      const imageRace = await Promise.all([
        reserve(pool, {
          key: `${runId}:image-a`,
          guildId: guildIds[0]!,
          userId: 'user-a',
          resource: 'images',
          requested: 2,
          minimum: 2
        }),
        reserve(pool, {
          key: `${runId}:image-b`,
          guildId: guildIds[0]!,
          userId: 'user-b',
          resource: 'images',
          requested: 2,
          minimum: 2
        })
      ]);
      expect(imageRace.filter(row => row.allowed)).toHaveLength(1);
      expect(imageRace.filter(row => !row.allowed)).toHaveLength(1);
      expect(imageRace.reduce((total, row) => total + row.reserved_amount, 0)).toBe(2);
      expect(imageRace.find(row => !row.allowed)).toMatchObject({
        status: 'released',
        reason: 'insufficient_quota',
        reserved_amount: 0
      });

      const firstPartial = await reserve(pool, {
        key: `${runId}:partial-first`,
        guildId: guildIds[1]!,
        userId: 'partial-user',
        resource: 'text_tokens',
        requested: 7,
        minimum: 7
      });
      const secondPartial = await reserve(pool, {
        key: `${runId}:partial-second`,
        guildId: guildIds[1]!,
        userId: 'partial-user',
        resource: 'text_tokens',
        requested: 8,
        minimum: 3
      });
      expect(firstPartial.reserved_amount).toBe(7);
      expect(secondPartial.allowed).toBe(true);
      expect(secondPartial.reserved_amount).toBe(3);
      expect(secondPartial.remaining).toBe(0);
      const repeatedPartial = await reserve(pool, {
        key: `${runId}:partial-first`,
        guildId: guildIds[1]!,
        userId: 'partial-user',
        resource: 'text_tokens',
        requested: 7,
        minimum: 7
      });
      expect(repeatedPartial).toMatchObject({
        idempotency_key: firstPartial.idempotency_key,
        status: 'reserved',
        allowed: false,
        reason: 'idempotency_key_already_reserved',
        reserved_amount: 7
      });

      const databaseOwnedUserLimit = await reserve(pool, {
        key: `${runId}:user-limit`,
        guildId: guildIds[2]!,
        userId: 'limited-user',
        resource: 'text_tokens',
        requested: 7,
        minimum: 2
      });
      expect(databaseOwnedUserLimit.user_limit).toBe(3);
      expect(databaseOwnedUserLimit.reserved_amount).toBe(3);

      const exemptReservation = await reserve(pool, {
        key: `${runId}:exempt`,
        guildId: guildIds[3]!,
        userId: 'exempt-user',
        resource: 'text_tokens',
        requested: 100,
        minimum: 100
      });
      expect(exemptReservation).toMatchObject({
        allowed: true,
        quota_exempt: true,
        reserved_amount: 100,
        remaining: null
      });

      const sharedKey = `${runId}:global-key`;
      const sharedKeyRace = await Promise.allSettled([
        reserve(pool, {
          key: sharedKey,
          guildId: guildIds[4]!,
          userId: 'key-user-a',
          resource: 'text_tokens',
          requested: 1,
          minimum: 1
        }),
        reserve(pool, {
          key: sharedKey,
          guildId: guildIds[5]!,
          userId: 'key-user-b',
          resource: 'text_tokens',
          requested: 1,
          minimum: 1
        })
      ]);
      expect(sharedKeyRace.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      const keyRejection = sharedKeyRace.find(result => result.status === 'rejected');
      expect(keyRejection?.status).toBe('rejected');
      expect(String((keyRejection as PromiseRejectedResult).reason)).toContain(
        'parameters do not match'
      );

      await expect(
        reserve(pool, {
          key: `${runId}:media-mismatch`,
          guildId: guildIds[0]!,
          userId: 'user-a',
          resource: 'images',
          requested: 2,
          minimum: 1
        })
      ).rejects.toThrow('require an exact grant');
      await expect(
        reserve(pool, {
          key: `${runId}:zero`,
          guildId: guildIds[0]!,
          userId: 'user-a',
          resource: 'text_tokens',
          requested: 0,
          minimum: 0
        })
      ).rejects.toThrow('positive integer');
    } finally {
      await cleanupFixtures(pool, guildIds);
      await pool.end();
    }
  }, 30_000);

  test('makes lifecycle transitions exactly once and reconciles expiry conservatively', async () => {
    const pool = await openPool();
    const runId = randomUUID();
    const guildIds = [
      `quota-life-${runId}`,
      `quota-release-${runId}`,
      `quota-reconcile-${runId}`,
      `quota-lazy-${runId}`
    ];

    try {
      await assertMigrationInstalled(pool);
      for (const guildId of guildIds) await installFixture(pool, guildId, generousLimits);

      const lifecycleKey = `${runId}:lifecycle`;
      const lifecycleReservation = await reserve(pool, {
        key: lifecycleKey,
        guildId: guildIds[0]!,
        userId: 'lifecycle-user',
        resource: 'text_tokens',
        requested: 8,
        minimum: 4
      });
      const firstAttempt = await lifecycle(pool, 'mark_quota_usage_attempted', lifecycleKey);
      const secondAttempt = await lifecycle(pool, 'mark_quota_usage_attempted', lifecycleKey);
      expect(firstAttempt.idempotent).toBe(false);
      expect(secondAttempt.idempotent).toBe(true);
      await expect(
        lifecycle(pool, 'release_quota_usage', lifecycleKey, 'too_late')
      ).rejects.toThrow('cannot be released');
      await expect(lifecycle(pool, 'commit_quota_usage', lifecycleKey, 0)).rejects.toThrow(
        'positive integer'
      );

      const concurrentCommits = await Promise.all([
        lifecycle(pool, 'commit_quota_usage', lifecycleKey, 13),
        lifecycle(pool, 'commit_quota_usage', lifecycleKey, 13)
      ]);
      expect(concurrentCommits).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: 'committed',
            reserved_amount: 8,
            actual_amount: 13,
            idempotent: false
          }),
          expect.objectContaining({
            status: 'committed',
            reserved_amount: 8,
            actual_amount: 13,
            idempotent: true
          })
        ])
      );
      await expect(lifecycle(pool, 'commit_quota_usage', lifecycleKey, 12)).rejects.toThrow(
        'does not match'
      );

      const counters = await pool.query<{
        text_tokens_used: number;
        text_requests: number;
        total_text_tokens: number;
      }>(
        `SELECT ut.text_tokens_used, ut.text_requests, gdu.total_text_tokens
         FROM public.usage_tracking ut
         JOIN public.guild_daily_usage gdu
           ON gdu.guild_id = ut.guild_id AND gdu.usage_date = ut.usage_date
         WHERE ut.guild_id = $1 AND ut.user_id = 'lifecycle-user'`,
        [guildIds[0]]
      );
      expect(counters.rows[0]).toMatchObject({
        text_tokens_used: 13,
        text_requests: 1,
        total_text_tokens: 13
      });
      expect(lifecycleReservation.usage_date).toEqual(concurrentCommits[0]!.usage_date);

      await pool.query(`UPDATE public.guild_quotas SET quota_exempt = TRUE WHERE guild_id = $1`, [
        guildIds[0]
      ]);
      const overflowKey = `${runId}:overflow`;
      await reserve(pool, {
        key: overflowKey,
        guildId: guildIds[0]!,
        userId: 'overflow-user',
        resource: 'text_tokens',
        requested: 1,
        minimum: 1
      });
      await lifecycle(pool, 'mark_quota_usage_attempted', overflowKey);
      await pool.query(
        `UPDATE public.usage_tracking
         SET text_tokens_used = 2147483640
         WHERE guild_id = $1 AND user_id = 'overflow-user'
           AND usage_date = public.quota_local_date()`,
        [guildIds[0]]
      );
      await expect(lifecycle(pool, 'commit_quota_usage', overflowKey, 10)).rejects.toThrow(
        'quota counter overflow'
      );
      const overflowState = await pool.query<{
        status: string;
        actual_amount: number | null;
        text_tokens_used: number;
      }>(
        `SELECT r.status, r.actual_amount, ut.text_tokens_used
         FROM public.quota_usage_reservations r
         JOIN public.usage_tracking ut
           ON ut.guild_id = r.guild_id
          AND ut.user_id = r.user_id
          AND ut.usage_date = r.usage_date
         WHERE r.idempotency_key = $1`,
        [overflowKey]
      );
      expect(overflowState.rows[0]).toEqual({
        status: 'attempted',
        actual_amount: null,
        text_tokens_used: 2147483640
      });

      const releaseKey = `${runId}:release`;
      await reserve(pool, {
        key: releaseKey,
        guildId: guildIds[1]!,
        userId: 'release-user',
        resource: 'text_tokens',
        requested: 3,
        minimum: 1
      });
      const firstRelease = await lifecycle(pool, 'release_quota_usage', releaseKey, 'cancelled');
      const secondRelease = await lifecycle(pool, 'release_quota_usage', releaseKey, 'cancelled');
      expect(firstRelease.idempotent).toBe(false);
      expect(secondRelease.idempotent).toBe(true);
      await expect(
        lifecycle(pool, 'release_quota_usage', releaseKey, 'different_reason')
      ).rejects.toThrow('does not match');
      await expect(lifecycle(pool, 'mark_quota_usage_attempted', releaseKey)).rejects.toThrow(
        'cannot be attempted'
      );

      const reconcileKey = `${runId}:reconcile`;
      await reserve(pool, {
        key: reconcileKey,
        guildId: guildIds[2]!,
        userId: 'reconcile-user',
        resource: 'text_tokens',
        requested: 6,
        minimum: 6
      });
      await lifecycle(pool, 'mark_quota_usage_attempted', reconcileKey);
      await pool.query(`SELECT public.record_quota_usage_actual($1, $2)`, [reconcileKey, 9]);
      await pool.query(
        `UPDATE public.quota_usage_reservations
         SET created_at = TIMESTAMPTZ '1900-01-01 00:00:00+00',
             attempted_at = TIMESTAMPTZ '1900-06-01 00:00:00+00',
             expires_at = TIMESTAMPTZ '1901-01-01 00:00:00+00'
         WHERE idempotency_key = $1`,
        [reconcileKey]
      );
      const reconciled = await pool.query<{
        processed: number;
        committed: number;
        released: number;
        failed: number;
      }>('SELECT * FROM public.reconcile_expired_quota_reservations(1)');
      expect(reconciled.rows[0]).toEqual({ processed: 1, committed: 1, released: 0, failed: 0 });
      await expect(
        pool.query('SELECT * FROM public.reconcile_expired_quota_reservations(0)')
      ).rejects.toThrow('between 1 and 1000');

      const reconciledReservation = await pool.query<{
        status: string;
        actual_amount: number;
      }>(
        `SELECT status, actual_amount
         FROM public.quota_usage_reservations
         WHERE idempotency_key = $1`,
        [reconcileKey]
      );
      expect(reconciledReservation.rows[0]).toEqual({ status: 'committed', actual_amount: 9 });

      const lazyKey = `${runId}:lazy-expired`;
      await reserve(pool, {
        key: lazyKey,
        guildId: guildIds[3]!,
        userId: 'lazy-user',
        resource: 'text_tokens',
        requested: 100,
        minimum: 100
      });
      await pool.query(
        `UPDATE public.quota_usage_reservations
         SET created_at = TIMESTAMPTZ '1902-01-01 00:00:00+00',
             expires_at = TIMESTAMPTZ '1903-01-01 00:00:00+00'
         WHERE idempotency_key = $1`,
        [lazyKey]
      );
      const replacement = await reserve(pool, {
        key: `${runId}:lazy-replacement`,
        guildId: guildIds[3]!,
        userId: 'lazy-user',
        resource: 'text_tokens',
        requested: 100,
        minimum: 100
      });
      expect(replacement).toMatchObject({ allowed: true, reserved_amount: 100 });
      const expired = await pool.query<{ status: string; reason: string }>(
        `SELECT status, reason
         FROM public.quota_usage_reservations
         WHERE idempotency_key = $1`,
        [lazyKey]
      );
      expect(expired.rows[0]).toEqual({ status: 'released', reason: 'expired_before_attempt' });
    } finally {
      await cleanupFixtures(pool, guildIds);
      await pool.end();
    }
  }, 30_000);

  test('keeps legacy increments under the same guild ceiling and backend-only permissions', async () => {
    const pool = await openPool();
    const runId = randomUUID();
    const guildIds = [`quota-legacy-${runId}`, `quota-service-${runId}`];

    try {
      await assertMigrationInstalled(pool);
      await installFixture(pool, guildIds[0]!, { ...generousLimits, images: 1 });
      await installFixture(pool, guildIds[1]!, generousLimits);

      const activeKey = `${runId}:legacy-active`;
      await reserve(pool, {
        key: activeKey,
        guildId: guildIds[0]!,
        userId: 'reservation-user',
        resource: 'images',
        requested: 1,
        minimum: 1
      });
      const blockedByReservation = await pool.query<{ success: boolean }>(
        `SELECT * FROM public.increment_usage_atomic($1, $2, 'images', 1, 10)`,
        [guildIds[0], 'legacy-user-a']
      );
      expect(blockedByReservation.rows[0]?.success).toBe(false);
      await lifecycle(pool, 'release_quota_usage', activeKey, 'not_started');

      const legacyRace = await Promise.all([
        pool.query<{ success: boolean }>(
          `SELECT * FROM public.increment_usage_atomic($1, $2, 'images', 1, 10)`,
          [guildIds[0], 'legacy-user-a']
        ),
        pool.query<{ success: boolean }>(
          `SELECT * FROM public.increment_usage_atomic($1, $2, 'images', 1, 10)`,
          [guildIds[0], 'legacy-user-b']
        )
      ]);
      expect(legacyRace.filter(result => result.rows[0]?.success)).toHaveLength(1);
      const guildUsage = await pool.query<{ total_images: number }>(
        `SELECT total_images
         FROM public.guild_daily_usage
         WHERE guild_id = $1 AND usage_date = public.quota_local_date()`,
        [guildIds[0]]
      );
      expect(guildUsage.rows[0]?.total_images).toBe(1);

      const permissions = await pool.query<{
        anon_execute: boolean;
        authenticated_execute: boolean;
        service_execute: boolean;
        rls_enabled: boolean;
      }>(
        `SELECT
           has_function_privilege(
             'anon',
             'public.reserve_quota_usage(text,text,text,text,text,integer,integer)',
             'EXECUTE'
           ) AS anon_execute,
           has_function_privilege(
             'authenticated',
             'public.reserve_quota_usage(text,text,text,text,text,integer,integer)',
             'EXECUTE'
           ) AS authenticated_execute,
           has_function_privilege(
             'service_role',
             'public.reserve_quota_usage(text,text,text,text,text,integer,integer)',
             'EXECUTE'
           ) AS service_execute,
           relrowsecurity AS rls_enabled
         FROM pg_catalog.pg_class
         WHERE oid = 'public.quota_usage_reservations'::regclass`
      );
      expect(permissions.rows[0]).toEqual({
        anon_execute: false,
        authenticated_execute: false,
        service_execute: true,
        rls_enabled: true
      });

      // Role execution is checked separately by quota-role-contract.sql using psql.
      // The application connection must not acquire permission to impersonate API roles.
    } finally {
      await cleanupFixtures(pool, guildIds);
      await pool.end();
    }
  }, 30_000);
});

test.skipIf(!RUN_DATABASE_TESTS)(
  'duplicate concurrent interactions authorize one production quota execution',
  async () => {
    const { AdminAdapter } = await import('../../database/admin-adapter');
    const { PermissionManager } = await import('../../permissions/manager');
    const { QuotaMiddleware } = await import('../../middleware/quota');
    const pool = await openPool();
    const guildId = `quota-command-${randomUUID()}`;
    try {
      await assertMigrationInstalled(pool);
      await installFixture(pool, guildId, generousLimits);
      const admin = new AdminAdapter(pool);
      const quota = new QuotaMiddleware(admin, new PermissionManager(admin));
      const operationKey = `discord:${randomUUID()}:search`;
      let paidCalls = 0;
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          quota.executeReserved({
            operationKey,
            guildId,
            userId: 'requester',
            usageType: 'text_tokens',
            requestedAmount: 7,
            member: { permissions: { has: () => false }, communicationDisabledUntil: null } as any,
            execute: async () => {
              paidCalls++;
              await new Promise(resolve => setTimeout(resolve, 20));
              return 3;
            },
            getActualAmount: value => value
          })
        )
      );
      expect(results.filter(result => result.allowed)).toHaveLength(1);
      expect(paidCalls).toBe(1);
      const result = await pool.query(
        'SELECT text_tokens_used, text_requests FROM public.usage_tracking WHERE guild_id = $1 AND user_id = $2',
        [guildId, 'requester']
      );
      expect(result.rows[0]).toMatchObject({ text_tokens_used: 3, text_requests: 1 });
    } finally {
      await cleanupFixtures(pool, [guildId]);
      await pool.end();
    }
  },
  30_000
);

const RUN_INGRESS_DATABASE_TESTS = process.env.RUN_INGRESS_DB_TESTS === 'true';

describe.skipIf(!RUN_INGRESS_DATABASE_TESTS)('PostgreSQL ingress concurrency and restart', () => {
  test('concurrent adapters and a fresh connection cannot replay claimed ingress', async () => {
    const first = new PostgresAdapter(localConnectionString(), { ssl: false });
    const second = new PostgresAdapter(localConnectionString(), { ssl: false });
    const message = {
      messageId: 'ingress-fixture-' + randomUUID(),
      guildId: 'fixture-guild',
      channelId: 'fixture-channel',
      userId: 'fixture-user'
    };
    let firstEnded = false;
    try {
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          (index % 2 ? first : second).claimAssistantMessage(message)
        )
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      await first.pool.end();
      firstEnded = true;
      const restarted = new PostgresAdapter(localConnectionString(), { ssl: false });
      try {
        expect(await restarted.claimAssistantMessage(message)).toBe(false);
      } finally {
        await restarted.pool.end();
      }
      const rows = await second.pool.query(
        'SELECT * FROM assistant_message_ingress WHERE message_id=$1',
        [message.messageId]
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]?.user_id).toBe(message.userId);
    } finally {
      await second.pool.query('DELETE FROM assistant_message_ingress WHERE message_id=$1', [
        message.messageId
      ]);
      await Promise.all([...(firstEnded ? [] : [first.pool.end()]), second.pool.end()]);
    }
  });
  test('cleanup expires old claims and preserves recent admission', async () => {
    const adapter = new PostgresAdapter(localConnectionString(), { ssl: false });
    const ids = ['ingress-old-', 'ingress-recent-'].map(prefix => prefix + randomUUID());
    try {
      for (const messageId of ids)
        await adapter.claimAssistantMessage({
          messageId,
          guildId: 'fixture-guild',
          channelId: 'fixture-channel',
          userId: 'fixture-user'
        });
      await adapter.pool.query(
        "UPDATE assistant_message_ingress SET created_at=NOW()-INTERVAL '91 days' WHERE message_id=$1",
        [ids[0]]
      );
      await adapter.cleanupAssistantMessageIngress();
      const rows = await adapter.pool.query(
        'SELECT message_id FROM assistant_message_ingress WHERE message_id=ANY($1::text[])',
        [ids]
      );
      expect(rows.rows.map(row => row.message_id)).toEqual([ids[1]]);
    } finally {
      await adapter.pool.query(
        'DELETE FROM assistant_message_ingress WHERE message_id=ANY($1::text[])',
        [ids]
      );
      await adapter.pool.end();
    }
  });
});
