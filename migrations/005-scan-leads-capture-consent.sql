-- Migration 005: consent + capture metadata on scan_leads
-- Run in Supabase SQL Editor (project: emqpoxnjfqxopxwjkweh)
-- STATUS: WRITTEN, NOT APPLIED — Supabase schema changes are owner-gated.
--
-- WHY (Lead Capture sprint 2026-08-06): the optional email-report capture on
-- scan.prequire.ai records consent timestamp, score band, and scan/versioning
-- metadata (registry_version, prompt_version, model, scan_id). scan_leads has
-- no columns for these. Until this migration is applied, captureLead degrades
-- to the legacy column set (capture still lands; consent_ts appears only in
-- function logs).
--
-- SCOPE: additive only.
--   - Adds three nullable columns. No existing column, index, RLS, or policy
--     is modified. No backfill.
--
-- RUN THE ENTIRE BLOCK. A partial editor selection that includes BEGIN but not
-- COMMIT rolls back silently while still printing NOTICE + "Success".

BEGIN;

ALTER TABLE public.scan_leads ADD COLUMN IF NOT EXISTS consent_ts   timestamptz;
ALTER TABLE public.scan_leads ADD COLUMN IF NOT EXISTS score_band   text;
ALTER TABLE public.scan_leads ADD COLUMN IF NOT EXISTS capture_meta jsonb;

COMMENT ON COLUMN public.scan_leads.consent_ts   IS 'Server timestamp when the visitor submitted the email-report form (consent_source in capture_meta)';
COMMENT ON COLUMN public.scan_leads.score_band   IS 'strong | moderate | weak — matches lib/scanUtils.ts scoreBand thresholds at capture time';
COMMENT ON COLUMN public.scan_leads.capture_meta IS 'scan_id, scanned_at, registry_version, prompt_version, model, consent_source';

-- Verification guard: abort if any column is still missing.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'scan_leads'
       AND column_name IN ('consent_ts', 'score_band', 'capture_meta')
     GROUP BY table_name
    HAVING count(*) = 3
  ) THEN
    RAISE EXCEPTION 'Migration 005 failed: capture columns not present after ALTER';
  END IF;
END $$;

COMMIT;

-- ---------------------------------------------------------------------------
-- POST-MIGRATION VERIFICATION (run separately, after COMMIT)
-- ---------------------------------------------------------------------------

-- 1. Expect the three new columns, all nullable.
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name   = 'scan_leads'
   AND column_name IN ('consent_ts', 'score_band', 'capture_meta')
 ORDER BY column_name;

-- 2. Confirm RLS still enabled with no policies (deny-all; service role bypasses).
SELECT relrowsecurity AS rls_enabled
  FROM pg_class
 WHERE oid = 'public.scan_leads'::regclass;

SELECT count(*) AS policy_count
  FROM pg_policies
 WHERE schemaname = 'public' AND tablename = 'scan_leads';
