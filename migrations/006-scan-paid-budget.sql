-- Migration 006: atomic daily ceiling on paid public scans (/api/scan model calls)
-- Run in the Supabase SQL Editor (production project). Additive only: one new
-- table + one function. Touches no existing table.
--
-- claim_paid_scan(cap) takes one slot for the current UTC day and returns true, or
-- returns false when the day's slots are used. The upsert holds the day's row lock,
-- so concurrent requests serialise: N parallel calls can never take more than cap.

CREATE TABLE IF NOT EXISTS public.scan_paid_budget (
  day   date    PRIMARY KEY,
  used  integer NOT NULL DEFAULT 0 CHECK (used >= 0)
);

-- Service role only: RLS on, no policies (anon/authenticated get nothing).
ALTER TABLE public.scan_paid_budget ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.claim_paid_scan(p_cap integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_used integer;
BEGIN
  IF p_cap IS NULL OR p_cap < 1 THEN
    RETURN false;
  END IF;
  INSERT INTO public.scan_paid_budget AS b (day, used)
  VALUES ((now() AT TIME ZONE 'utc')::date, 1)
  ON CONFLICT (day) DO UPDATE
    SET used = b.used + 1
    WHERE b.used < p_cap
  RETURNING b.used INTO v_used;
  RETURN v_used IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_paid_scan(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_paid_scan(integer) TO service_role;

-- ── Self-test (run separately; changes nothing — the transaction is rolled back) ──
-- BEGIN;
--   DELETE FROM public.scan_paid_budget WHERE day = (now() AT TIME ZONE 'utc')::date;
--   SELECT public.claim_paid_scan(2) AS first;    -- expect true
--   SELECT public.claim_paid_scan(2) AS second;   -- expect true
--   SELECT public.claim_paid_scan(2) AS third;    -- expect false (cap reached)
--   SELECT used FROM public.scan_paid_budget WHERE day = (now() AT TIME ZONE 'utc')::date; -- expect 2
--   SELECT public.claim_paid_scan(0) AS zero_cap; -- expect false
-- ROLLBACK;
--
-- Verify grants (expect only service_role / postgres to hold EXECUTE):
-- SELECT grantee, privilege_type FROM information_schema.routine_privileges
--  WHERE routine_schema = 'public' AND routine_name = 'claim_paid_scan';
