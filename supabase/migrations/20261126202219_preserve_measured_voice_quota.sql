-- Voice settlement can arrive after an outage from the runtime journal.
-- Keep expired voice attempts pending until an actual amount is available.

CREATE OR REPLACE FUNCTION public.settle_expired_quota_reservations_scope(
  p_guild_id TEXT,
  p_usage_date DATE,
  p_resource TEXT,
  p_limit INTEGER DEFAULT 1000
) RETURNS TABLE(
  processed INTEGER,
  committed INTEGER,
  released INTEGER,
  failed INTEGER
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $settle_expired_quota_reservations_scope$
DECLARE
  v_candidate RECORD;
  v_lifecycle RECORD;
  v_processed INTEGER := 0;
  v_committed INTEGER := 0;
  v_released INTEGER := 0;
  v_failed INTEGER := 0;
BEGIN
  IF p_guild_id IS NULL
     OR p_guild_id IS DISTINCT FROM btrim(p_guild_id)
     OR char_length(btrim(p_guild_id)) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'guild id must be trimmed and contain between 1 and 128 characters'
      USING ERRCODE = '22023';
  END IF;

  IF p_usage_date IS NULL THEN
    RAISE EXCEPTION 'usage date is required'
      USING ERRCODE = '22023';
  END IF;

  IF p_resource IS NULL OR p_resource NOT IN (
    'text_tokens', 'images', 'voice_minutes', 'vision_tokens', 'video_tokens'
  ) THEN
    RAISE EXCEPTION 'unsupported quota resource'
      USING ERRCODE = '22023';
  END IF;

  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'reconciliation limit must be between 1 and 1000'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.guild_daily_usage (guild_id, usage_date)
  VALUES (p_guild_id, p_usage_date)
  ON CONFLICT ON CONSTRAINT guild_daily_usage_pkey DO NOTHING;

  -- The guild aggregate is the canonical capacity mutex. Nested lifecycle
  -- calls take this same lock before any user row, so lock order is uniform.
  PERFORM 1
  FROM public.guild_daily_usage gdu
  WHERE gdu.guild_id = p_guild_id
    AND gdu.usage_date = p_usage_date
  FOR UPDATE;

  FOR v_candidate IN
    SELECT r.idempotency_key, r.status, r.reserved_amount, r.reported_actual_amount
    FROM public.quota_usage_reservations r
    WHERE r.guild_id = p_guild_id
      AND r.usage_date = p_usage_date
      AND r.resource = p_resource
      AND r.status IN ('reserved', 'attempted')
      AND r.expires_at <= NOW()
      AND (r.status = 'reserved' OR r.resource <> 'images' OR r.settlement_version = 1)
      AND (r.status = 'reserved' OR r.resource <> 'voice_minutes'
           OR r.reported_actual_amount IS NOT NULL)
    ORDER BY r.user_id, r.idempotency_key
    LIMIT p_limit
  LOOP
    v_processed := v_processed + 1;
    BEGIN
      IF v_candidate.status = 'reserved' THEN
        SELECT *
        INTO v_lifecycle
        FROM public.release_quota_usage(
          v_candidate.idempotency_key,
          'expired_before_attempt'
        );
        IF v_lifecycle.status = 'released' AND NOT v_lifecycle.idempotent THEN
          v_released := v_released + 1;
        END IF;
      ELSE
        SELECT *
        INTO v_lifecycle
        FROM public.commit_quota_usage(
          v_candidate.idempotency_key,
          COALESCE(v_candidate.reported_actual_amount, v_candidate.reserved_amount)
        );
        IF v_lifecycle.status = 'committed' AND NOT v_lifecycle.idempotent THEN
          v_committed := v_committed + 1;
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
    END;
  END LOOP;

  RETURN QUERY SELECT v_processed, v_committed, v_released, v_failed;
END;
$settle_expired_quota_reservations_scope$;

CREATE OR REPLACE FUNCTION public.reconcile_expired_quota_reservations(
  p_limit INTEGER DEFAULT 100
) RETURNS TABLE(
  processed INTEGER,
  committed INTEGER,
  released INTEGER,
  failed INTEGER
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $reconcile_expired_quota_reservations$
DECLARE
  v_candidate RECORD;
  v_lifecycle RECORD;
  v_processed INTEGER := 0;
  v_committed INTEGER := 0;
  v_released INTEGER := 0;
  v_failed INTEGER := 0;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'reconciliation limit must be between 1 and 1000'
      USING ERRCODE = '22023';
  END IF;

  IF NOT pg_catalog.pg_try_advisory_xact_lock(700096021) THEN
    RETURN QUERY SELECT 0, 0, 0, 0;
    RETURN;
  END IF;

  FOR v_candidate IN
    SELECT r.idempotency_key, r.status, r.reserved_amount, r.reported_actual_amount
    FROM public.quota_usage_reservations r
    WHERE r.status IN ('reserved', 'attempted')
      AND r.expires_at <= NOW()
      AND (r.status = 'reserved' OR r.resource <> 'images' OR r.settlement_version = 1)
      AND (r.status = 'reserved' OR r.resource <> 'voice_minutes'
           OR r.reported_actual_amount IS NOT NULL)
    ORDER BY r.expires_at, r.idempotency_key
    LIMIT p_limit
  LOOP
    v_processed := v_processed + 1;
    BEGIN
      IF v_candidate.status = 'reserved' THEN
        SELECT *
        INTO v_lifecycle
        FROM public.release_quota_usage(
          v_candidate.idempotency_key,
          'expired_before_attempt'
        );
        IF v_lifecycle.status = 'released' AND NOT v_lifecycle.idempotent THEN
          v_released := v_released + 1;
        END IF;
      ELSE
        SELECT *
        INTO v_lifecycle
        FROM public.commit_quota_usage(
          v_candidate.idempotency_key,
          COALESCE(v_candidate.reported_actual_amount, v_candidate.reserved_amount)
        );
        IF v_lifecycle.status = 'committed' AND NOT v_lifecycle.idempotent THEN
          v_committed := v_committed + 1;
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
    END;
  END LOOP;

  RETURN QUERY SELECT v_processed, v_committed, v_released, v_failed;
END;
$reconcile_expired_quota_reservations$;
