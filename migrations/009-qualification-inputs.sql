-- Migration 009: immutable QualificationInput artifact, one per completed scan.
-- *** NOT APPLIED. *** This file has never been executed against any database.
-- Run in Supabase SQL Editor (same project as migrations 001-008).
--
-- WHY: the trusted scan -> QualificationInput bridge needs an immutable record
-- of the exact input a scan observed, so a later approval boundary can
-- re-derive ReviewPackets without re-scanning the site or trusting a
-- client-supplied packet.
--
-- SCOPE: additive only.
--   - Creates one new table.
--   - Creates one trigger function and one trigger, used ONLY by this table.
--   - Revokes UPDATE/DELETE on this table only.
--   - Does NOT modify any existing table, column, index, policy or trigger.
--   - Does NOT reference site_scans or page_observations, so it neither
--     depends on nor repairs migration 008.
--
-- NOTE ON NUMBERING: 003 is taken by aeo_readiness_checks (applied in
-- production; file not tracked in this repo — see migration 004's note). 009 is
-- the next free number in this directory, which is NOT a complete record of the
-- live schema. Confirm against the live schema before applying.
--
-- RUN THE ENTIRE BLOCK. A partial editor selection that includes BEGIN but not
-- COMMIT rolls back silently while still printing NOTICE + "Success".

BEGIN;

create table if not exists public.qualification_inputs (
  scan_id uuid primary key,
  input_schema_version text not null,
  qualification_version text not null,
  input_hash text not null check (input_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  -- The payload must be a JSON object carrying the scan identity it belongs to,
  -- so a row cannot be read under the wrong scan. Defence in depth: the
  -- application validator is the boundary, this catches a writer that bypasses it.
  constraint qualification_inputs_payload_is_object
    check (jsonb_typeof(payload) = 'object'),
  constraint qualification_inputs_payload_carries_scan_id
    check (payload ->> 'scanId' = scan_id::text),
  -- All four evidence collections must be present as arrays. An ABSENT
  -- collection is not an observed empty one, and only a complete observation
  -- may be stored.
  constraint qualification_inputs_payload_collections_present
    check (
      jsonb_typeof(payload -> 'scanUrls') = 'array'
      and jsonb_typeof(payload -> 'pageObservations') = 'array'
      and jsonb_typeof(payload -> 'linkTargets') = 'array'
      and jsonb_typeof(payload -> 'linkRelationships') = 'array'
      and jsonb_typeof(payload -> 'coverage') = 'object'
    )
);

-- ── row immutability, enforced by the database ───────────────────────────────
--
-- CORRECTION (follow-up to the v0.1 acceptance inspection): an earlier draft of
-- this migration claimed that defining no UPDATE/DELETE policy meant "even the
-- service role cannot rewrite or remove a stored artifact". THAT WAS WRONG.
-- Supabase's service_role holds BYPASSRLS, so RLS policies do not constrain it
-- at all — a fact migration 004 already records ("deny-all; service role
-- bypasses"). Absent RLS policies are therefore NOT database-enforced
-- immutability; they only constrain the anon and authenticated roles.
--
-- Two mechanisms are used together, because they fail differently:
--
--   1. REVOKE of UPDATE/DELETE privileges. Table privileges DO apply to
--      service_role (BYPASSRLS bypasses policies, not GRANTs), so this blocks
--      the PostgREST service-key path. It does NOT bind the table OWNER, and a
--      later GRANT or Supabase default-privilege change could undo it.
--
--   2. A BEFORE UPDATE OR DELETE trigger that raises. This binds EVERY role,
--      including the owner, and is the dependable mechanism. It is the primary
--      enforcement; the REVOKE above is least-privilege defence in depth.
--
-- GUARANTEE, stated accurately: normal DML against this table through the
-- deployed database — including with the service-role key and including as the
-- table owner — cannot UPDATE or DELETE a row once inserted. INSERT and SELECT
-- are unaffected.
--
-- LIMITATION, stated accurately: this is not protection against a superuser or
-- owner who deliberately drops the trigger, runs ALTER TABLE ... DISABLE
-- TRIGGER, sets session_replication_role = 'replica', or alters the schema.
-- Anyone with that level of access can change the table. The claim is
-- database-enforced append-only under normal DML, not absolute immutability.

create or replace function public.refuse_qualification_input_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'qualification_inputs is immutable: % is not permitted. A new observation requires a new scan_id.',
    tg_op
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists qualification_inputs_immutable on public.qualification_inputs;

create trigger qualification_inputs_immutable
  before update or delete on public.qualification_inputs
  for each row
  execute function public.refuse_qualification_input_mutation();

revoke update, delete on public.qualification_inputs from service_role;
revoke update, delete on public.qualification_inputs from authenticated;
revoke update, delete on public.qualification_inputs from anon;

-- ── row level security ───────────────────────────────────────────────────────
-- RLS constrains anon/authenticated only; service_role bypasses it. It is kept
-- for least privilege, NOT as the immutability mechanism.

alter table public.qualification_inputs enable row level security;

create policy "service role can insert qualification inputs"
  on public.qualification_inputs
  for insert
  to service_role
  with check (true);

create policy "service role can read qualification inputs"
  on public.qualification_inputs
  for select
  to service_role
  using (true);

-- No UPDATE policy and no DELETE policy. Immutability is enforced by the
-- trigger above, not by the absence of these policies.

-- Verification guard: abort the transaction if the trigger is not in place, so
-- the table can never exist without its immutability enforcement.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger
     WHERE tgrelid = 'public.qualification_inputs'::regclass
       AND tgname  = 'qualification_inputs_immutable'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'Migration 009 failed: qualification_inputs_immutable trigger not present';
  END IF;
END $$;

COMMIT;

-- ---------------------------------------------------------------------------
-- POST-MIGRATION VERIFICATION (run separately, after COMMIT)
-- ---------------------------------------------------------------------------

-- 1. Trigger present and enabled. Expect one row, tgenabled = 'O'.
SELECT tgname, tgenabled
  FROM pg_trigger
 WHERE tgrelid = 'public.qualification_inputs'::regclass
   AND NOT tgisinternal;

-- 2. No UPDATE or DELETE privilege for the API roles. Expect zero rows.
SELECT grantee, privilege_type
  FROM information_schema.role_table_grants
 WHERE table_schema = 'public'
   AND table_name   = 'qualification_inputs'
   AND privilege_type IN ('UPDATE', 'DELETE')
   AND grantee IN ('service_role', 'authenticated', 'anon');

-- 3. RLS enabled with exactly the two expected policies.
SELECT relrowsecurity AS rls_enabled
  FROM pg_class
 WHERE oid = 'public.qualification_inputs'::regclass;

SELECT policyname, cmd
  FROM pg_policies
 WHERE schemaname = 'public' AND tablename = 'qualification_inputs'
 ORDER BY policyname;

-- 4. Immutability smoke test. Both statements must FAIL with
--    'qualification_inputs is immutable'. Run inside a transaction and roll
--    back, so nothing is touched even if enforcement were somehow absent.
-- BEGIN;
--   UPDATE public.qualification_inputs SET input_hash = input_hash;
--   DELETE FROM public.qualification_inputs;
-- ROLLBACK;
