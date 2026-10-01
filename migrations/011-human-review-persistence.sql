-- Migration 011: immutable human review decisions and presentation snapshots.
-- *** NOT APPLIED. *** This file has never been executed against any database.
-- Run in Supabase SQL Editor (same project as migrations 001-010).
--
-- WHY: Phase 2a derives approval status from immutable decisions but persists
-- nothing. Phase 2b-A authenticates a human reviewer and mints exactly one
-- TrustedReviewerIdentity, but still writes nothing. This migration is the
-- append-only store those layers imply: a human decision, and -- for an
-- approval only -- the presentation snapshot derived from it, written in ONE
-- transaction or not at all.
--
-- SCOPE: additive only.
--   - Creates two new tables.
--   - Creates two trigger functions and two triggers, used ONLY by these tables.
--   - Creates one RPC, with EXECUTE revoked from PUBLIC/anon/authenticated.
--   - Adds foreign keys REFERENCING public.qualification_inputs(scan_id)
--     (migration 009). It does not alter that table.
--   - Does NOT modify any existing table, column, index, policy or trigger.
--   - Does NOT create a route, a UI, or any mutable approval state.
--
-- DEPENDS ON: migration 009 (qualification_inputs). Migration 010
-- (operator_capabilities) is NOT referenced here: capability is authorization,
-- evaluated in TypeScript before this RPC is ever called. This file must not
-- re-decide it.
--
-- NOTE ON NUMBERING: 003 is taken by aeo_readiness_checks (applied in
-- production; file not tracked in this repo). 011 is the next free number in
-- this directory, which is NOT a complete record of the live schema. Confirm
-- against the live schema before applying.
--
-- RUN THE ENTIRE BLOCK. A partial editor selection that includes BEGIN but not
-- COMMIT rolls back silently while still printing NOTICE + "Success".


-- ===========================================================================
-- DESIGN RULINGS (read before changing anything below)
-- ===========================================================================
--
-- RULING 1 -- WHO OWNS WHAT. The trust split is deliberate and narrow.
--
--   PostgreSQL owns:  identity and uniqueness, ATOMICITY of the
--                     decision+snapshot pair, the recheck that the immutable
--                     QualificationInput identity still matches, digest
--                     formats, field bounds, cross-field presence rules,
--                     refusal to STORE a state the frozen model cannot
--                     express, and append-only enforcement.
--
--   TypeScript owns:  contract version acceptance, reviewer capability,
--                     binding exactness, approval eligibility, derived
--                     status, revocation fan-out, and idempotency SEMANTICS.
--
--   The RPC therefore never re-evaluates whether a decision was correct. It
--   enforces that what it is told to store is internally consistent, is bound
--   to the exact evidence it names, and is written exactly once.
--
--   Refusing to store an unrepresentable value (temporal_frame other than
--   CURRENT_STATE, a presentation mode other than STATEMENT_WITH_DEMONSTRATION)
--   is NOT policy re-evaluation. The frozen model has no way to express those
--   states, so a row carrying one could only arrive from a bypassed writer.
--   Contract VERSIONS, by contrast, carry no CHECK: which versions are
--   acceptable is policy, it changes without a schema change, and
--   validateReviewDecision already fails closed on a mismatch.
--
-- RULING 2 -- reviewer_user_id HAS NO FOREIGN KEY. Four options were weighed:
--
--   (a) ON DELETE CASCADE      REJECTED, and explicitly forbidden by contract.
--                              Deleting an auth user would silently destroy the
--                              audit record of every approval they ever made.
--                              An immutable attestation that can be erased by a
--                              side effect elsewhere is not immutable.
--
--   (b) ON DELETE SET NULL     REJECTED. It MUTATES a row this migration
--                              declares append-only -- the immutability trigger
--                              below would raise restrict_violation and the
--                              auth-user deletion would fail with a confusing
--                              error from an unrelated table. It also destroys
--                              attribution, which is the point of the record.
--
--   (c) ON DELETE RESTRICT     REJECTED. Correct in isolation, but it makes
--       / NO ACTION            deleting any auth user impossible once they have
--                              reviewed anything, coupling account deletion
--                              (including a data-subject erasure request) to the
--                              audit log, with no migration path.
--
--   (d) plain immutable uuid   CHOSEN. A review decision is a historical
--       with no FK             attestation about WHO approved WHAT WHEN. That
--                              fact does not stop being true when the account is
--                              later deleted, renamed or disabled. The column
--                              records identity as observed at
--                              decision_timestamp.
--
--   ACCEPTED COST, stated plainly: there is no database-level guarantee that
--   reviewer_user_id names an existing auth user. That is tolerable only
--   because the value cannot be caller-supplied: it originates from
--   supabase.auth.getUser(token) and is then checked against
--   operator_capabilities, both in Phase 2b-A, before this RPC is reachable.
--   The database is NOT the boundary that establishes human identity.
--   Consequence: a reader joining to auth.users must LEFT JOIN and treat a
--   missing user as "account no longer exists", never as "decision invalid".
--
-- RULING 3 -- ONE DECISION PER CALL (v0.1). The frozen layer has no batch type:
--   derivePresentationSnapshotFromDecision takes exactly ONE decision (plus
--   allDecisions, which is prior history used only to derive status), and
--   deriveDecisionStatus is per-packet. Approving several opportunities is
--   therefore a COMPOSITION of single calls at a higher layer, not a
--   persistence-layer concern. Encoding a multi-row write here would invent a
--   transaction boundary the reviewed model does not define.
--
-- RULING 4 -- NO MUTABLE STATE COLUMN. There is deliberately no approved,
--   status, current, active, is_revoked or superseded column anywhere below.
--   Status is DERIVED from the full decision history on every read, by
--   deriveDecisionStatus. A stored flag would be a second source of truth and
--   would drift from the derivation the moment either changed.
--
-- RULING 5 -- review_decision_id AND decision_timestamp ARE SUPPLIED, NOT
--   GENERATED HERE. This is forced by the frozen layer, and the first draft of
--   this migration had it backwards.
--
--   derivePresentationSnapshotFromDecision consumes decision.reviewDecisionId
--   (it becomes snapshot.reviewDecisionId, and feeds deterministicSnapshotId),
--   and it calls deriveDecisionStatus, which orders history by
--   decisionTimestamp and requires the supplied decision to be the CURRENT one.
--   Both values therefore have to exist BEFORE the snapshot can be derived,
--   and the snapshot has to be derived before it can be persisted. A
--   database-generated id would not match the snapshot already derived against
--   it, and gen_random_uuid() is deliberately absent from review_decision_id so
--   that an omitted id fails loudly instead of silently minting a different one.
--
--   decision_timestamp is TEXT, not timestamptz. The frozen layer's notion of
--   order is LEXICOGRAPHIC on the normalized ISO string -- orderDecisions
--   compares normalizedDecisionTimestamp(a) to normalizedDecisionTimestamp(b)
--   and breaks ties on reviewDecisionId as a string. Storing a timestamptz and
--   re-rendering it on read would hand back different bytes than were
--   recorded. The CHECK requires the NORMALIZED form (exactly three fractional
--   digits), which the wrapper produces with the frozen
--   normalizedDecisionTimestamp. Normalization only pads, so it is lossless,
--   and it makes database order agree with frozen order rather than merely
--   resemble it.
--
--   ACCEPTED COST: a supplied timestamp could be backdated. Two mitigations,
--   neither of which pretends the database establishes time. The RPC refuses a
--   decision_timestamp more than five minutes from the database clock -- a
--   plausibility bound, since a decision is recorded immediately after it is
--   made. And recorded_at is the database's OWN clock, written by default and
--   never supplied, so the asserted time and the observed time can always be
--   compared after the fact.

BEGIN;

-- ── review_decisions ────────────────────────────────────────────────────────
-- One immutable row per human decision. Append-only: never updated, never
-- deleted. A REVOKE is a NEW row naming the decision it de-authorizes, not an
-- edit of the row it revokes.

create table if not exists public.review_decisions (
  -- SUPPLIED by the caller, never defaulted. See RULING 5: the snapshot is
  -- derived against this id before either row is written, so the database
  -- must not mint a different one. No default means an omission fails loudly.
  review_decision_id uuid primary key,

  -- Idempotency key, supplied by the caller. UNIQUE is the atomicity mechanism
  -- for retries: two concurrent calls carrying the same request_id cannot both
  -- insert, whatever the application believes.
  request_id text not null unique
    constraint review_decisions_request_id_nonempty check (length(request_id) > 0),

  decision_type text not null
    constraint review_decisions_decision_type_known
      check (decision_type in ('APPROVE_PRESENTATION', 'REJECT', 'REVOKE')),

  -- WHO. See RULING 2: deliberately no foreign key.
  reviewer_user_id uuid not null,
  reviewer_capability text not null
    constraint review_decisions_capability_known
      check (reviewer_capability = 'presentation.approve'),

  -- The binding tuple this decision is about. opportunity_key,
  -- evidence_fingerprint and claim_hash are OPAQUE upstream identifiers
  -- (or-0.1 / oq-0.1.1 produce them); their format is deliberately NOT
  -- constrained here, only their presence. review_packet_hash IS produced in
  -- this repo, by reviewPacketHash(), so its width is checked.
  opportunity_key text not null
    constraint review_decisions_opportunity_key_nonempty check (length(opportunity_key) > 0),
  evidence_fingerprint text not null
    constraint review_decisions_evidence_fingerprint_nonempty check (length(evidence_fingerprint) > 0),
  claim_hash text not null
    constraint review_decisions_claim_hash_nonempty check (length(claim_hash) > 0),
  review_packet_hash text not null
    constraint review_decisions_review_packet_hash_shape
      check (review_packet_hash ~ '^[a-f0-9]{32}$'),

  -- Recorded as observed. NO value CHECK: which versions are ACCEPTABLE is
  -- TypeScript policy (see RULING 1), and a decision recorded under an older
  -- version must stay readable rather than become unstorable.
  review_contract_version text not null,
  qualification_version text not null,
  hra_version text not null,

  -- States the frozen model cannot express are refused at rest.
  presentation_mode text not null,
  demonstrability text not null,
  temporal_frame text not null
    constraint review_decisions_temporal_frame_current_state
      check (temporal_frame = 'CURRENT_STATE'),

  -- SUPPLIED, as text, in the NORMALIZED frozen form. See RULING 5. The RPC
  -- additionally bounds it against the database clock.
  decision_timestamp text not null
    constraint review_decisions_decision_timestamp_normalized_iso
      check (decision_timestamp ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'),

  -- The database's OWN clock. Never supplied, never compared for ordering.
  -- Kept so an asserted decision_timestamp can be audited against the time the
  -- row was actually observed.
  recorded_at timestamptz not null default now(),

  -- Audit evidence only. Never an identity claim. Produced by
  -- reviewedProseHash(), hence the width check.
  reviewed_prose_hash text not null
    constraint review_decisions_reviewed_prose_hash_shape
      check (reviewed_prose_hash ~ '^[a-f0-9]{32}$'),

  structured_rejection_reason text,
  bounded_reviewer_note text,

  -- Present only on REVOKE. Self-referencing, with NO ACTION: the target must
  -- exist, and since rows are never deleted the delete-action is unreachable.
  revokes_review_decision_id uuid
    references public.review_decisions(review_decision_id),

  -- Integrity identity of the canonical idempotency payload, so a retry can be
  -- compared byte-for-byte without the database parsing the payload. Full
  -- sha256, from canonicalDecisionPayloadHash().
  canonical_payload_hash text not null
    constraint review_decisions_canonical_payload_hash_shape
      check (canonical_payload_hash ~ '^[a-f0-9]{64}$'),

  -- The exact immutable observation this decision was made against. The FK
  -- makes an approval against a nonexistent scan impossible; the hash column
  -- makes an approval against a DIFFERENT payload under the same scan_id
  -- impossible. Both are rechecked inside the RPC's transaction.
  source_scan_id uuid not null
    references public.qualification_inputs(scan_id),
  qualification_input_hash text not null
    constraint review_decisions_qualification_input_hash_shape
      check (qualification_input_hash ~ '^[a-f0-9]{64}$'),

  created_at timestamptz not null default now(),

  -- Frozen cross-field rules, enforced structurally.
  constraint review_decisions_reject_requires_reason
    check (
      (decision_type = 'REJECT') = (structured_rejection_reason is not null)
    ),
  constraint review_decisions_reject_reason_in_vocabulary
    check (
      structured_rejection_reason is null
      or structured_rejection_reason in (
        'insufficient_presentation_evidence',
        'claim_not_suitable_for_external_use',
        'scope_or_wording_concern',
        'evidence_not_convincing',
        'other_bounded'
      )
    ),
  constraint review_decisions_revoke_requires_target
    check (
      (decision_type = 'REVOKE') = (revokes_review_decision_id is not null)
    ),
  -- A REVOKE must not point at itself.
  constraint review_decisions_revoke_target_is_not_self
    check (
      revokes_review_decision_id is null
      or revokes_review_decision_id <> review_decision_id
    ),
  -- MAX_REVIEWER_NOTE_CHARS. Oversized input is REJECTED, never truncated.
  constraint review_decisions_note_within_bounds
    check (bounded_reviewer_note is null or length(bounded_reviewer_note) <= 500),
  -- An APPROVE_PRESENTATION may only be stored in the one representable shape.
  constraint review_decisions_approve_shape
    check (
      decision_type <> 'APPROVE_PRESENTATION'
      or (presentation_mode = 'STATEMENT_WITH_DEMONSTRATION'
          and demonstrability = 'DEMONSTRABLE')
    )
);

comment on table public.review_decisions is
  'Append-only human review decisions. No mutable approval state: status is derived from this history by deriveDecisionStatus. See migration 011 RULING 2 for why reviewer_user_id has no foreign key.';


-- ── presentation_snapshots ──────────────────────────────────────────────────
-- Immutable approved presentation truth. Exists ONLY for an
-- APPROVE_PRESENTATION decision, and only ever one per decision.
--
-- A REJECT or REVOKE produces NO row here. That is why the pair must be
-- atomic: an approval decision without its snapshot would be an approval
-- nothing can consume, and a snapshot without its decision would be approved
-- content no human authorized.

create table if not exists public.presentation_snapshots (
  -- Content-addressed, supplied by the caller from deterministicSnapshotId().
  -- Deterministic rather than random, so the same approval cannot yield two
  -- differently-identified snapshots. 32 hex, matching that helper.
  presentation_snapshot_id text primary key
    constraint presentation_snapshots_id_shape
      check (presentation_snapshot_id ~ '^[a-f0-9]{32}$'),

  -- UNIQUE: at most one snapshot per decision. The RPC additionally verifies
  -- the referenced decision is an APPROVE_PRESENTATION -- a cross-row rule a
  -- CHECK constraint cannot express.
  review_decision_id uuid not null unique
    references public.review_decisions(review_decision_id),

  opportunity_key text not null
    constraint presentation_snapshots_opportunity_key_nonempty check (length(opportunity_key) > 0),
  evidence_fingerprint text not null
    constraint presentation_snapshots_evidence_fingerprint_nonempty check (length(evidence_fingerprint) > 0),
  claim_hash text not null
    constraint presentation_snapshots_claim_hash_nonempty check (length(claim_hash) > 0),
  review_packet_hash text not null
    constraint presentation_snapshots_review_packet_hash_shape
      check (review_packet_hash ~ '^[a-f0-9]{32}$'),

  -- Carried through from or-0.1 unchanged, never re-derived or re-worded. The
  -- frozen type is `unknown` and deepFrozenCopy admits any JSON-shaped value,
  -- so the JSON SHAPE is deliberately NOT constrained: a CHECK here could
  -- refuse approved content the model can legitimately represent.
  canonical_claim jsonb not null,
  demonstration jsonb not null,

  reviewed_prose_hash text not null
    constraint presentation_snapshots_reviewed_prose_hash_shape
      check (reviewed_prose_hash ~ '^[a-f0-9]{32}$'),
  -- References digest, NOT duplicated evidence payloads.
  supporting_evidence_refs_digest text not null
    constraint presentation_snapshots_refs_digest_shape
      check (supporting_evidence_refs_digest ~ '^[a-f0-9]{32}$'),

  -- The only approvable shape in v0.1. An unrepresentable value is refused.
  presentation_mode text not null
    constraint presentation_snapshots_mode_approvable
      check (presentation_mode = 'STATEMENT_WITH_DEMONSTRATION'),
  demonstrability text not null
    constraint presentation_snapshots_demonstrability_approvable
      check (demonstrability = 'DEMONSTRABLE'),
  temporal_frame text not null
    constraint presentation_snapshots_temporal_frame_current_state
      check (temporal_frame = 'CURRENT_STATE'),

  -- text, NOT timestamptz, and deliberately unconstrained in format: this is
  -- the exact upstream string that was canonicalized into review_packet_hash.
  -- Parsing and re-rendering it as a timestamp would change those bytes and
  -- silently break hash reproduction.
  observed_at text,

  review_contract_version text not null,
  qualification_version text not null,
  hra_version text not null,

  source_scan_id uuid not null
    references public.qualification_inputs(scan_id),

  created_at timestamptz not null default now()
);

comment on table public.presentation_snapshots is
  'Immutable approved presentation truth, one per APPROVE_PRESENTATION decision, written atomically with it. A later REVOKE does not delete this row; consumability is derived by deriveSnapshotConsumability.';


-- ── indexes ─────────────────────────────────────────────────────────────────
-- Status derivation reads the FULL decision history for one opportunity, so
-- that access path is the one worth indexing.
--
-- The column order mirrors the frozen deterministic order
-- (decision_timestamp, review_decision_id), which is sound because
-- decision_timestamp is stored NORMALIZED text and so sorts lexicographically
-- exactly as orderDecisions compares it. THE INDEX IS FOR RETRIEVAL, NOT
-- AUTHORITY: status is decided by orderDecisions/deriveDecisionStatus over the
-- full history in TypeScript, never by the order rows happen to come back in.

create index if not exists review_decisions_opportunity_history_idx
  on public.review_decisions (opportunity_key, decision_timestamp, review_decision_id);

-- Revocation fan-out resolves targets by id.
create index if not exists review_decisions_revokes_target_idx
  on public.review_decisions (revokes_review_decision_id)
  where revokes_review_decision_id is not null;

-- Re-derivation starts from an immutable observation.
create index if not exists review_decisions_source_scan_idx
  on public.review_decisions (source_scan_id);

create index if not exists presentation_snapshots_opportunity_idx
  on public.presentation_snapshots (opportunity_key);


-- ── append-only enforcement ─────────────────────────────────────────────────
-- WHY A TRIGGER AND NOT RLS: service_role carries BYPASSRLS, so an RLS policy
-- can never enforce immutability against the role this RPC runs as. Triggers
-- fire regardless of BYPASSRLS, and the REVOKEs remove the privilege outright.
-- RLS below is least privilege for anon/authenticated only -- NOT the
-- immutability mechanism.
--
-- LIMITATION, stated plainly: a superuser, the table owner with the trigger
-- disabled (ALTER TABLE ... DISABLE TRIGGER), or a direct `postgres` connection
-- can still mutate these rows. This enforces immutability against the
-- APPLICATION, which is the threat being addressed. It is not tamper-proof
-- storage.

create or replace function public.refuse_review_decision_mutation()
returns trigger
language plpgsql
as $fn$
begin
  raise exception
    'review_decisions is append-only: % is not permitted. A change of mind is a NEW decision (REJECT or REVOKE), never an edit.',
    tg_op
    using errcode = 'restrict_violation';
end;
$fn$;

drop trigger if exists review_decisions_immutable on public.review_decisions;

create trigger review_decisions_immutable
  before update or delete on public.review_decisions
  for each row
  execute function public.refuse_review_decision_mutation();

create or replace function public.refuse_presentation_snapshot_mutation()
returns trigger
language plpgsql
as $fn$
begin
  raise exception
    'presentation_snapshots is immutable: % is not permitted. Approved presentation truth is never edited; a REVOKE decision de-authorizes its use.',
    tg_op
    using errcode = 'restrict_violation';
end;
$fn$;

drop trigger if exists presentation_snapshots_immutable on public.presentation_snapshots;

create trigger presentation_snapshots_immutable
  before update or delete on public.presentation_snapshots
  for each row
  execute function public.refuse_presentation_snapshot_mutation();

revoke update, delete on public.review_decisions from service_role;
revoke update, delete on public.review_decisions from authenticated;
revoke update, delete on public.review_decisions from anon;

revoke update, delete on public.presentation_snapshots from service_role;
revoke update, delete on public.presentation_snapshots from authenticated;
revoke update, delete on public.presentation_snapshots from anon;

-- Writing is reachable ONLY through the RPC below. Direct INSERT is removed
-- from the browser-facing roles so a leaked anon key cannot forge a decision.
revoke insert on public.review_decisions from authenticated;
revoke insert on public.review_decisions from anon;
revoke insert on public.presentation_snapshots from authenticated;
revoke insert on public.presentation_snapshots from anon;


-- ── row level security ──────────────────────────────────────────────────────
-- Enabled with NO policy for anon/authenticated: those roles get no row
-- access at all. service_role bypasses RLS, so its policies are declared
-- explicitly for intent rather than for enforcement.

alter table public.review_decisions enable row level security;
alter table public.presentation_snapshots enable row level security;

create policy "service role can insert review decisions"
  on public.review_decisions
  for insert
  to service_role
  with check (true);

create policy "service role can read review decisions"
  on public.review_decisions
  for select
  to service_role
  using (true);

create policy "service role can insert presentation snapshots"
  on public.presentation_snapshots
  for insert
  to service_role
  with check (true);

create policy "service role can read presentation snapshots"
  on public.presentation_snapshots
  for select
  to service_role
  using (true);

-- No UPDATE policy and no DELETE policy on either table. Immutability is
-- enforced by the triggers and REVOKEs above, not by the absence of policies.


-- ===========================================================================
-- RPC: record_presentation_review
-- ===========================================================================
-- The ONLY write path. Records one human decision and, for an
-- APPROVE_PRESENTATION only, its presentation snapshot -- in ONE transaction.
--
-- SECURITY INVOKER, deliberately. The caller is already service_role, so
-- DEFINER would add no capability while making the function a privilege
-- boundary that outlives its caller. INVOKER keeps the privilege exactly where
-- it already is, and the EXECUTE grants below decide who may call it at all.
-- search_path is pinned so an attacker-controlled search_path cannot
-- substitute a shadowing table or operator.
--
-- WHAT IT DOES NOT DO: it does not evaluate capability, contract versions,
-- binding exactness, eligibility, derived status, or revocation fan-out. Those
-- are TypeScript's (see RULING 1). Every check below is integrity, atomicity
-- or refusal-to-store.
--
-- EXPECTED OUTCOMES ARE RETURNED, NOT RAISED. Every non-RECORDED path returns
-- before writing anything, so an ignored return value cannot leave a partial
-- write. Only genuinely unexpected faults propagate as exceptions.
--
--   RECORDED                          wrote the decision (+ snapshot)
--   ALREADY_RECORDED                  same request_id, same canonical payload
--   IDEMPOTENCY_CONFLICT              same request_id, DIFFERENT payload
--   QUALIFICATION_INPUT_NOT_FOUND     no immutable observation for that scan
--   QUALIFICATION_INPUT_HASH_MISMATCH the observation is not the one reviewed
--   SNAPSHOT_REQUIRED_FOR_APPROVAL    approval without its snapshot
--   SNAPSHOT_FORBIDDEN_FOR_DECISION   REJECT/REVOKE carrying a snapshot
--   SNAPSHOT_BINDING_MISMATCH         snapshot and decision disagree
--   REVOKE_TARGET_NOT_FOUND           revoking a decision that does not exist
--   DECISION_TIMESTAMP_OUT_OF_BOUNDS  asserted time the database cannot have seen
--   MALFORMED_INPUT                   a required field is absent or misshapen

create or replace function public.record_presentation_review(
  p_decision                jsonb,
  p_snapshot                jsonb,
  p_scan_id                 uuid,
  p_expected_input_hash     text,
  p_canonical_payload_hash  text
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_decision_type  text;
  v_request_id     text;
  v_stored_hash    text;
  v_existing       public.review_decisions;
  v_existing_snap  text;
  v_decision_id    uuid;
  v_timestamp      text;
  v_skew           interval;
  v_snapshot_id    text;
  v_has_snapshot   boolean;
begin
  -- shape guards -----------------------------------------------------------
  if p_decision is null or jsonb_typeof(p_decision) <> 'object' then
    return jsonb_build_object('outcome', 'MALFORMED_INPUT',
      'detail', 'p_decision must be a json object');
  end if;

  v_decision_type := p_decision ->> 'decisionType';
  v_request_id    := p_decision ->> 'requestId';

  if v_request_id is null or length(v_request_id) = 0 then
    return jsonb_build_object('outcome', 'MALFORMED_INPUT',
      'detail', 'requestId is required');
  end if;

  if v_decision_type is null
     or v_decision_type not in ('APPROVE_PRESENTATION', 'REJECT', 'REVOKE') then
    return jsonb_build_object('outcome', 'MALFORMED_INPUT',
      'detail', 'decisionType is absent or not a representable decision type');
  end if;

  if p_canonical_payload_hash is null
     or p_canonical_payload_hash !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('outcome', 'MALFORMED_INPUT',
      'detail', 'p_canonical_payload_hash must be 64 lowercase hex characters');
  end if;

  if p_scan_id is null
     or p_expected_input_hash is null
     or p_expected_input_hash !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('outcome', 'MALFORMED_INPUT',
      'detail', 'p_scan_id and a 64-hex p_expected_input_hash are required');
  end if;

  -- The caller mints the decision id and the decision time (RULING 5), so both
  -- are validated here rather than defaulted.
  if (p_decision ->> 'reviewDecisionId') is null then
    return jsonb_build_object('outcome', 'MALFORMED_INPUT',
      'detail', 'reviewDecisionId must be supplied: the snapshot is derived against it');
  end if;

  v_timestamp := p_decision ->> 'decisionTimestamp';

  if v_timestamp is null
     or v_timestamp !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' then
    return jsonb_build_object('outcome', 'MALFORMED_INPUT',
      'detail', 'decisionTimestamp must be normalized ISO with exactly three fractional digits');
  end if;

  -- Plausibility bound only. This does not establish when the decision was
  -- made; it refuses an asserted time the database cannot have observed.
  v_skew := now() - v_timestamp::timestamptz;
  if v_skew > interval '5 minutes' or v_skew < interval '-5 minutes' then
    return jsonb_build_object('outcome', 'DECISION_TIMESTAMP_OUT_OF_BOUNDS',
      'detail', 'decisionTimestamp is more than five minutes from the database clock');
  end if;

  -- JSON null is not a snapshot.
  v_has_snapshot := p_snapshot is not null and jsonb_typeof(p_snapshot) = 'object';

  -- idempotency: has this exact request already been recorded? -------------
  select * into v_existing
    from public.review_decisions
   where request_id = v_request_id;

  if found then
    if v_existing.canonical_payload_hash = p_canonical_payload_hash then
      select presentation_snapshot_id into v_existing_snap
        from public.presentation_snapshots
       where review_decision_id = v_existing.review_decision_id;

      return jsonb_build_object(
        'outcome', 'ALREADY_RECORDED',
        'reviewDecisionId', v_existing.review_decision_id,
        'requestId', v_existing.request_id,
        -- Returned verbatim: the stored bytes ARE the recorded decision time.
        'decisionTimestamp', v_existing.decision_timestamp,
        'presentationSnapshotId', v_existing_snap,
        'canonicalPayloadHash', v_existing.canonical_payload_hash
      );
    end if;

    return jsonb_build_object(
      'outcome', 'IDEMPOTENCY_CONFLICT',
      'reviewDecisionId', v_existing.review_decision_id,
      'requestId', v_existing.request_id,
      'canonicalPayloadHash', v_existing.canonical_payload_hash,
      'detail', 'this requestId already recorded a different logical decision'
    );
  end if;

  -- recheck the immutable QualificationInput identity ----------------------
  -- This is the TOCTOU close: TypeScript read the observation, derived a
  -- packet and asked a human. By the time the answer arrives, the row must
  -- still be the SAME observation, byte-for-byte. The FK alone would only
  -- prove that SOME row with that scan_id exists.
  --
  -- WHAT THIS PROVES: input_hash is an INTEGRITY identity -- "this is the
  -- exact persisted representation that was reviewed". It is NOT a semantic
  -- claim that two different payloads would qualify identically.
  select input_hash into v_stored_hash
    from public.qualification_inputs
   where scan_id = p_scan_id;

  if not found then
    return jsonb_build_object('outcome', 'QUALIFICATION_INPUT_NOT_FOUND',
      'detail', 'no immutable qualification input exists for that scan_id');
  end if;

  if v_stored_hash <> p_expected_input_hash then
    return jsonb_build_object('outcome', 'QUALIFICATION_INPUT_HASH_MISMATCH',
      'detail', 'the stored observation is not the one that was reviewed');
  end if;

  -- snapshot presence must match the decision type exactly -----------------
  if v_decision_type = 'APPROVE_PRESENTATION' and not v_has_snapshot then
    return jsonb_build_object('outcome', 'SNAPSHOT_REQUIRED_FOR_APPROVAL',
      'detail', 'an approval without its snapshot would authorize nothing consumable');
  end if;

  if v_decision_type <> 'APPROVE_PRESENTATION' and v_has_snapshot then
    return jsonb_build_object('outcome', 'SNAPSHOT_FORBIDDEN_FOR_DECISION',
      'detail', format('a %s decision produces no presentation snapshot', v_decision_type));
  end if;

  -- a REVOKE must name an existing decision --------------------------------
  if v_decision_type = 'REVOKE' then
    if not exists (
      select 1 from public.review_decisions
       where review_decision_id = (p_decision ->> 'revokesReviewDecisionId')::uuid
    ) then
      return jsonb_build_object('outcome', 'REVOKE_TARGET_NOT_FOUND',
        'detail', 'the decision being revoked is not on record');
    end if;
  end if;

  -- the pair must describe the same binding --------------------------------
  if v_has_snapshot then
    -- The snapshot must have been derived against THIS decision.
    -- presentationSnapshotId is content-addressed on reviewDecisionId
    -- (deterministicSnapshotId), so a snapshot built against a different
    -- decision would be stored under a link that contradicts its own id.
    -- The insert below uses the decision's real id either way, which is
    -- exactly why the disagreement has to be caught here rather than relied
    -- upon to surface later.
    if (p_snapshot ->> 'reviewDecisionId') is distinct from (p_decision ->> 'reviewDecisionId') then
      return jsonb_build_object('outcome', 'SNAPSHOT_BINDING_MISMATCH',
        'detail', 'the snapshot was derived against a different decision id');
    end if;

    if (p_snapshot ->> 'opportunityKey')      is distinct from (p_decision ->> 'opportunityKey')
    or (p_snapshot ->> 'evidenceFingerprint') is distinct from (p_decision ->> 'evidenceFingerprint')
    or (p_snapshot ->> 'claimHash')           is distinct from (p_decision ->> 'claimHash')
    or (p_snapshot ->> 'reviewPacketHash')    is distinct from (p_decision ->> 'reviewPacketHash')
    or (p_snapshot ->> 'sourceScanId')        is distinct from p_scan_id::text
    then
      return jsonb_build_object('outcome', 'SNAPSHOT_BINDING_MISMATCH',
        'detail', 'snapshot and decision do not describe the same binding');
    end if;
  end if;

  -- the approved content itself must be present ----------------------------
  if v_has_snapshot then
    v_snapshot_id := p_snapshot ->> 'presentationSnapshotId';
    if v_snapshot_id is null
       or p_snapshot -> 'canonicalClaim' is null
       or p_snapshot -> 'demonstration' is null then
      return jsonb_build_object('outcome', 'MALFORMED_INPUT',
        'detail', 'snapshot requires presentationSnapshotId, canonicalClaim and demonstration');
    end if;
  end if;

  -- ── the atomic write ─────────────────────────────────────────────────────
  -- Both inserts are in ONE function body, hence one transaction. If the
  -- snapshot insert fails, the decision insert is rolled back with it: there
  -- is no state in which an approval exists without its snapshot.
  --
  -- Columns are extracted EXPLICITLY, one at a time. jsonb_populate_record
  -- would silently accept whatever keys the payload happened to carry; this
  -- stores exactly the fields this migration declares and nothing else.
  --
  -- decision_timestamp is NOT supplied: the column default generates it.
  insert into public.review_decisions (
    review_decision_id,
    request_id,
    decision_type,
    reviewer_user_id,
    reviewer_capability,
    opportunity_key,
    evidence_fingerprint,
    claim_hash,
    review_packet_hash,
    review_contract_version,
    qualification_version,
    hra_version,
    presentation_mode,
    demonstrability,
    temporal_frame,
    reviewed_prose_hash,
    decision_timestamp,
    structured_rejection_reason,
    bounded_reviewer_note,
    revokes_review_decision_id,
    canonical_payload_hash,
    source_scan_id,
    qualification_input_hash
  )
  values (
    (p_decision ->> 'reviewDecisionId')::uuid,
    v_request_id,
    v_decision_type,
    (p_decision ->> 'reviewerId')::uuid,
    p_decision ->> 'reviewerCapability',
    p_decision ->> 'opportunityKey',
    p_decision ->> 'evidenceFingerprint',
    p_decision ->> 'claimHash',
    p_decision ->> 'reviewPacketHash',
    p_decision ->> 'reviewContractVersion',
    p_decision ->> 'qualificationVersion',
    p_decision ->> 'hraVersion',
    p_decision ->> 'presentationMode',
    p_decision ->> 'demonstrability',
    p_decision ->> 'temporalFrame',
    p_decision ->> 'reviewedProseHash',
    v_timestamp,
    p_decision ->> 'structuredRejectionReason',
    p_decision ->> 'boundedReviewerNote',
    (p_decision ->> 'revokesReviewDecisionId')::uuid,
    p_canonical_payload_hash,
    p_scan_id,
    p_expected_input_hash
  )
  returning review_decision_id into v_decision_id;

  if v_has_snapshot then
    insert into public.presentation_snapshots (
      presentation_snapshot_id,
      review_decision_id,
      opportunity_key,
      evidence_fingerprint,
      claim_hash,
      review_packet_hash,
      canonical_claim,
      demonstration,
      reviewed_prose_hash,
      supporting_evidence_refs_digest,
      presentation_mode,
      demonstrability,
      temporal_frame,
      observed_at,
      review_contract_version,
      qualification_version,
      hra_version,
      source_scan_id
    )
    values (
      v_snapshot_id,
      v_decision_id,
      p_snapshot ->> 'opportunityKey',
      p_snapshot ->> 'evidenceFingerprint',
      p_snapshot ->> 'claimHash',
      p_snapshot ->> 'reviewPacketHash',
      p_snapshot -> 'canonicalClaim',
      p_snapshot -> 'demonstration',
      p_snapshot ->> 'reviewedProseHash',
      p_snapshot ->> 'supportingEvidenceRefsDigest',
      p_snapshot ->> 'presentationMode',
      p_snapshot ->> 'demonstrability',
      p_snapshot ->> 'temporalFrame',
      p_snapshot ->> 'observedAt',
      p_snapshot ->> 'reviewContractVersion',
      p_snapshot ->> 'qualificationVersion',
      p_snapshot ->> 'hraVersion',
      p_scan_id
    );
  end if;

  return jsonb_build_object(
    'outcome', 'RECORDED',
    'reviewDecisionId', v_decision_id,
    'requestId', v_request_id,
    'decisionTimestamp', v_timestamp,
    'presentationSnapshotId', v_snapshot_id,
    'canonicalPayloadHash', p_canonical_payload_hash
  );

exception
  -- A concurrent caller committed the same request_id between the lookup
  -- above and this insert. The UNIQUE constraint, not the application, is what
  -- makes that safe. Re-read and answer as the idempotent path would have.
  when unique_violation then
    select * into v_existing
      from public.review_decisions
     where request_id = v_request_id;

    if not found then
      -- The collision was on something other than request_id. Do not guess.
      raise;
    end if;

    if v_existing.canonical_payload_hash <> p_canonical_payload_hash then
      return jsonb_build_object(
        'outcome', 'IDEMPOTENCY_CONFLICT',
        'reviewDecisionId', v_existing.review_decision_id,
        'requestId', v_existing.request_id,
        'canonicalPayloadHash', v_existing.canonical_payload_hash,
        'detail', 'concurrent request recorded a different logical decision'
      );
    end if;

    select presentation_snapshot_id into v_existing_snap
      from public.presentation_snapshots
     where review_decision_id = v_existing.review_decision_id;

    return jsonb_build_object(
      'outcome', 'ALREADY_RECORDED',
      'reviewDecisionId', v_existing.review_decision_id,
      'requestId', v_existing.request_id,
      'decisionTimestamp', v_existing.decision_timestamp,
      'presentationSnapshotId', v_existing_snap,
      'canonicalPayloadHash', v_existing.canonical_payload_hash
    );
end;
$fn$;


-- ── function privileges ─────────────────────────────────────────────────────
-- PostgreSQL grants EXECUTE on a new function to PUBLIC by default, and in
-- Supabase PUBLIC includes anon and authenticated -- which means a freshly
-- created RPC is reachable from any browser holding the anon key unless this
-- is done explicitly. Revoke from PUBLIC first, then grant narrowly.

revoke all on function public.record_presentation_review(jsonb, jsonb, uuid, text, text) from public;
revoke all on function public.record_presentation_review(jsonb, jsonb, uuid, text, text) from anon;
revoke all on function public.record_presentation_review(jsonb, jsonb, uuid, text, text) from authenticated;

grant execute on function public.record_presentation_review(jsonb, jsonb, uuid, text, text) to service_role;

-- The trigger functions are not usefully callable outside a trigger, but the
-- same PUBLIC default applies, so it is closed here too.
revoke all on function public.refuse_review_decision_mutation() from public;
revoke all on function public.refuse_presentation_snapshot_mutation() from public;

comment on function public.record_presentation_review(jsonb, jsonb, uuid, text, text) is
  'Sole write path for human review decisions. Records one decision and, for APPROVE_PRESENTATION only, its snapshot, atomically. Rechecks the immutable QualificationInput identity (scan_id + input_hash). Enforces integrity and atomicity only -- it does NOT evaluate capability, versions, binding or status, which are TypeScript policy.';


-- ── verification guard ──────────────────────────────────────────────────────
-- Abort the transaction unless every enforcement mechanism is in place, so
-- these tables can never exist without their immutability, and the RPC can
-- never exist reachable from a browser role.

DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.review_decisions'::regclass
       AND tgname  = 'review_decisions_immutable'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'Migration 011 failed: review_decisions_immutable trigger not present';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.presentation_snapshots'::regclass
       AND tgname  = 'presentation_snapshots_immutable'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'Migration 011 failed: presentation_snapshots_immutable trigger not present';
  END IF;

  IF has_function_privilege('anon',
       'public.record_presentation_review(jsonb, jsonb, uuid, text, text)', 'EXECUTE')
  OR has_function_privilege('authenticated',
       'public.record_presentation_review(jsonb, jsonb, uuid, text, text)', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'Migration 011 failed: record_presentation_review is executable by a browser-facing role';
  END IF;

  IF NOT has_function_privilege('service_role',
       'public.record_presentation_review(jsonb, jsonb, uuid, text, text)', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'Migration 011 failed: service_role cannot execute record_presentation_review';
  END IF;
END $guard$;

COMMIT;

-- ---------------------------------------------------------------------------
-- POST-MIGRATION VERIFICATION (run separately, after COMMIT)
-- ---------------------------------------------------------------------------

-- 1. Both immutability triggers present and enabled. Expect two rows, tgenabled = 'O'.
SELECT c.relname, t.tgname, t.tgenabled
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
 WHERE c.relname IN ('review_decisions', 'presentation_snapshots')
   AND NOT t.tgisinternal
 ORDER BY c.relname;

-- 2. No UPDATE or DELETE privilege for the API roles. Expect zero rows.
SELECT table_name, grantee, privilege_type
  FROM information_schema.role_table_grants
 WHERE table_schema = 'public'
   AND table_name IN ('review_decisions', 'presentation_snapshots')
   AND privilege_type IN ('UPDATE', 'DELETE')
   AND grantee IN ('service_role', 'authenticated', 'anon');

-- 3. No INSERT privilege for the browser-facing roles. Expect zero rows.
SELECT table_name, grantee, privilege_type
  FROM information_schema.role_table_grants
 WHERE table_schema = 'public'
   AND table_name IN ('review_decisions', 'presentation_snapshots')
   AND privilege_type = 'INSERT'
   AND grantee IN ('authenticated', 'anon');

-- 4. RLS enabled on both tables. Expect rls_enabled = true twice.
SELECT relname, relrowsecurity AS rls_enabled
  FROM pg_class
 WHERE oid IN ('public.review_decisions'::regclass,
               'public.presentation_snapshots'::regclass);

-- 5. RPC execute privilege. Expect service_role = true, the other two false.
SELECT
  has_function_privilege('service_role',
    'public.record_presentation_review(jsonb, jsonb, uuid, text, text)', 'EXECUTE') AS service_role,
  has_function_privilege('authenticated',
    'public.record_presentation_review(jsonb, jsonb, uuid, text, text)', 'EXECUTE') AS authenticated,
  has_function_privilege('anon',
    'public.record_presentation_review(jsonb, jsonb, uuid, text, text)', 'EXECUTE') AS anon;

-- 6. The RPC is SECURITY INVOKER with a pinned search_path.
--    Expect prosecdef = false and proconfig containing search_path.
SELECT proname, prosecdef, proconfig
  FROM pg_proc
 WHERE proname = 'record_presentation_review';

-- 7. No mutable approval state leaked into either table. Expect zero rows.
SELECT table_name, column_name
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name IN ('review_decisions', 'presentation_snapshots')
   AND column_name IN ('approved', 'status', 'current', 'active',
                       'is_revoked', 'superseded', 'is_approved');

-- 8. Immutability smoke test. Both statements must FAIL with
--    'is append-only' / 'is immutable'. Run inside a transaction and roll
--    back, so nothing is touched even if enforcement were somehow absent.
-- BEGIN;
--   UPDATE public.review_decisions SET reviewed_prose_hash = reviewed_prose_hash;
--   DELETE FROM public.review_decisions;
--   UPDATE public.presentation_snapshots SET claim_hash = claim_hash;
--   DELETE FROM public.presentation_snapshots;
-- ROLLBACK;
