-- Only a structured provider model-not-found response may release an attempted
-- image reservation. Unmeasured attempts remain held for evidence-based review.
-- Application rollback retains these forward-compatible columns and routines.
-- The previous attempt constraint cannot represent evidence-backed releases.
-- Preserve these rows and their evidence before any separate schema downgrade.
ALTER TABLE public.quota_usage_reservations
  ADD COLUMN IF NOT EXISTS rejection_provider TEXT,
  ADD COLUMN IF NOT EXISTS rejection_status INTEGER,
  ADD COLUMN IF NOT EXISTS rejection_code TEXT,
  ADD COLUMN IF NOT EXISTS rejection_request_id TEXT,
  ADD COLUMN IF NOT EXISTS settlement_version INTEGER;

-- Existing attempted image work needs individual evidence review before a new
-- background reconciler processes it. New reservations opt into this lifecycle.
ALTER TABLE public.quota_usage_reservations
  DROP CONSTRAINT IF EXISTS quota_usage_reservations_settlement_version,
  ALTER COLUMN settlement_version SET DEFAULT 1,
  ADD CONSTRAINT quota_usage_reservations_settlement_version
    CHECK (settlement_version IS NULL OR settlement_version = 1);

ALTER TABLE public.quota_usage_reservations
  DROP CONSTRAINT IF EXISTS quota_usage_reservations_attempt_shape,
  ADD CONSTRAINT quota_usage_reservations_attempt_shape CHECK (
    (status IN ('attempted', 'committed') AND attempted_at IS NOT NULL)
    OR (status = 'reserved' AND attempted_at IS NULL)
    OR (status = 'released' AND (
      (rejection_request_id IS NOT NULL AND attempted_at IS NOT NULL)
      OR (rejection_request_id IS NULL AND attempted_at IS NULL)
    ))
  );

ALTER TABLE public.quota_usage_reservations
  DROP CONSTRAINT IF EXISTS quota_usage_reservations_rejection_evidence,
  ADD CONSTRAINT quota_usage_reservations_rejection_evidence CHECK (
    (rejection_provider IS NULL AND rejection_status IS NULL
      AND rejection_code IS NULL AND rejection_request_id IS NULL)
    OR
    (rejection_provider IS NOT NULL AND rejection_status IS NOT NULL
      AND rejection_code IS NOT NULL AND rejection_request_id IS NOT NULL
      AND status = 'released' AND reason IS NOT DISTINCT FROM 'provider_model_not_found'
      AND resource = 'images' AND attempted_at IS NOT NULL
      AND reported_actual_amount IS NULL AND actual_amount IS NULL
      AND rejection_provider = 'openai'
      AND rejection_status IN (400, 404)
      AND rejection_code = 'model_not_found'
      AND rejection_request_id ~ '^[A-Za-z0-9_-]{1,128}$')
  );

CREATE OR REPLACE FUNCTION public.release_rejected_image_quota_usage(
  p_idempotency_key TEXT,
  p_guild_id TEXT,
  p_user_id TEXT,
  p_provider_status INTEGER,
  p_provider_code TEXT,
  p_provider_request_id TEXT
) RETURNS TABLE(
  idempotency_key TEXT,
  status TEXT,
  reserved_amount INTEGER,
  actual_amount INTEGER,
  usage_date DATE,
  idempotent BOOLEAN
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $release_rejected_image_quota_usage$
DECLARE
  v_identity RECORD;
  v_reservation public.quota_usage_reservations%ROWTYPE;
BEGIN
  IF p_idempotency_key IS NULL OR p_idempotency_key IS DISTINCT FROM btrim(p_idempotency_key)
     OR char_length(p_idempotency_key) NOT BETWEEN 1 AND 255
     OR p_guild_id IS NULL OR p_user_id IS NULL
     OR p_provider_status IS NULL OR p_provider_status NOT IN (400, 404)
     OR p_provider_code IS DISTINCT FROM 'model_not_found'
     OR p_provider_request_id IS NULL
     OR p_provider_request_id !~ '^[A-Za-z0-9_-]{1,128}$' THEN
    RAISE EXCEPTION 'invalid rejected image settlement evidence' USING ERRCODE = '22023';
  END IF;

  SELECT r.guild_id, r.user_id, r.usage_date
  INTO v_identity
  FROM public.quota_usage_reservations r
  WHERE r.idempotency_key = p_idempotency_key;
  IF NOT FOUND OR v_identity.guild_id IS DISTINCT FROM p_guild_id
     OR v_identity.user_id IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'image reservation not found for scope' USING ERRCODE = 'P0002';
  END IF;

  -- Follow the established guild, user, reservation lock order.
  INSERT INTO public.guild_daily_usage (guild_id, usage_date)
  VALUES (v_identity.guild_id, v_identity.usage_date)
  ON CONFLICT ON CONSTRAINT guild_daily_usage_pkey DO NOTHING;
  INSERT INTO public.usage_tracking (guild_id, user_id, usage_date)
  VALUES (v_identity.guild_id, v_identity.user_id, v_identity.usage_date)
  ON CONFLICT ON CONSTRAINT usage_tracking_guild_id_user_id_usage_date_key DO NOTHING;
  PERFORM 1 FROM public.guild_daily_usage gdu
    WHERE gdu.guild_id = v_identity.guild_id AND gdu.usage_date = v_identity.usage_date
    FOR UPDATE;
  PERFORM 1 FROM public.usage_tracking ut
    WHERE ut.guild_id = v_identity.guild_id AND ut.user_id = v_identity.user_id
      AND ut.usage_date = v_identity.usage_date FOR UPDATE;
  SELECT r.* INTO v_reservation FROM public.quota_usage_reservations r
    WHERE r.idempotency_key = p_idempotency_key FOR UPDATE;

  IF v_reservation.status = 'released'
     AND v_reservation.reason = 'provider_model_not_found'
     AND v_reservation.rejection_provider = 'openai'
     AND v_reservation.rejection_status = p_provider_status
     AND v_reservation.rejection_code = p_provider_code
     AND v_reservation.rejection_request_id = p_provider_request_id THEN
    RETURN QUERY SELECT v_reservation.idempotency_key, v_reservation.status,
      v_reservation.reserved_amount, v_reservation.actual_amount,
      v_reservation.usage_date, TRUE;
    RETURN;
  END IF;

  IF v_reservation.status <> 'attempted' OR v_reservation.resource <> 'images'
     OR v_reservation.reported_actual_amount IS NOT NULL THEN
    RAISE EXCEPTION 'image reservation cannot be released from current state'
      USING ERRCODE = '55000';
  END IF;

  UPDATE public.quota_usage_reservations r
  SET status = 'released', reason = 'provider_model_not_found',
      rejection_provider = 'openai', rejection_status = p_provider_status,
      rejection_code = p_provider_code, rejection_request_id = p_provider_request_id,
      finalized_at = NOW(), updated_at = NOW()
  WHERE r.idempotency_key = p_idempotency_key
  RETURNING r.* INTO v_reservation;
  RETURN QUERY SELECT v_reservation.idempotency_key, v_reservation.status,
    v_reservation.reserved_amount, v_reservation.actual_amount,
    v_reservation.usage_date, FALSE;
END;
$release_rejected_image_quota_usage$;

-- Keep historic attempted image rows for evidence-based remediation.
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
      AND (r.status = 'reserved' OR r.resource <> 'images'
           OR (r.settlement_version = 1 AND r.reported_actual_amount IS NOT NULL))
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
      AND (r.status = 'reserved' OR r.resource <> 'images'
           OR (r.settlement_version = 1 AND r.reported_actual_amount IS NOT NULL))
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

REVOKE EXECUTE ON FUNCTION public.release_rejected_image_quota_usage(
  TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_rejected_image_quota_usage(
  TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT) TO service_role;
