-- Voice admission is journaled before the attempt transition. The backend
-- uses this routine to recover an abandoned start. Zero means the provider
-- was never entered. Otherwise use the reserved amount if no measure exists.
-- Expiry still leaves unmeasured voice attempts to the journal, which replays
-- measured usage first and settles abandoned starts from their durable state.
-- To revert, first stop voice admission and drain both journal tables before
-- dropping the new function. Do not discard unsettled journal files.
CREATE OR REPLACE FUNCTION public.recover_voice_quota_start(p_key TEXT, p_fallback INTEGER)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $recover_voice_quota_start$
DECLARE
  v_guild_id TEXT;
  v_usage_date DATE;
  v_reservation public.quota_usage_reservations%ROWTYPE;
BEGIN
  SELECT r.guild_id, r.usage_date INTO v_guild_id, v_usage_date
  FROM public.quota_usage_reservations r
  WHERE r.idempotency_key = p_key AND r.resource = 'voice_minutes';

  IF NOT FOUND THEN RETURN FALSE; END IF;

  PERFORM 1 FROM public.guild_daily_usage gdu
  WHERE gdu.guild_id = v_guild_id AND gdu.usage_date = v_usage_date
  FOR UPDATE;

  SELECT r.* INTO v_reservation
  FROM public.quota_usage_reservations r
  WHERE r.idempotency_key = p_key AND r.resource = 'voice_minutes'
  FOR UPDATE;

  IF NOT FOUND OR p_fallback IS NULL
    OR (p_fallback <> 0 AND p_fallback <> v_reservation.reserved_amount)
  THEN RETURN FALSE; END IF;

  IF v_reservation.status IN ('committed', 'released') THEN RETURN TRUE; END IF;

  IF p_fallback = 0 AND v_reservation.reported_actual_amount IS NULL THEN
    UPDATE public.quota_usage_reservations r
    SET status = 'released', reason = 'voice_start_cancelled', attempted_at = NULL,
        finalized_at = NOW(), updated_at = NOW()
    WHERE r.idempotency_key = p_key;
    RETURN TRUE;
  END IF;

  IF v_reservation.status <> 'attempted' THEN RETURN FALSE; END IF;
  PERFORM public.commit_quota_usage(
    p_key, COALESCE(v_reservation.reported_actual_amount, p_fallback)
  );
  RETURN TRUE;
END;
$recover_voice_quota_start$;

REVOKE EXECUTE ON FUNCTION public.recover_voice_quota_start(TEXT, INTEGER)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recover_voice_quota_start(TEXT, INTEGER) TO service_role;
