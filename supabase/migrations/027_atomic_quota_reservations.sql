-- Migration 027: Durable, atomic quota reservations
--
-- Billable provider work must reserve capacity before external I/O, mark the
-- reservation attempted immediately before I/O, and then commit actual usage
-- exactly once. A reservation can only be released before it is attempted.
-- Expired attempted work is conservatively committed at the reserved amount.

CREATE TABLE public.quota_usage_reservations (
  idempotency_key TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  usage_date DATE NOT NULL,
  role_tier TEXT NOT NULL,
  resource TEXT NOT NULL,
  requested_amount INTEGER NOT NULL,
  minimum_amount INTEGER NOT NULL,
  reserved_amount INTEGER NOT NULL,
  reported_actual_amount INTEGER,
  actual_amount INTEGER,
  remaining_after_reserve INTEGER,
  user_limit INTEGER,
  guild_limit INTEGER,
  quota_exempt BOOLEAN NOT NULL DEFAULT FALSE,
  allowed BOOLEAN NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  attempted_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  finalized_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT quota_usage_reservations_key_length
    CHECK (
      idempotency_key = btrim(idempotency_key)
      AND char_length(idempotency_key) BETWEEN 1 AND 255
    ),
  CONSTRAINT quota_usage_reservations_guild_length
    CHECK (guild_id = btrim(guild_id) AND char_length(guild_id) BETWEEN 1 AND 128),
  CONSTRAINT quota_usage_reservations_user_length
    CHECK (user_id = btrim(user_id) AND char_length(user_id) BETWEEN 1 AND 128),
  CONSTRAINT quota_usage_reservations_role_tier
    CHECK (role_tier IN ('admin', 'moderator', 'trusted', 'member', 'restricted')),
  CONSTRAINT quota_usage_reservations_resource
    CHECK (resource IN ('text_tokens', 'images', 'voice_minutes', 'vision_tokens', 'video_tokens')),
  CONSTRAINT quota_usage_reservations_status
    CHECK (status IN ('reserved', 'attempted', 'committed', 'released')),
  CONSTRAINT quota_usage_reservations_requested_amount
    CHECK (requested_amount > 0),
  CONSTRAINT quota_usage_reservations_minimum_amount
    CHECK (minimum_amount > 0 AND minimum_amount <= requested_amount),
  CONSTRAINT quota_usage_reservations_exact_media_grant
    CHECK (resource NOT IN ('images', 'video_tokens') OR minimum_amount = requested_amount),
  CONSTRAINT quota_usage_reservations_reserved_amount
    CHECK (reserved_amount >= 0 AND reserved_amount <= requested_amount),
  CONSTRAINT quota_usage_reservations_grant_shape
    CHECK (
      (allowed AND reserved_amount >= minimum_amount)
      OR
      (NOT allowed AND reserved_amount = 0 AND status = 'released')
    ),
  CONSTRAINT quota_usage_reservations_actual_amount
    CHECK (
      (
        status = 'committed'
        AND actual_amount IS NOT NULL
        -- Reservations are admission-control estimates. Provider-reported
        -- usage is the accounting source of truth and may exceed the grant.
        AND actual_amount > 0
      )
      OR
      (status <> 'committed' AND actual_amount IS NULL)
  ),
  CONSTRAINT quota_usage_reservations_reported_actual_amount
    CHECK (
      (reported_actual_amount IS NULL AND status IN ('reserved', 'released', 'attempted'))
      OR
      (
        reported_actual_amount IS NOT NULL
        AND reported_actual_amount > 0
        AND status IN ('attempted', 'committed')
      )
    ),
  CONSTRAINT quota_usage_reservations_committed_actual_match
    CHECK (status <> 'committed' OR reported_actual_amount = actual_amount),
  CONSTRAINT quota_usage_reservations_attempt_shape
    CHECK (
      (status IN ('attempted', 'committed') AND attempted_at IS NOT NULL)
      OR
      (status IN ('reserved', 'released') AND attempted_at IS NULL)
    ),
  CONSTRAINT quota_usage_reservations_final_shape
    CHECK (
      (status IN ('committed', 'released') AND finalized_at IS NOT NULL)
      OR
      (status IN ('reserved', 'attempted') AND finalized_at IS NULL)
    ),
  CONSTRAINT quota_usage_reservations_expiry
    CHECK (expires_at > created_at),
  CONSTRAINT quota_usage_reservations_reason_length
    CHECK (
      reason IS NULL
      OR (reason = btrim(reason) AND char_length(reason) BETWEEN 1 AND 512)
    ),
  CONSTRAINT quota_usage_reservations_release_reason
    CHECK (status <> 'released' OR reason IS NOT NULL),
  CONSTRAINT quota_usage_reservations_limits
    CHECK (
      (user_limit IS NULL OR user_limit >= 0)
      AND (guild_limit IS NULL OR guild_limit >= 0)
      AND (remaining_after_reserve IS NULL OR remaining_after_reserve >= 0)
    )
);

-- One index serves both guild and per-user active-capacity sums. Expiry gets a
-- separate narrow index for bounded reconciliation scans.
CREATE INDEX idx_quota_usage_reservations_active_scope
  ON public.quota_usage_reservations (guild_id, usage_date, resource, user_id)
  WHERE status IN ('reserved', 'attempted');

CREATE INDEX idx_quota_usage_reservations_expiry
  ON public.quota_usage_reservations (expires_at, idempotency_key)
  WHERE status IN ('reserved', 'attempted');

ALTER TABLE public.quota_usage_reservations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access to quota_usage_reservations"
  ON public.quota_usage_reservations
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

REVOKE ALL ON TABLE public.quota_usage_reservations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.quota_usage_reservations TO service_role;

-- These functions are invoker-rights by design. Reassert only the underlying
-- privileges they need so the service role behaves consistently on hosted
-- Supabase and the repository's plain-Postgres compatibility image.
GRANT SELECT, INSERT ON TABLE public.guild_quotas TO service_role;
GRANT SELECT ON TABLE public.role_tier_quotas TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.usage_tracking TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.guild_daily_usage TO service_role;

-- Lifecycle row shape:
-- idempotency_key, status, reserved_amount, actual_amount, usage_date, idempotent
CREATE OR REPLACE FUNCTION public.mark_quota_usage_attempted(
  p_idempotency_key TEXT
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
AS $mark_quota_usage_attempted$
DECLARE
  v_identity RECORD;
  v_reservation public.quota_usage_reservations%ROWTYPE;
BEGIN
  IF p_idempotency_key IS NULL
     OR p_idempotency_key IS DISTINCT FROM btrim(p_idempotency_key)
     OR char_length(btrim(p_idempotency_key)) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'idempotency key must be trimmed and contain between 1 and 255 characters'
      USING ERRCODE = '22023';
  END IF;

  SELECT r.guild_id, r.user_id, r.usage_date
  INTO v_identity
  FROM public.quota_usage_reservations r
  WHERE r.idempotency_key = p_idempotency_key;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'quota reservation not found'
      USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.guild_daily_usage (guild_id, usage_date)
  VALUES (v_identity.guild_id, v_identity.usage_date)
  ON CONFLICT ON CONSTRAINT guild_daily_usage_pkey DO NOTHING;

  INSERT INTO public.usage_tracking (guild_id, user_id, usage_date)
  VALUES (v_identity.guild_id, v_identity.user_id, v_identity.usage_date)
  ON CONFLICT ON CONSTRAINT usage_tracking_guild_id_user_id_usage_date_key DO NOTHING;

  -- Every lifecycle mutation locks the aggregate before the user row.
  PERFORM 1
  FROM public.guild_daily_usage gdu
  WHERE gdu.guild_id = v_identity.guild_id
    AND gdu.usage_date = v_identity.usage_date
  FOR UPDATE;

  PERFORM 1
  FROM public.usage_tracking ut
  WHERE ut.guild_id = v_identity.guild_id
    AND ut.user_id = v_identity.user_id
    AND ut.usage_date = v_identity.usage_date
  FOR UPDATE;

  SELECT r.*
  INTO v_reservation
  FROM public.quota_usage_reservations r
  WHERE r.idempotency_key = p_idempotency_key
  FOR UPDATE;

  IF v_reservation.status = 'attempted' THEN
    RETURN QUERY SELECT
      v_reservation.idempotency_key,
      v_reservation.status,
      v_reservation.reserved_amount,
      v_reservation.actual_amount,
      v_reservation.usage_date,
      TRUE;
    RETURN;
  END IF;

  IF v_reservation.status <> 'reserved' THEN
    RAISE EXCEPTION 'quota reservation cannot be attempted from status %', v_reservation.status
      USING ERRCODE = '55000';
  END IF;

  IF v_reservation.expires_at <= NOW() THEN
    UPDATE public.quota_usage_reservations r
    SET status = 'released',
        reason = 'expired_before_attempt',
        finalized_at = NOW(),
        updated_at = NOW()
    WHERE r.idempotency_key = p_idempotency_key
    RETURNING r.* INTO v_reservation;

    RETURN QUERY SELECT
      v_reservation.idempotency_key,
      v_reservation.status,
      v_reservation.reserved_amount,
      v_reservation.actual_amount,
      v_reservation.usage_date,
      FALSE;
    RETURN;
  END IF;

  UPDATE public.quota_usage_reservations r
  SET status = 'attempted',
      attempted_at = NOW(),
      -- Provider work may be long-running, especially video generation.
      expires_at = NOW() + INTERVAL '2 hours',
      updated_at = NOW()
  WHERE r.idempotency_key = p_idempotency_key
  RETURNING r.* INTO v_reservation;

  RETURN QUERY SELECT
    v_reservation.idempotency_key,
    v_reservation.status,
    v_reservation.reserved_amount,
    v_reservation.actual_amount,
    v_reservation.usage_date,
    FALSE;
END;
$mark_quota_usage_attempted$;

-- Persist the provider-reported amount before counter settlement. If the
-- subsequent commit is interrupted, the global reconciler retains the exact
-- amount rather than reverting to the admission estimate.
CREATE OR REPLACE FUNCTION public.record_quota_usage_actual(
  p_idempotency_key TEXT,
  p_actual_amount INTEGER
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $record_quota_usage_actual$
DECLARE
  v_reservation public.quota_usage_reservations%ROWTYPE;
BEGIN
  IF p_idempotency_key IS NULL
     OR p_idempotency_key IS DISTINCT FROM btrim(p_idempotency_key)
     OR char_length(btrim(p_idempotency_key)) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'idempotency key must be trimmed and contain between 1 and 255 characters'
      USING ERRCODE = '22023';
  END IF;
  IF p_actual_amount IS NULL OR p_actual_amount <= 0 THEN
    RAISE EXCEPTION 'actual amount must be a positive integer'
      USING ERRCODE = '22023';
  END IF;

  SELECT r.*
  INTO v_reservation
  FROM public.quota_usage_reservations r
  WHERE r.idempotency_key = p_idempotency_key
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quota reservation not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_reservation.status NOT IN ('attempted', 'committed') THEN
    RAISE EXCEPTION 'actual usage cannot be recorded from status %', v_reservation.status
      USING ERRCODE = '55000';
  END IF;
  IF v_reservation.reported_actual_amount IS NOT NULL
     AND v_reservation.reported_actual_amount IS DISTINCT FROM p_actual_amount THEN
    RAISE EXCEPTION 'idempotent actual usage does not match the stored amount'
      USING ERRCODE = '22023';
  END IF;
  IF v_reservation.status = 'committed'
     AND v_reservation.actual_amount IS DISTINCT FROM p_actual_amount THEN
    RAISE EXCEPTION 'reported actual usage does not match the committed amount'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.quota_usage_reservations r
  SET reported_actual_amount = p_actual_amount,
      updated_at = NOW()
  WHERE r.idempotency_key = p_idempotency_key;

  RETURN p_actual_amount;
END;
$record_quota_usage_actual$;

CREATE OR REPLACE FUNCTION public.commit_quota_usage(
  p_idempotency_key TEXT,
  p_actual_amount INTEGER
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
AS $commit_quota_usage$
DECLARE
  v_identity RECORD;
  v_reservation public.quota_usage_reservations%ROWTYPE;
  v_user_current BIGINT;
  v_guild_current BIGINT;
  v_user_request_count BIGINT;
BEGIN
  IF p_idempotency_key IS NULL
     OR p_idempotency_key IS DISTINCT FROM btrim(p_idempotency_key)
     OR char_length(btrim(p_idempotency_key)) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'idempotency key must be trimmed and contain between 1 and 255 characters'
      USING ERRCODE = '22023';
  END IF;

  IF p_actual_amount IS NULL OR p_actual_amount <= 0 THEN
    RAISE EXCEPTION 'actual amount must be a positive integer'
      USING ERRCODE = '22023';
  END IF;

  SELECT r.guild_id, r.user_id, r.usage_date
  INTO v_identity
  FROM public.quota_usage_reservations r
  WHERE r.idempotency_key = p_idempotency_key;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'quota reservation not found'
      USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.guild_daily_usage (guild_id, usage_date)
  VALUES (v_identity.guild_id, v_identity.usage_date)
  ON CONFLICT ON CONSTRAINT guild_daily_usage_pkey DO NOTHING;

  INSERT INTO public.usage_tracking (guild_id, user_id, usage_date)
  VALUES (v_identity.guild_id, v_identity.user_id, v_identity.usage_date)
  ON CONFLICT ON CONSTRAINT usage_tracking_guild_id_user_id_usage_date_key DO NOTHING;

  PERFORM 1
  FROM public.guild_daily_usage gdu
  WHERE gdu.guild_id = v_identity.guild_id
    AND gdu.usage_date = v_identity.usage_date
  FOR UPDATE;

  PERFORM 1
  FROM public.usage_tracking ut
  WHERE ut.guild_id = v_identity.guild_id
    AND ut.user_id = v_identity.user_id
    AND ut.usage_date = v_identity.usage_date
  FOR UPDATE;

  SELECT r.*
  INTO v_reservation
  FROM public.quota_usage_reservations r
  WHERE r.idempotency_key = p_idempotency_key
  FOR UPDATE;

  IF v_reservation.status = 'committed' THEN
    IF v_reservation.actual_amount IS DISTINCT FROM p_actual_amount THEN
      RAISE EXCEPTION 'idempotent commit amount does not match the committed amount'
        USING ERRCODE = '22023';
    END IF;

    RETURN QUERY SELECT
      v_reservation.idempotency_key,
      v_reservation.status,
      v_reservation.reserved_amount,
      v_reservation.actual_amount,
      v_reservation.usage_date,
      TRUE;
    RETURN;
  END IF;

  IF v_reservation.status <> 'attempted' THEN
    RAISE EXCEPTION 'quota reservation cannot be committed from status %', v_reservation.status
      USING ERRCODE = '55000';
  END IF;

  IF v_reservation.reported_actual_amount IS NOT NULL
     AND v_reservation.reported_actual_amount IS DISTINCT FROM p_actual_amount THEN
    RAISE EXCEPTION 'commit amount does not match provider-reported actual usage'
      USING ERRCODE = '22023';
  END IF;

  -- The reservation controls admission, but settlement must record the exact
  -- provider amount even when the estimate was low. Check the locked target
  -- counters before either update so an integer overflow leaves the whole
  -- transaction, including the reservation state, untouched.
  SELECT
    CASE v_reservation.resource
      WHEN 'text_tokens' THEN COALESCE(ut.text_tokens_used, 0)
      WHEN 'images' THEN COALESCE(ut.images_used, 0)
      WHEN 'voice_minutes' THEN COALESCE(ut.voice_minutes_used, 0)
      WHEN 'vision_tokens' THEN COALESCE(ut.vision_tokens_used, 0)
      WHEN 'video_tokens' THEN COALESCE(ut.video_tokens_used, 0)
    END,
    CASE v_reservation.resource
      WHEN 'text_tokens' THEN COALESCE(ut.text_requests, 0)
      WHEN 'images' THEN COALESCE(ut.image_requests, 0)
      WHEN 'voice_minutes' THEN COALESCE(ut.voice_requests, 0)
      WHEN 'vision_tokens' THEN COALESCE(ut.vision_requests, 0)
      WHEN 'video_tokens' THEN COALESCE(ut.video_requests, 0)
    END
  INTO v_user_current, v_user_request_count
  FROM public.usage_tracking ut
  WHERE ut.guild_id = v_reservation.guild_id
    AND ut.user_id = v_reservation.user_id
    AND ut.usage_date = v_reservation.usage_date;

  SELECT CASE v_reservation.resource
    WHEN 'text_tokens' THEN COALESCE(gdu.total_text_tokens, 0)
    WHEN 'images' THEN COALESCE(gdu.total_images, 0)
    WHEN 'voice_minutes' THEN COALESCE(gdu.total_voice_minutes, 0)
    WHEN 'vision_tokens' THEN COALESCE(gdu.total_vision_tokens, 0)
    WHEN 'video_tokens' THEN COALESCE(gdu.total_video_tokens, 0)
  END
  INTO v_guild_current
  FROM public.guild_daily_usage gdu
  WHERE gdu.guild_id = v_reservation.guild_id
    AND gdu.usage_date = v_reservation.usage_date;

  IF v_user_current > 2147483647::BIGINT - p_actual_amount::BIGINT
     OR v_user_request_count >= 2147483647::BIGINT
     OR (
       v_reservation.resource IN ('text_tokens', 'images', 'voice_minutes')
       AND v_guild_current > 2147483647::BIGINT - p_actual_amount::BIGINT
     )
     OR (
       v_reservation.resource IN ('vision_tokens', 'video_tokens')
       AND v_guild_current > 9223372036854775807::BIGINT - p_actual_amount::BIGINT
     ) THEN
    RAISE EXCEPTION 'quota counter overflow while committing exact provider usage'
      USING ERRCODE = '22003';
  END IF;

  UPDATE public.usage_tracking ut
  SET text_tokens_used = COALESCE(ut.text_tokens_used, 0)
        + CASE WHEN v_reservation.resource = 'text_tokens' THEN p_actual_amount ELSE 0 END,
      images_used = COALESCE(ut.images_used, 0)
        + CASE WHEN v_reservation.resource = 'images' THEN p_actual_amount ELSE 0 END,
      voice_minutes_used = COALESCE(ut.voice_minutes_used, 0)
        + CASE WHEN v_reservation.resource = 'voice_minutes' THEN p_actual_amount ELSE 0 END,
      vision_tokens_used = COALESCE(ut.vision_tokens_used, 0)
        + CASE WHEN v_reservation.resource = 'vision_tokens' THEN p_actual_amount ELSE 0 END,
      video_tokens_used = COALESCE(ut.video_tokens_used, 0)
        + CASE WHEN v_reservation.resource = 'video_tokens' THEN p_actual_amount ELSE 0 END,
      text_requests = COALESCE(ut.text_requests, 0)
        + CASE WHEN v_reservation.resource = 'text_tokens' THEN 1 ELSE 0 END,
      image_requests = COALESCE(ut.image_requests, 0)
        + CASE WHEN v_reservation.resource = 'images' THEN 1 ELSE 0 END,
      voice_requests = COALESCE(ut.voice_requests, 0)
        + CASE WHEN v_reservation.resource = 'voice_minutes' THEN 1 ELSE 0 END,
      vision_requests = COALESCE(ut.vision_requests, 0)
        + CASE WHEN v_reservation.resource = 'vision_tokens' THEN 1 ELSE 0 END,
      video_requests = COALESCE(ut.video_requests, 0)
        + CASE WHEN v_reservation.resource = 'video_tokens' THEN 1 ELSE 0 END,
      updated_at = NOW()
  WHERE ut.guild_id = v_reservation.guild_id
    AND ut.user_id = v_reservation.user_id
    AND ut.usage_date = v_reservation.usage_date;

  UPDATE public.guild_daily_usage gdu
  SET total_text_tokens = COALESCE(gdu.total_text_tokens, 0)
        + CASE WHEN v_reservation.resource = 'text_tokens' THEN p_actual_amount ELSE 0 END,
      total_images = COALESCE(gdu.total_images, 0)
        + CASE WHEN v_reservation.resource = 'images' THEN p_actual_amount ELSE 0 END,
      total_voice_minutes = COALESCE(gdu.total_voice_minutes, 0)
        + CASE WHEN v_reservation.resource = 'voice_minutes' THEN p_actual_amount ELSE 0 END,
      total_vision_tokens = COALESCE(gdu.total_vision_tokens, 0)
        + CASE WHEN v_reservation.resource = 'vision_tokens' THEN p_actual_amount ELSE 0 END,
      total_video_tokens = COALESCE(gdu.total_video_tokens, 0)
        + CASE WHEN v_reservation.resource = 'video_tokens' THEN p_actual_amount ELSE 0 END,
      updated_at = NOW()
  WHERE gdu.guild_id = v_reservation.guild_id
    AND gdu.usage_date = v_reservation.usage_date;

  UPDATE public.quota_usage_reservations r
  SET status = 'committed',
      reported_actual_amount = p_actual_amount,
      actual_amount = p_actual_amount,
      finalized_at = NOW(),
      updated_at = NOW()
  WHERE r.idempotency_key = p_idempotency_key
  RETURNING r.* INTO v_reservation;

  RETURN QUERY SELECT
    v_reservation.idempotency_key,
    v_reservation.status,
    v_reservation.reserved_amount,
    v_reservation.actual_amount,
    v_reservation.usage_date,
    FALSE;
END;
$commit_quota_usage$;

CREATE OR REPLACE FUNCTION public.release_quota_usage(
  p_idempotency_key TEXT,
  p_reason TEXT
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
AS $release_quota_usage$
DECLARE
  v_identity RECORD;
  v_reservation public.quota_usage_reservations%ROWTYPE;
  v_reason TEXT;
BEGIN
  IF p_idempotency_key IS NULL
     OR p_idempotency_key IS DISTINCT FROM btrim(p_idempotency_key)
     OR char_length(btrim(p_idempotency_key)) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'idempotency key must be trimmed and contain between 1 and 255 characters'
      USING ERRCODE = '22023';
  END IF;

  v_reason := btrim(p_reason);
  IF v_reason IS NULL OR char_length(v_reason) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'release reason must contain between 1 and 512 characters'
      USING ERRCODE = '22023';
  END IF;

  SELECT r.guild_id, r.user_id, r.usage_date
  INTO v_identity
  FROM public.quota_usage_reservations r
  WHERE r.idempotency_key = p_idempotency_key;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'quota reservation not found'
      USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.guild_daily_usage (guild_id, usage_date)
  VALUES (v_identity.guild_id, v_identity.usage_date)
  ON CONFLICT ON CONSTRAINT guild_daily_usage_pkey DO NOTHING;

  INSERT INTO public.usage_tracking (guild_id, user_id, usage_date)
  VALUES (v_identity.guild_id, v_identity.user_id, v_identity.usage_date)
  ON CONFLICT ON CONSTRAINT usage_tracking_guild_id_user_id_usage_date_key DO NOTHING;

  PERFORM 1
  FROM public.guild_daily_usage gdu
  WHERE gdu.guild_id = v_identity.guild_id
    AND gdu.usage_date = v_identity.usage_date
  FOR UPDATE;

  PERFORM 1
  FROM public.usage_tracking ut
  WHERE ut.guild_id = v_identity.guild_id
    AND ut.user_id = v_identity.user_id
    AND ut.usage_date = v_identity.usage_date
  FOR UPDATE;

  SELECT r.*
  INTO v_reservation
  FROM public.quota_usage_reservations r
  WHERE r.idempotency_key = p_idempotency_key
  FOR UPDATE;

  IF v_reservation.status = 'released' THEN
    IF v_reservation.reason IS DISTINCT FROM v_reason THEN
      RAISE EXCEPTION 'idempotent release reason does not match the stored reason'
        USING ERRCODE = '22023';
    END IF;

    RETURN QUERY SELECT
      v_reservation.idempotency_key,
      v_reservation.status,
      v_reservation.reserved_amount,
      v_reservation.actual_amount,
      v_reservation.usage_date,
      TRUE;
    RETURN;
  END IF;

  IF v_reservation.status <> 'reserved' THEN
    RAISE EXCEPTION 'quota reservation cannot be released from status %', v_reservation.status
      USING ERRCODE = '55000';
  END IF;

  UPDATE public.quota_usage_reservations r
  SET status = 'released',
      reason = v_reason,
      finalized_at = NOW(),
      updated_at = NOW()
  WHERE r.idempotency_key = p_idempotency_key
  RETURNING r.* INTO v_reservation;

  RETURN QUERY SELECT
    v_reservation.idempotency_key,
    v_reservation.status,
    v_reservation.reserved_amount,
    v_reservation.actual_amount,
    v_reservation.usage_date,
    FALSE;
END;
$release_quota_usage$;

-- Settle a bounded expired batch for one locked capacity scope. Expired work
-- that never reached provider I/O is released. Expired attempted work is
-- conservatively charged at the reserved amount.
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

-- Reserve row shape:
-- idempotency_key, status, allowed, reason, requested_amount,
-- reserved_amount, remaining, user_limit, guild_limit, usage_date, quota_exempt
CREATE OR REPLACE FUNCTION public.reserve_quota_usage(
  p_idempotency_key TEXT,
  p_guild_id TEXT,
  p_user_id TEXT,
  p_role_tier TEXT,
  p_resource TEXT,
  p_requested_amount INTEGER,
  p_minimum_amount INTEGER
) RETURNS TABLE(
  idempotency_key TEXT,
  status TEXT,
  allowed BOOLEAN,
  reason TEXT,
  requested_amount INTEGER,
  reserved_amount INTEGER,
  remaining INTEGER,
  user_limit INTEGER,
  guild_limit INTEGER,
  usage_date DATE,
  quota_exempt BOOLEAN
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $reserve_quota_usage$
DECLARE
  v_usage_date DATE;
  v_quota_exempt BOOLEAN := FALSE;
  v_user_limit INTEGER;
  v_guild_limit INTEGER;
  v_user_current BIGINT := 0;
  v_guild_current BIGINT := 0;
  v_user_active BIGINT := 0;
  v_guild_active BIGINT := 0;
  v_available BIGINT := 0;
  v_reserved_amount INTEGER := 0;
  v_allowed BOOLEAN := FALSE;
  v_reason TEXT;
  v_reservation public.quota_usage_reservations%ROWTYPE;
BEGIN
  IF p_idempotency_key IS NULL
     OR p_idempotency_key IS DISTINCT FROM btrim(p_idempotency_key)
     OR char_length(p_idempotency_key) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'idempotency key must be trimmed and contain between 1 and 255 characters'
      USING ERRCODE = '22023';
  END IF;

  IF p_guild_id IS NULL
     OR p_guild_id IS DISTINCT FROM btrim(p_guild_id)
     OR char_length(p_guild_id) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'guild id must be trimmed and contain between 1 and 128 characters'
      USING ERRCODE = '22023';
  END IF;

  IF p_user_id IS NULL
     OR p_user_id IS DISTINCT FROM btrim(p_user_id)
     OR char_length(p_user_id) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'user id must be trimmed and contain between 1 and 128 characters'
      USING ERRCODE = '22023';
  END IF;

  IF p_role_tier IS NULL OR p_role_tier NOT IN (
    'admin', 'moderator', 'trusted', 'member', 'restricted'
  ) THEN
    RAISE EXCEPTION 'unsupported role tier'
      USING ERRCODE = '22023';
  END IF;

  IF p_resource IS NULL OR p_resource NOT IN (
    'text_tokens', 'images', 'voice_minutes', 'vision_tokens', 'video_tokens'
  ) THEN
    RAISE EXCEPTION 'unsupported quota resource'
      USING ERRCODE = '22023';
  END IF;

  IF p_requested_amount IS NULL OR p_requested_amount <= 0 THEN
    RAISE EXCEPTION 'requested amount must be a positive integer'
      USING ERRCODE = '22023';
  END IF;

  IF p_minimum_amount IS NULL
     OR p_minimum_amount <= 0
     OR p_minimum_amount > p_requested_amount THEN
    RAISE EXCEPTION 'minimum amount must be positive and no greater than requested amount'
      USING ERRCODE = '22023';
  END IF;

  IF p_resource IN ('images', 'video_tokens')
     AND p_minimum_amount <> p_requested_amount THEN
    RAISE EXCEPTION 'image and video quota reservations require an exact grant'
      USING ERRCODE = '22023';
  END IF;

  -- Serialize one logical operation before taking a capacity lock. This makes
  -- a globally reused key deterministic even when callers supply different
  -- guilds, rather than leaking a primary-key race as a unique violation.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('silo:quota-reservation:' || p_idempotency_key, 0)
  );

  -- This value is fixed for the full lifecycle, including commits after the ET
  -- day boundary.
  v_usage_date := public.quota_local_date();

  -- Materialize the guild row so column defaults, rather than duplicated
  -- application constants, own the guild limits.
  INSERT INTO public.guild_quotas (guild_id)
  VALUES (p_guild_id)
  ON CONFLICT ON CONSTRAINT guild_quotas_pkey DO NOTHING;

  INSERT INTO public.guild_daily_usage (guild_id, usage_date)
  VALUES (p_guild_id, v_usage_date)
  ON CONFLICT ON CONSTRAINT guild_daily_usage_pkey DO NOTHING;

  -- Guild first. This serializes guild capacity across different users.
  PERFORM 1
  FROM public.guild_daily_usage gdu
  WHERE gdu.guild_id = p_guild_id
    AND gdu.usage_date = v_usage_date
  FOR UPDATE;

  -- Lazily clear dead capacity for self-hosted deployments that do not run a
  -- global scheduler. Attempted expiry is charged, never released.
  PERFORM public.settle_expired_quota_reservations_scope(
    p_guild_id,
    v_usage_date,
    p_resource,
    1000
  );

  INSERT INTO public.usage_tracking (guild_id, user_id, usage_date)
  VALUES (p_guild_id, p_user_id, v_usage_date)
  ON CONFLICT ON CONSTRAINT usage_tracking_guild_id_user_id_usage_date_key DO NOTHING;

  -- User second, consistently with every lifecycle mutation.
  PERFORM 1
  FROM public.usage_tracking ut
  WHERE ut.guild_id = p_guild_id
    AND ut.user_id = p_user_id
    AND ut.usage_date = v_usage_date
  FOR UPDATE;

  -- Re-check under the capacity locks so concurrent duplicate calls are
  -- parameter-matched and never create a second lease.
  SELECT r.*
  INTO v_reservation
  FROM public.quota_usage_reservations r
  WHERE r.idempotency_key = p_idempotency_key
  FOR UPDATE;

  IF FOUND THEN
    IF v_reservation.guild_id IS DISTINCT FROM p_guild_id
       OR v_reservation.user_id IS DISTINCT FROM p_user_id
       OR v_reservation.role_tier IS DISTINCT FROM p_role_tier
       OR v_reservation.resource IS DISTINCT FROM p_resource
       OR v_reservation.requested_amount IS DISTINCT FROM p_requested_amount
       OR v_reservation.minimum_amount IS DISTINCT FROM p_minimum_amount THEN
      RAISE EXCEPTION 'idempotency key parameters do not match the existing reservation'
        USING ERRCODE = '22023';
    END IF;

    RETURN QUERY SELECT
      v_reservation.idempotency_key,
      v_reservation.status,
      FALSE,
      'idempotency_key_already_' || v_reservation.status,
      v_reservation.requested_amount,
      v_reservation.reserved_amount,
      v_reservation.remaining_after_reserve,
      v_reservation.user_limit,
      v_reservation.guild_limit,
      v_reservation.usage_date,
      v_reservation.quota_exempt;
    RETURN;
  END IF;

  SELECT
    COALESCE(gq.quota_exempt, FALSE),
    CASE p_resource
      WHEN 'text_tokens' THEN gq.daily_text_tokens
      WHEN 'images' THEN gq.daily_images
      WHEN 'voice_minutes' THEN gq.daily_voice_minutes
      WHEN 'vision_tokens' THEN gq.daily_vision_tokens
      WHEN 'video_tokens' THEN gq.daily_video_tokens
    END
  INTO v_quota_exempt, v_guild_limit
  FROM public.guild_quotas gq
  WHERE gq.guild_id = p_guild_id;

  SELECT CASE p_resource
    WHEN 'text_tokens' THEN rtq.text_tokens
    WHEN 'images' THEN rtq.images
    WHEN 'voice_minutes' THEN rtq.voice_minutes
    WHEN 'vision_tokens' THEN rtq.vision_tokens
    WHEN 'video_tokens' THEN rtq.video_tokens
  END
  INTO v_user_limit
  FROM public.role_tier_quotas rtq
  WHERE rtq.role_tier = p_role_tier
    AND (rtq.guild_id = p_guild_id OR rtq.guild_id IS NULL)
  ORDER BY
    CASE WHEN rtq.guild_id = p_guild_id THEN 0 ELSE 1 END,
    rtq.updated_at DESC NULLS LAST,
    rtq.created_at DESC NULLS LAST
  LIMIT 1;

  IF v_quota_exempt THEN
    v_allowed := TRUE;
    v_reserved_amount := p_requested_amount;
    v_available := 0;
  ELSIF v_user_limit IS NULL
        OR v_guild_limit IS NULL
        OR v_user_limit < 0
        OR v_guild_limit < 0 THEN
    v_allowed := FALSE;
    v_reserved_amount := 0;
    v_available := 0;
    v_reason := 'quota_configuration_unavailable';
  ELSE
    SELECT CASE p_resource
      WHEN 'text_tokens' THEN COALESCE(ut.text_tokens_used, 0)
      WHEN 'images' THEN COALESCE(ut.images_used, 0)
      WHEN 'voice_minutes' THEN COALESCE(ut.voice_minutes_used, 0)
      WHEN 'vision_tokens' THEN COALESCE(ut.vision_tokens_used, 0)
      WHEN 'video_tokens' THEN COALESCE(ut.video_tokens_used, 0)
    END
    INTO v_user_current
    FROM public.usage_tracking ut
    WHERE ut.guild_id = p_guild_id
      AND ut.user_id = p_user_id
      AND ut.usage_date = v_usage_date;

    SELECT CASE p_resource
      WHEN 'text_tokens' THEN COALESCE(gdu.total_text_tokens, 0)
      WHEN 'images' THEN COALESCE(gdu.total_images, 0)
      WHEN 'voice_minutes' THEN COALESCE(gdu.total_voice_minutes, 0)
      WHEN 'vision_tokens' THEN COALESCE(gdu.total_vision_tokens, 0)
      WHEN 'video_tokens' THEN COALESCE(gdu.total_video_tokens, 0)
    END
    INTO v_guild_current
    FROM public.guild_daily_usage gdu
    WHERE gdu.guild_id = p_guild_id
      AND gdu.usage_date = v_usage_date;

    SELECT COALESCE(SUM(r.reserved_amount), 0)
    INTO v_user_active
    FROM public.quota_usage_reservations r
    WHERE r.guild_id = p_guild_id
      AND r.user_id = p_user_id
      AND r.usage_date = v_usage_date
      AND r.resource = p_resource
      AND (
        r.status = 'attempted'
        OR (r.status = 'reserved' AND r.expires_at > NOW())
      );

    SELECT COALESCE(SUM(r.reserved_amount), 0)
    INTO v_guild_active
    FROM public.quota_usage_reservations r
    WHERE r.guild_id = p_guild_id
      AND r.usage_date = v_usage_date
      AND r.resource = p_resource
      AND (
        r.status = 'attempted'
        OR (r.status = 'reserved' AND r.expires_at > NOW())
      );

    v_available := GREATEST(
      0,
      LEAST(
        v_user_limit::BIGINT - v_user_current - v_user_active,
        v_guild_limit::BIGINT - v_guild_current - v_guild_active
      )
    );
    v_reserved_amount := LEAST(p_requested_amount::BIGINT, v_available)::INTEGER;
    v_allowed := v_reserved_amount >= p_minimum_amount;

    IF NOT v_allowed THEN
      v_reserved_amount := 0;
      v_reason := 'insufficient_quota';
    END IF;
  END IF;

  INSERT INTO public.quota_usage_reservations (
    idempotency_key,
    guild_id,
    user_id,
    usage_date,
    role_tier,
    resource,
    requested_amount,
    minimum_amount,
    reserved_amount,
    remaining_after_reserve,
    user_limit,
    guild_limit,
    quota_exempt,
    allowed,
    status,
    reason,
    expires_at,
    finalized_at
  ) VALUES (
    p_idempotency_key,
    p_guild_id,
    p_user_id,
    v_usage_date,
    p_role_tier,
    p_resource,
    p_requested_amount,
    p_minimum_amount,
    v_reserved_amount,
    CASE
      WHEN v_quota_exempt THEN NULL
      WHEN v_allowed THEN (v_available - v_reserved_amount)::INTEGER
      ELSE v_available::INTEGER
    END,
    v_user_limit,
    v_guild_limit,
    v_quota_exempt,
    v_allowed,
    CASE WHEN v_allowed THEN 'reserved' ELSE 'released' END,
    v_reason,
    NOW() + INTERVAL '15 minutes',
    CASE WHEN v_allowed THEN NULL ELSE NOW() END
  )
  RETURNING * INTO v_reservation;

  RETURN QUERY SELECT
    v_reservation.idempotency_key,
    v_reservation.status,
    v_reservation.allowed,
    v_reservation.reason,
    v_reservation.requested_amount,
    v_reservation.reserved_amount,
    v_reservation.remaining_after_reserve,
    v_reservation.user_limit,
    v_reservation.guild_limit,
    v_reservation.usage_date,
    v_reservation.quota_exempt;
END;
$reserve_quota_usage$;

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

  FOR v_candidate IN
    SELECT r.idempotency_key, r.status, r.reserved_amount, r.reported_actual_amount
    FROM public.quota_usage_reservations r
    WHERE r.status IN ('reserved', 'attempted')
      AND r.expires_at <= NOW()
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

-- Compatibility for callers not yet migrated to reservation leases. The
-- legacy signature is retained, but its write now shares the guild-then-user
-- mutex, includes active reservations in capacity, and enforces the current
-- database-owned guild limit. New code must use reserve/attempt/commit/release.
CREATE OR REPLACE FUNCTION public.increment_usage_atomic(
  p_guild_id TEXT,
  p_user_id TEXT,
  p_resource TEXT,
  p_amount INTEGER,
  p_user_limit INTEGER
) RETURNS TABLE(
  success BOOLEAN,
  new_total INTEGER,
  remaining INTEGER
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $increment_usage_atomic$
DECLARE
  v_usage_date DATE;
  v_quota_exempt BOOLEAN := FALSE;
  v_guild_limit INTEGER;
  v_user_current BIGINT := 0;
  v_guild_current BIGINT := 0;
  v_user_active BIGINT := 0;
  v_guild_active BIGINT := 0;
  v_new_total INTEGER;
  v_remaining INTEGER;
BEGIN
  IF p_guild_id IS NULL
     OR p_guild_id IS DISTINCT FROM btrim(p_guild_id)
     OR char_length(p_guild_id) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'guild id must be trimmed and contain between 1 and 128 characters'
      USING ERRCODE = '22023';
  END IF;

  IF p_user_id IS NULL
     OR p_user_id IS DISTINCT FROM btrim(p_user_id)
     OR char_length(p_user_id) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'user id must be trimmed and contain between 1 and 128 characters'
      USING ERRCODE = '22023';
  END IF;

  IF p_resource IS NULL OR p_resource NOT IN (
    'text_tokens', 'images', 'voice_minutes', 'vision_tokens', 'video_tokens'
  ) THEN
    RAISE EXCEPTION 'unsupported quota resource'
      USING ERRCODE = '22023';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'usage amount must be a positive integer'
      USING ERRCODE = '22023';
  END IF;

  IF p_user_limit IS NULL OR p_user_limit < 0 THEN
    RAISE EXCEPTION 'user limit must be a nonnegative integer'
      USING ERRCODE = '22023';
  END IF;

  v_usage_date := public.quota_local_date();

  INSERT INTO public.guild_quotas (guild_id)
  VALUES (p_guild_id)
  ON CONFLICT ON CONSTRAINT guild_quotas_pkey DO NOTHING;

  INSERT INTO public.guild_daily_usage (guild_id, usage_date)
  VALUES (p_guild_id, v_usage_date)
  ON CONFLICT ON CONSTRAINT guild_daily_usage_pkey DO NOTHING;

  PERFORM 1
  FROM public.guild_daily_usage gdu
  WHERE gdu.guild_id = p_guild_id
    AND gdu.usage_date = v_usage_date
  FOR UPDATE;

  PERFORM public.settle_expired_quota_reservations_scope(
    p_guild_id,
    v_usage_date,
    p_resource,
    1000
  );

  INSERT INTO public.usage_tracking (guild_id, user_id, usage_date)
  VALUES (p_guild_id, p_user_id, v_usage_date)
  ON CONFLICT ON CONSTRAINT usage_tracking_guild_id_user_id_usage_date_key DO NOTHING;

  PERFORM 1
  FROM public.usage_tracking ut
  WHERE ut.guild_id = p_guild_id
    AND ut.user_id = p_user_id
    AND ut.usage_date = v_usage_date
  FOR UPDATE;

  SELECT
    COALESCE(gq.quota_exempt, FALSE),
    CASE p_resource
      WHEN 'text_tokens' THEN gq.daily_text_tokens
      WHEN 'images' THEN gq.daily_images
      WHEN 'voice_minutes' THEN gq.daily_voice_minutes
      WHEN 'vision_tokens' THEN gq.daily_vision_tokens
      WHEN 'video_tokens' THEN gq.daily_video_tokens
    END
  INTO v_quota_exempt, v_guild_limit
  FROM public.guild_quotas gq
  WHERE gq.guild_id = p_guild_id;

  SELECT CASE p_resource
    WHEN 'text_tokens' THEN COALESCE(ut.text_tokens_used, 0)
    WHEN 'images' THEN COALESCE(ut.images_used, 0)
    WHEN 'voice_minutes' THEN COALESCE(ut.voice_minutes_used, 0)
    WHEN 'vision_tokens' THEN COALESCE(ut.vision_tokens_used, 0)
    WHEN 'video_tokens' THEN COALESCE(ut.video_tokens_used, 0)
  END
  INTO v_user_current
  FROM public.usage_tracking ut
  WHERE ut.guild_id = p_guild_id
    AND ut.user_id = p_user_id
    AND ut.usage_date = v_usage_date;

  SELECT CASE p_resource
    WHEN 'text_tokens' THEN COALESCE(gdu.total_text_tokens, 0)
    WHEN 'images' THEN COALESCE(gdu.total_images, 0)
    WHEN 'voice_minutes' THEN COALESCE(gdu.total_voice_minutes, 0)
    WHEN 'vision_tokens' THEN COALESCE(gdu.total_vision_tokens, 0)
    WHEN 'video_tokens' THEN COALESCE(gdu.total_video_tokens, 0)
  END
  INTO v_guild_current
  FROM public.guild_daily_usage gdu
  WHERE gdu.guild_id = p_guild_id
    AND gdu.usage_date = v_usage_date;

  SELECT COALESCE(SUM(r.reserved_amount), 0)
  INTO v_user_active
  FROM public.quota_usage_reservations r
  WHERE r.guild_id = p_guild_id
    AND r.user_id = p_user_id
    AND r.usage_date = v_usage_date
    AND r.resource = p_resource
    AND (
      r.status = 'attempted'
      OR (r.status = 'reserved' AND r.expires_at > NOW())
    );

  SELECT COALESCE(SUM(r.reserved_amount), 0)
  INTO v_guild_active
  FROM public.quota_usage_reservations r
  WHERE r.guild_id = p_guild_id
    AND r.usage_date = v_usage_date
    AND r.resource = p_resource
    AND (
      r.status = 'attempted'
      OR (r.status = 'reserved' AND r.expires_at > NOW())
    );

  v_remaining := GREATEST(
    0,
    p_user_limit::BIGINT - v_user_current - v_user_active
  )::INTEGER;

  IF v_user_current + v_user_active + p_amount > p_user_limit
     OR (
       NOT v_quota_exempt
       AND (
         v_guild_limit IS NULL
         OR v_guild_limit < 0
         OR v_guild_current + v_guild_active + p_amount > v_guild_limit
       )
     ) THEN
    RETURN QUERY SELECT FALSE, v_user_current::INTEGER, v_remaining;
    RETURN;
  END IF;

  UPDATE public.usage_tracking ut
  SET text_tokens_used = COALESCE(ut.text_tokens_used, 0)
        + CASE WHEN p_resource = 'text_tokens' THEN p_amount ELSE 0 END,
      images_used = COALESCE(ut.images_used, 0)
        + CASE WHEN p_resource = 'images' THEN p_amount ELSE 0 END,
      voice_minutes_used = COALESCE(ut.voice_minutes_used, 0)
        + CASE WHEN p_resource = 'voice_minutes' THEN p_amount ELSE 0 END,
      vision_tokens_used = COALESCE(ut.vision_tokens_used, 0)
        + CASE WHEN p_resource = 'vision_tokens' THEN p_amount ELSE 0 END,
      video_tokens_used = COALESCE(ut.video_tokens_used, 0)
        + CASE WHEN p_resource = 'video_tokens' THEN p_amount ELSE 0 END,
      text_requests = COALESCE(ut.text_requests, 0)
        + CASE WHEN p_resource = 'text_tokens' THEN 1 ELSE 0 END,
      image_requests = COALESCE(ut.image_requests, 0)
        + CASE WHEN p_resource = 'images' THEN 1 ELSE 0 END,
      voice_requests = COALESCE(ut.voice_requests, 0)
        + CASE WHEN p_resource = 'voice_minutes' THEN 1 ELSE 0 END,
      vision_requests = COALESCE(ut.vision_requests, 0)
        + CASE WHEN p_resource = 'vision_tokens' THEN 1 ELSE 0 END,
      video_requests = COALESCE(ut.video_requests, 0)
        + CASE WHEN p_resource = 'video_tokens' THEN 1 ELSE 0 END,
      updated_at = NOW()
  WHERE ut.guild_id = p_guild_id
    AND ut.user_id = p_user_id
    AND ut.usage_date = v_usage_date
  RETURNING CASE p_resource
    WHEN 'text_tokens' THEN ut.text_tokens_used
    WHEN 'images' THEN ut.images_used
    WHEN 'voice_minutes' THEN ut.voice_minutes_used
    WHEN 'vision_tokens' THEN ut.vision_tokens_used
    WHEN 'video_tokens' THEN ut.video_tokens_used
  END
  INTO v_new_total;

  UPDATE public.guild_daily_usage gdu
  SET total_text_tokens = COALESCE(gdu.total_text_tokens, 0)
        + CASE WHEN p_resource = 'text_tokens' THEN p_amount ELSE 0 END,
      total_images = COALESCE(gdu.total_images, 0)
        + CASE WHEN p_resource = 'images' THEN p_amount ELSE 0 END,
      total_voice_minutes = COALESCE(gdu.total_voice_minutes, 0)
        + CASE WHEN p_resource = 'voice_minutes' THEN p_amount ELSE 0 END,
      total_vision_tokens = COALESCE(gdu.total_vision_tokens, 0)
        + CASE WHEN p_resource = 'vision_tokens' THEN p_amount ELSE 0 END,
      total_video_tokens = COALESCE(gdu.total_video_tokens, 0)
        + CASE WHEN p_resource = 'video_tokens' THEN p_amount ELSE 0 END,
      updated_at = NOW()
  WHERE gdu.guild_id = p_guild_id
    AND gdu.usage_date = v_usage_date;

  v_remaining := GREATEST(0, p_user_limit - v_new_total);
  RETURN QUERY SELECT TRUE, v_new_total, v_remaining;
END;
$increment_usage_atomic$;

COMMENT ON TABLE public.quota_usage_reservations IS
  'Durable idempotent leases for quota capacity across external provider work';
COMMENT ON FUNCTION public.reserve_quota_usage(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER) IS
  'Atomically reserves user and guild quota capacity using database-owned limits';
COMMENT ON FUNCTION public.mark_quota_usage_attempted(TEXT) IS
  'Marks a reservation immediately before external provider I/O';
COMMENT ON FUNCTION public.record_quota_usage_actual(TEXT, INTEGER) IS
  'Durably records exact provider usage before counter settlement';
COMMENT ON FUNCTION public.commit_quota_usage(TEXT, INTEGER) IS
  'Idempotently commits actual provider usage against a prior attempted reservation';
COMMENT ON FUNCTION public.release_quota_usage(TEXT, TEXT) IS
  'Idempotently releases a reservation only before provider I/O begins';
COMMENT ON FUNCTION public.reconcile_expired_quota_reservations(INTEGER) IS
  'Releases expired unattempted reservations and conservatively commits expired attempted work';

-- Public-schema functions are executable by PUBLIC by default. Keep these
-- internal invoker functions available only to the backend role.
REVOKE EXECUTE ON FUNCTION public.reserve_quota_usage(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.mark_quota_usage_attempted(TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.record_quota_usage_actual(TEXT, INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.commit_quota_usage(TEXT, INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.release_quota_usage(TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.settle_expired_quota_reservations_scope(TEXT, DATE, TEXT, INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reconcile_expired_quota_reservations(INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.increment_usage_atomic(TEXT, TEXT, TEXT, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.reserve_quota_usage(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_quota_usage_attempted(TEXT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.record_quota_usage_actual(TEXT, INTEGER)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.commit_quota_usage(TEXT, INTEGER)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.release_quota_usage(TEXT, TEXT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_expired_quota_reservations_scope(TEXT, DATE, TEXT, INTEGER)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_expired_quota_reservations(INTEGER)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.increment_usage_atomic(TEXT, TEXT, TEXT, INTEGER, INTEGER)
  TO service_role;

-- Rollback guide (manual, in dependency order):
-- DROP FUNCTION IF EXISTS public.reconcile_expired_quota_reservations(INTEGER);
-- DROP FUNCTION IF EXISTS public.reserve_quota_usage(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER);
-- DROP FUNCTION IF EXISTS public.settle_expired_quota_reservations_scope(TEXT, DATE, TEXT, INTEGER);
-- DROP FUNCTION IF EXISTS public.release_quota_usage(TEXT, TEXT);
-- DROP FUNCTION IF EXISTS public.commit_quota_usage(TEXT, INTEGER);
-- DROP FUNCTION IF EXISTS public.record_quota_usage_actual(TEXT, INTEGER);
-- DROP FUNCTION IF EXISTS public.mark_quota_usage_attempted(TEXT);
-- Reapply migration 021's increment_usage_atomic definition if rolling back.
-- DROP TABLE IF EXISTS public.quota_usage_reservations;
