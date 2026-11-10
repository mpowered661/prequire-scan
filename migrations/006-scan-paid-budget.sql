-- Migration 006: atomic daily ceiling on paid public scans (/api/scan model calls)
-- Run in the Supabase SQL Editor (production project). Additive only: one new
-- table + one function. Touches no existing table.
--
-- claim_paid_scan(cap) takes one slot for the current UTC day and returns true, or
-- returns false when the day's slots are used. The upsert holds the day's row lock,
-- so concurrent requests serialise: N parallel calls can never take more than cap.

BEGIN;

CREATE TABLE IF NOT EXISTS public.scan_paid_budget (
  day   date    PRIMARY KEY,
  used  integer NOT NULL DEFAULT 0 CHECK (used >= 0)
);

-- Service role only. RLS on with no policies, and no direct table privileges for
-- the client roles (Supabase's default privileges would otherwise grant them).
ALTER TABLE public.scan_paid_budget ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.scan_paid_budget FROM PUBLIC, anon, authenticated;

-- SECURITY DEFINER: runs as the owner (postgres, the SQL Editor role), which owns the
-- table. search_path is empty and every object is schema-qualified, so a caller cannot
-- redirect name resolution; now() resolves from pg_catalog, which is always searched.
CREATE OR REPLACE FUNCTION public.claim_paid_scan(p_cap integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
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

ALTER FUNCTION public.claim_paid_scan(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_paid_scan(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_paid_scan(integer) TO service_role;

COMMIT;

-- ── Production verification (non-destructive: reads catalogs only) ────────────────
-- 1. Function: SECURITY DEFINER, empty search_path, owner postgres.
--    SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner
--      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--     WHERE n.nspname = 'public' AND p.proname = 'claim_paid_scan';
--    expect: true | {search_path=""} | postgres
-- 2. Who may execute: expect service_role (and postgres) true; anon, authenticated false.
--    SELECT r AS role, has_function_privilege(r, 'public.claim_paid_scan(integer)', 'EXECUTE') AS can_execute
--      FROM unnest(ARRAY['anon','authenticated','service_role']) AS r;
-- 3. Table: RLS on; no client-role privileges.
--    SELECT relrowsecurity FROM pg_class WHERE oid = 'public.scan_paid_budget'::regclass;   -- expect true
--    SELECT r AS role, has_table_privilege(r, 'public.scan_paid_budget', 'SELECT,INSERT,UPDATE,DELETE') AS any_priv
--      FROM unnest(ARRAY['anon','authenticated']) AS r;                                     -- expect false, false
-- 4. Current usage (read only):
--    SELECT day, used FROM public.scan_paid_budget ORDER BY day DESC LIMIT 3;
--
-- ── Behaviour check (run BEFORE the scanner deploy, while nothing claims slots) ──────
-- Never deletes or resets the live counter: it adds slots inside a transaction that is
-- rolled back, so the table is exactly as before. Holds today's row lock until ROLLBACK.
--    BEGIN;
--      SELECT coalesce((SELECT used FROM public.scan_paid_budget
--                        WHERE day = (now() AT TIME ZONE 'utc')::date), 0) AS used_before;  -- note N
--      SELECT public.claim_paid_scan(1000000) AS claim_under_cap;   -- expect true
--      SELECT public.claim_paid_scan(1)       AS claim_at_cap;      -- expect false (used is now >= 1)
--      SELECT public.claim_paid_scan(0)       AS zero_cap;          -- expect false
--      SELECT used FROM public.scan_paid_budget
--       WHERE day = (now() AT TIME ZONE 'utc')::date;                -- expect N + 1
--    ROLLBACK;
--    -- then: query 4 again; today's used must equal N (or no row if there was none).
--
-- ── Isolated environment only (not production) ─────────────────────────────────────
-- Concurrency: from two separate sessions run claim_paid_scan(1) at the same moment on
-- an empty day; exactly one returns true. (Upsert on one row serialises on its lock.)
--
-- ── Rollback ───────────────────────────────────────────────────────────────────────
-- DROP FUNCTION public.claim_paid_scan(integer); DROP TABLE public.scan_paid_budget;
