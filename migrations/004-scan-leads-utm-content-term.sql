-- Migration 004: add utm_content and utm_term to scan_leads
-- Run in Supabase SQL Editor (project: emqpoxnjfqxopxwjkweh)
--
-- WHY: app/api/scan/route.ts has sent utm_content and utm_term on every
-- scan_leads insert since the initial commit (2026-04-17). Neither column
-- exists in production, so PostgREST rejects the whole statement (PGRST204)
-- and every insert has failed silently. Confirmed via live query:
--   row count = 0, oldest/newest created_at = null, oldest/newest scanned_at = null
--
-- SCOPE: additive only.
--   - Adds two nullable text columns.
--   - Does NOT modify any existing column.
--   - Does NOT touch created_at or scanned_at.
--   - Does NOT change indexes.
--   - Does NOT change RLS or policies.
--   - No backfill: the table has zero rows.
--
-- NOTE ON NUMBERING: 003 is already taken by aeo_readiness_checks (applied in
-- production; file not tracked in this repo — see CLAUDE.md "Security Debt").
-- This is 004 to avoid the duplicate-number drift that affected the dashboard
-- project's migrations (016 x2, 031 x2).
--
-- RUN THE ENTIRE BLOCK. A partial editor selection that includes BEGIN but not
-- COMMIT rolls back silently while still printing NOTICE + "Success".

BEGIN;

ALTER TABLE public.scan_leads ADD COLUMN IF NOT EXISTS utm_content text;
ALTER TABLE public.scan_leads ADD COLUMN IF NOT EXISTS utm_term    text;

-- Verification guard: abort the transaction if either column is still missing.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'scan_leads'
       AND column_name IN ('utm_content', 'utm_term')
     GROUP BY table_name
    HAVING count(*) = 2
  ) THEN
    RAISE EXCEPTION 'Migration 004 failed: utm_content/utm_term not present after ALTER';
  END IF;
END $$;

COMMIT;

-- ---------------------------------------------------------------------------
-- POST-MIGRATION VERIFICATION (run separately, after COMMIT)
-- ---------------------------------------------------------------------------

-- 1. Expect exactly 5 rows: utm_campaign, utm_content, utm_medium, utm_source, utm_term
--    All must report is_nullable = YES and data_type = text.
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name   = 'scan_leads'
   AND column_name LIKE 'utm@_%' ESCAPE '@'
 ORDER BY column_name;

-- 2. Confirm created_at and scanned_at are untouched.
--    Expect created_at = NOT NULL (is_nullable NO), scanned_at = is_nullable YES.
SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name   = 'scan_leads'
   AND column_name IN ('created_at', 'scanned_at')
 ORDER BY column_name;

-- 3. Confirm RLS is still enabled with no policies (deny-all; service role bypasses).
SELECT relrowsecurity AS rls_enabled
  FROM pg_class
 WHERE oid = 'public.scan_leads'::regclass;

SELECT count(*) AS policy_count
  FROM pg_policies
 WHERE schemaname = 'public' AND tablename = 'scan_leads';

-- 4. Baseline row count. Expect 0 before the first post-fix scan, 1 after.
SELECT count(*) AS rows FROM public.scan_leads;
