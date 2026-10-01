-- Migration 010: operator capabilities for presentation review.
-- Run in Supabase SQL Editor (same project as migrations 001-009).
--
-- *** NOT APPLIED. *** This file has never been executed against any database.
-- Confirm against the live schema before applying.
--
-- WHY: Phase 2b-A needs the server to answer one question about an
-- already-authenticated human: does this auth.users.id currently hold
-- presentation.approve? Nothing else. This is the smallest authorization state
-- that gate requires.
--
-- SCOPE: additive only.
--   - Creates one new table.
--   - Does NOT modify any existing table, column, index, policy or trigger.
--   - Does NOT create review_decisions or presentation_snapshots. Decision and
--     snapshot persistence is Phase 2b-B and is NOT authorized yet.
--   - Does NOT depend on migration 008 (known broken: it references
--     site_scans(id) while 006 defines site_scans.scan_id) or on migration 009.
--
-- DELIBERATELY MUTABLE, UNLIKE 009. `revoked_at` is updated in place. This table
-- holds AUTHORIZATION STATE, not historical approval evidence, so the
-- append-only UPDATE/DELETE refusal trigger from migration 009 is intentionally
-- NOT applied here. Event sourcing is explicitly out of scope for v0.1.
--
-- FROZEN HISTORICAL RULE this table must not violate: if a reviewer held
-- presentation.approve at decisionTimestamp, that approval stays historically
-- attributable even after the capability is revoked. Revocation blocks NEW
-- approvals only. Historical approvals are invalidated solely by the frozen
-- review semantics (explicit REVOKE, evidence or claim invalidation,
-- staleness). Nothing in this migration touches past decisions — and it cannot,
-- because no decision table exists yet.
--
-- NOTE ON NUMBERING: 003 is taken by aeo_readiness_checks (applied in
-- production; file not tracked in this repo — see migration 004's note). 010 is
-- the next free number in this directory, which is NOT a complete record of the
-- live schema.
--
-- RUN THE ENTIRE BLOCK. A partial editor selection that includes BEGIN but not
-- COMMIT rolls back silently while still printing NOTICE + "Success".

BEGIN;

create table if not exists public.operator_capabilities (
  -- Cascade is correct HERE and only here: deleting an operator must remove
  -- their live authorization. Historical attribution lives in a future
  -- review_decisions table, which must NOT cascade.
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Exactly one capability exists in v0.1. No roles, teams, groups,
  -- organizations, wildcards, inheritance or policy DSL.
  capability text not null check (capability = 'presentation.approve'),
  granted_at timestamptz not null default now(),
  -- Who granted it, for audit. ON DELETE SET NULL so removing the granting
  -- operator can never block deletion or orphan the grant.
  granted_by uuid null references auth.users(id) on delete set null,
  -- Mutable by design. NULL means active.
  revoked_at timestamptz null,
  constraint operator_capabilities_revoked_after_granted
    check (revoked_at is null or revoked_at >= granted_at),
  -- The composite key makes duplicate (user, capability) rows structurally
  -- impossible, so the server's active-capability lookup reads at most one row.
  primary key (user_id, capability)
);

alter table public.operator_capabilities enable row level security;

-- RLS constrains anon and authenticated only; service_role holds BYPASSRLS and
-- is not constrained by policies (see migration 004's note, and the correction
-- recorded in migration 009). Only the server reads this table, via the
-- service-role client, so no anon or authenticated policy is defined at all.
-- No policy here is therefore deny-all for the API roles by construction.

-- Verification guard: abort if the table is not shaped as expected, so it can
-- never exist in a form the server's lookup would misread.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'operator_capabilities'
       AND column_name IN ('user_id', 'capability', 'granted_at', 'granted_by', 'revoked_at')
     GROUP BY table_name
    HAVING count(*) = 5
  ) THEN
    RAISE EXCEPTION 'Migration 010 failed: operator_capabilities columns not present after create';
  END IF;
END $$;

COMMIT;

-- ---------------------------------------------------------------------------
-- POST-MIGRATION VERIFICATION (run separately, after COMMIT)
-- ---------------------------------------------------------------------------

-- 1. Composite primary key present. Expect one row listing user_id, capability.
SELECT a.attname
  FROM pg_index i
  JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
 WHERE i.indrelid = 'public.operator_capabilities'::regclass
   AND i.indisprimary
 ORDER BY a.attname;

-- 2. RLS enabled, and zero policies (deny-all for anon/authenticated).
SELECT relrowsecurity AS rls_enabled
  FROM pg_class
 WHERE oid = 'public.operator_capabilities'::regclass;

SELECT count(*) AS policy_count
  FROM pg_policies
 WHERE schemaname = 'public' AND tablename = 'operator_capabilities';

-- 3. No immutability trigger on this table, unlike qualification_inputs.
--    Expect zero rows: revoked_at is intentionally mutable.
SELECT tgname
  FROM pg_trigger
 WHERE tgrelid = 'public.operator_capabilities'::regclass
   AND NOT tgisinternal;

-- 4. Duplicate grant must FAIL on the composite key. Run rolled back.
-- BEGIN;
--   INSERT INTO public.operator_capabilities (user_id, capability)
--   VALUES ('00000000-0000-4000-8000-000000000001', 'presentation.approve'),
--          ('00000000-0000-4000-8000-000000000001', 'presentation.approve');
-- ROLLBACK;
