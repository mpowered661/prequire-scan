// Phase 2b-B — immutable decision + snapshot persistence.
//
// The behavioural tests drive the wrapper against a stubbed RPC: migration 011
// is NOT APPLIED, so nothing here touches a database. The schema tests read the
// migration as text and assert its structure. Both kinds are stated as what
// they prove, never as proof the SQL executes.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { deriveDecisionStatus } from '../human-review/approval-status';
import { reviewPacketHash } from '../human-review/packet-hash';
import { canonicalDecisionPayloadHash, EXCLUDED_FROM_CANONICAL_PAYLOAD } from '../human-review/idempotency';
import { derivePresentationSnapshotFromDecision, deterministicSnapshotId } from '../human-review/snapshot';
import { UNSAFE_testOnlyDecision, UNSAFE_testOnlyTrustedReviewer } from '../human-review/test-only-fixtures';
import type { PresentationSnapshotRecord, ReviewDecisionRecord, ReviewPacketView } from '../human-review/types';
import { qualify } from '../opportunity-qualification/qualify';
import type { QualificationInput } from '../opportunity-qualification/types';
import { deriveReview, type QualificationResultView } from '../opportunity-review/review-packet';
import { toReviewPacketView } from './packet-view';
import {
  recordPresentationReview,
  UNSAFE_setPersistenceClientForTests,
  type RecordReviewOutcome,
} from './review-persistence';

const SQL = readFileSync(
  new URL('../../migrations/011-human-review-persistence.sql', import.meta.url), 'utf8');
/** Comment-stripped, so an assertion cannot be satisfied by prose. */
const STATEMENTS = SQL.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');

const FIXTURE = JSON.parse(readFileSync(
  new URL('../opportunity-qualification/__fixtures__/michael-pilot.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
function fixtureInput(): QualificationInput {
  const { _provenance, ...rest } = FIXTURE;
  return JSON.parse(JSON.stringify(rest)) as QualificationInput;
}
const review = deriveReview(qualify(fixtureInput()) as unknown as QualificationResultView);
const bySubject = new Map(review.packets.map(p => [p.subject, p]));

const SCAN_ID = '3f7a1c42-9b0e-4d6a-8c21-5e9f0a1b2c3d';
const INPUT_HASH = 'a'.repeat(64);
const REVIEWER = UNSAFE_testOnlyTrustedReviewer('8f14e45f-ceea-467a-9a36-dedd4bea2543');
const DECISION_ID = '11111111-2222-4333-8444-555555555555';

/** An approvable packet from the real fixture, not a hand-built stub. */
function approvablePacket(): ReviewPacketView {
  const packet = bySubject.get('https://michaelhingson.com/about/');
  if (!packet) throw new Error('fixture packet missing');
  return toReviewPacketView(packet);
}

function approveDecision(over: Partial<ReviewDecisionRecord> = {}): ReviewDecisionRecord {
  return UNSAFE_testOnlyDecision({
    decisionType: 'APPROVE_PRESENTATION',
    packet: approvablePacket(),
    reviewDecisionId: DECISION_ID,
    requestId: 'req-0001',
    reviewer: REVIEWER,
    override: over,
  });
}

/** Derived through the frozen pipeline, so the pair is exact by construction. */
function approveSnapshot(decision: ReviewDecisionRecord): PresentationSnapshotRecord {
  const packet = approvablePacket();
  const derivation = derivePresentationSnapshotFromDecision({
    packet,
    decision,
    allDecisions: [decision],
    presentationSnapshotId: deterministicSnapshotId(
      decision.reviewDecisionId, packet.claimHash,
      packet.evidenceFingerprint, decision.reviewPacketHash),
  });
  if (!derivation.snapshot) {
    throw new Error(`snapshot did not derive: ${JSON.stringify(derivation.failures)}`);
  }
  return derivation.snapshot;
}

// ── RPC stub ────────────────────────────────────────────────────────────────

interface RpcCall { name: string; args: Record<string, unknown> }
let calls: RpcCall[] = [];

function stubRpc(reply: { data?: unknown; error?: { message: string } } | (() => never)) {
  UNSAFE_setPersistenceClientForTests({
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      // Narrowed with an early return: `reply()` returns never, but that does
      // not narrow `reply` itself, so the union must be discriminated here.
      if (typeof reply !== 'function') {
        return Promise.resolve({ data: reply.data ?? null, error: reply.error ?? null });
      }
      return reply();
    },
  });
}

function recordedReply(over: Record<string, unknown> = {}) {
  return {
    data: {
      outcome: 'RECORDED',
      reviewDecisionId: DECISION_ID,
      requestId: 'req-0001',
      decisionTimestamp: '2026-09-30T18:00:00.000Z',
      presentationSnapshotId: null,
      canonicalPayloadHash: 'b'.repeat(64),
      ...over,
    },
  };
}

beforeEach(() => {
  calls = [];
  UNSAFE_setPersistenceClientForTests(null);
});

describe('2b-B wrapper behaviour', () => {
  it('1 an approval sends the decision, the snapshot and the evidence recheck', async () => {
    const decision = approveDecision();
    const snapshot = approveSnapshot(decision);
    stubRpc(recordedReply({ presentationSnapshotId: snapshot.presentationSnapshotId }));

    const out = await recordPresentationReview({
      decision, snapshot, scanId: SCAN_ID, expectedInputHash: INPUT_HASH,
    });

    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('record_presentation_review');
    expect(calls[0].args.p_scan_id).toBe(SCAN_ID);
    expect(calls[0].args.p_expected_input_hash).toBe(INPUT_HASH);
    expect(calls[0].args.p_snapshot).not.toBeNull();
    if (out.ok) expect(out.presentationSnapshotId).toBe(snapshot.presentationSnapshotId);
  });

  it('2 the canonical payload hash is the frozen one, not a local invention', async () => {
    const decision = approveDecision();
    stubRpc(recordedReply());
    await recordPresentationReview({
      decision, snapshot: approveSnapshot(decision), scanId: SCAN_ID, expectedInputHash: INPUT_HASH,
    });
    expect(calls[0].args.p_canonical_payload_hash)
      .toBe(canonicalDecisionPayloadHash(decision));
  });

  it('3 a REJECT sends no snapshot', async () => {
    const decision = UNSAFE_testOnlyDecision({
      decisionType: 'REJECT',
      packet: approvablePacket(),
      reviewDecisionId: DECISION_ID,
      requestId: 'req-reject',
      reviewer: REVIEWER,
      structuredRejectionReason: 'evidence_not_convincing',
    });
    stubRpc(recordedReply({ requestId: 'req-reject' }));

    const out = await recordPresentationReview({
      decision, snapshot: null, scanId: SCAN_ID, expectedInputHash: INPUT_HASH,
    });

    expect(out.ok).toBe(true);
    expect(calls[0].args.p_snapshot).toBeNull();
    if (out.ok) expect(out.presentationSnapshotId).toBeNull();
  });

  it('4 a REVOKE sends no snapshot and carries its target', async () => {
    const decision = UNSAFE_testOnlyDecision({
      decisionType: 'REVOKE',
      packet: approvablePacket(),
      reviewDecisionId: '99999999-2222-4333-8444-555555555555',
      requestId: 'req-revoke',
      reviewer: REVIEWER,
      revokesReviewDecisionId: DECISION_ID,
    });
    stubRpc(recordedReply({ requestId: 'req-revoke' }));

    const out = await recordPresentationReview({
      decision, snapshot: null, scanId: SCAN_ID, expectedInputHash: INPUT_HASH,
    });

    expect(out.ok).toBe(true);
    expect(calls[0].args.p_snapshot).toBeNull();
    const sent = calls[0].args.p_decision as Record<string, unknown>;
    expect(sent.revokesReviewDecisionId).toBe(DECISION_ID);
  });

  it('5 the decision timestamp is normalized before it is sent', async () => {
    const decision = approveDecision({ decisionTimestamp: '2026-09-30T18:00:00Z' });
    stubRpc(recordedReply());
    await recordPresentationReview({
      decision, snapshot: null, scanId: SCAN_ID, expectedInputHash: INPUT_HASH,
    });
    const sent = calls[0].args.p_decision as Record<string, unknown>;
    expect(sent.decisionTimestamp).toBe('2026-09-30T18:00:00.000Z');
  });
});

describe('2b-B wrapper fails closed', () => {
  it('6 every RPC failure outcome maps to a distinct fail-closed code', async () => {
    const cases: [string, string][] = [
      ['IDEMPOTENCY_CONFLICT', 'idempotency_conflict'],
      ['QUALIFICATION_INPUT_NOT_FOUND', 'qualification_input_not_found'],
      ['QUALIFICATION_INPUT_HASH_MISMATCH', 'qualification_input_hash_mismatch'],
      ['SNAPSHOT_REQUIRED_FOR_APPROVAL', 'snapshot_required_for_approval'],
      ['SNAPSHOT_FORBIDDEN_FOR_DECISION', 'snapshot_forbidden_for_decision'],
      ['SNAPSHOT_BINDING_MISMATCH', 'snapshot_binding_mismatch'],
      ['REVOKE_TARGET_NOT_FOUND', 'revoke_target_not_found'],
      ['DECISION_TIMESTAMP_OUT_OF_BOUNDS', 'decision_timestamp_out_of_bounds'],
      ['MALFORMED_INPUT', 'malformed_input'],
    ];
    for (const [outcome, code] of cases) {
      stubRpc({ data: { outcome, detail: 'because' } });
      const out: RecordReviewOutcome = await recordPresentationReview({
        decision: approveDecision(), snapshot: null,
        scanId: SCAN_ID, expectedInputHash: INPUT_HASH,
      });
      expect(out.ok, outcome).toBe(false);
      if (!out.ok) expect(out.code, outcome).toBe(code);
    }
  });

  it('7 an identical retry reports ALREADY_RECORDED with the original identity', async () => {
    stubRpc({
      data: {
        outcome: 'ALREADY_RECORDED',
        reviewDecisionId: DECISION_ID,
        requestId: 'req-0001',
        decisionTimestamp: '2026-09-30T18:00:00.000Z',
        presentationSnapshotId: 'c'.repeat(32),
        canonicalPayloadHash: 'b'.repeat(64),
      },
    });
    const out = await recordPresentationReview({
      decision: approveDecision(), snapshot: null,
      scanId: SCAN_ID, expectedInputHash: INPUT_HASH,
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.outcome).toBe('ALREADY_RECORDED');
      expect(out.reviewDecisionId).toBe(DECISION_ID);
      expect(out.decisionTimestamp).toBe('2026-09-30T18:00:00.000Z');
    }
  });

  it('8 a transport error and a thrown client both fail closed', async () => {
    stubRpc({ error: { message: 'connection reset' } });
    const a = await recordPresentationReview({
      decision: approveDecision(), snapshot: null, scanId: SCAN_ID, expectedInputHash: INPUT_HASH,
    });
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.code).toBe('transport_error');

    stubRpc(() => { throw new Error('socket hang up'); });
    const b = await recordPresentationReview({
      decision: approveDecision(), snapshot: null, scanId: SCAN_ID, expectedInputHash: INPUT_HASH,
    });
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.code).toBe('transport_error');
  });

  it('9 a malformed or unrecognized response is never success', async () => {
    const bad: unknown[] = [null, 'RECORDED', 42, [], {}, { outcome: 'RECORDED' }];
    for (const data of bad) {
      stubRpc({ data });
      const out = await recordPresentationReview({
        decision: approveDecision(), snapshot: null, scanId: SCAN_ID, expectedInputHash: INPUT_HASH,
      });
      expect(out.ok, JSON.stringify(data)).toBe(false);
    }

    // An outcome a FUTURE migration might add must not be read as success.
    stubRpc({ data: { outcome: 'SOME_NEW_OUTCOME' } });
    const future = await recordPresentationReview({
      decision: approveDecision(), snapshot: null, scanId: SCAN_ID, expectedInputHash: INPUT_HASH,
    });
    expect(future.ok).toBe(false);
    if (!future.ok) expect(future.code).toBe('unrecognized_outcome');
  });

  it('10 missing credentials are a configuration fault, not a transport fault', async () => {
    UNSAFE_setPersistenceClientForTests(null);
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    try {
      const out = await recordPresentationReview({
        decision: approveDecision(), snapshot: null, scanId: SCAN_ID, expectedInputHash: INPUT_HASH,
      });
      // A configuration fault, reported as itself -- NOT as transport_error,
      // which would point an operator at the network instead of the deploy.
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.code).toBe('persistence_not_configured');
        expect(out.detail).toContain('SUPABASE_SERVICE_ROLE_KEY');
      }
    } finally {
      if (url !== undefined) process.env.NEXT_PUBLIC_SUPABASE_URL = url;
      if (key !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = key;
    }
  });
});

/**
 * The column names a create-table block DECLARES, so an assertion about the
 * schema cannot be satisfied or broken by prose in a comment or by a string
 * literal elsewhere in the file.
 */
function declaredColumns(table: string): string[] {
  const start = STATEMENTS.indexOf(`create table if not exists public.${table} (`);
  if (start < 0) throw new Error(`no create table for ${table}`);
  let depth = 0;
  let end = start;
  for (let i = STATEMENTS.indexOf('(', start); i < STATEMENTS.length; i += 1) {
    if (STATEMENTS[i] === '(') depth += 1;
    if (STATEMENTS[i] === ')') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  const body = STATEMENTS.slice(STATEMENTS.indexOf('(', start) + 1, end);
  const names: string[] = [];
  let nesting = 0;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    const before = nesting;
    nesting += (line.match(/\(/g) ?? []).length - (line.match(/\)/g) ?? []).length;
    if (before !== 0) continue;
    const m = /^([a-z_][a-z0-9_]*)\s+(uuid|text|jsonb|timestamptz|boolean|integer)\b/.exec(line);
    if (m) names.push(m[1]);
  }
  return names;
}

// ── schema structure ────────────────────────────────────────────────────────
// These read migration 011 as TEXT. They prove what the file DECLARES. They do
// NOT prove the SQL executes: migration 011 is NOT APPLIED and no PostgreSQL
// instance is reachable from this suite.

describe('migration 011 structure', () => {
  it('11 is marked NOT APPLIED and creates exactly the two intended tables', () => {
    expect(SQL).toContain('*** NOT APPLIED. ***');
    expect(STATEMENTS).toContain('create table if not exists public.review_decisions');
    expect(STATEMENTS).toContain('create table if not exists public.presentation_snapshots');
    const created = STATEMENTS.match(/create table[^(]*/g) ?? [];
    expect(created).toHaveLength(2);
  });

  it('12 migration 009 is also still marked NOT APPLIED', () => {
    const nine = readFileSync(
      new URL('../../migrations/009-qualification-inputs.sql', import.meta.url), 'utf8');
    expect(nine).toContain('*** NOT APPLIED. ***');
  });

  it('13 neither table DECLARES a mutable approval state column', () => {
    // Asserted against the declared column names, not against any textual
    // occurrence: the words "approved" and "status" appear legitimately in a
    // comment on table and in the post-migration verification query.
    for (const table of ['review_decisions', 'presentation_snapshots']) {
      const cols = declaredColumns(table);
      expect(cols.length, table).toBeGreaterThan(5);
      for (const forbidden of ['approved', 'is_approved', 'status', 'current',
        'active', 'is_revoked', 'superseded', 'state']) {
        expect(cols, `${table}.${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('14 reviewer_user_id is a plain uuid with NO foreign key and NO cascade', () => {
    expect(STATEMENTS).toContain('reviewer_user_id uuid not null,');
    // The whole file must not cascade, to any table.
    expect(STATEMENTS.toLowerCase()).not.toContain('on delete cascade');
    expect(STATEMENTS.toLowerCase()).not.toContain('on delete set null');
    // and reviewer_user_id specifically must not reference auth.users
    expect(STATEMENTS).not.toMatch(/reviewer_user_id[^,]*references/);
    // the reasoning is recorded, not just the behaviour
    expect(SQL).toContain('RULING 2');
  });

  it('15 both tables are append-only by trigger, not merely by policy', () => {
    for (const table of ['review_decisions', 'presentation_snapshots']) {
      expect(STATEMENTS).toContain(`create trigger ${table}_immutable`);
      expect(STATEMENTS).toMatch(
        new RegExp(`before update or delete on public\.${table}`));
      for (const role of ['service_role', 'authenticated', 'anon']) {
        expect(STATEMENTS, `${table}/${role}`)
          .toContain(`revoke update, delete on public.${table} from ${role};`);
      }
      expect(STATEMENTS).toContain(`alter table public.${table} enable row level security`);
    }
    expect(STATEMENTS).toContain('restrict_violation');
    // No UPDATE or DELETE policy may exist on either table.
    expect(STATEMENTS).not.toMatch(/create policy[^;]*for update/i);
    expect(STATEMENTS).not.toMatch(/create policy[^;]*for delete/i);
  });

  it('16 direct INSERT is removed from the browser-facing roles', () => {
    for (const table of ['review_decisions', 'presentation_snapshots']) {
      for (const role of ['authenticated', 'anon']) {
        expect(STATEMENTS, `${table}/${role}`)
          .toContain(`revoke insert on public.${table} from ${role};`);
      }
    }
  });

  it('17 both tables are bound to the immutable qualification input by FK', () => {
    const refs = STATEMENTS.match(/references public\.qualification_inputs\(scan_id\)/g) ?? [];
    expect(refs).toHaveLength(2);
  });

  it('18 the decision timestamp is normalized text, with the DB clock kept separately', () => {
    expect(STATEMENTS).toContain('decision_timestamp text not null');
    expect(STATEMENTS).not.toContain('decision_timestamp timestamptz');
    expect(STATEMENTS).toContain('recorded_at timestamptz not null default now()');
    // exactly three fractional digits, so lexicographic order matches orderDecisions
    expect(STATEMENTS).toContain('[0-9]{3}Z$');
  });

  it('19 review_decision_id is supplied, never defaulted', () => {
    expect(STATEMENTS).toContain('review_decision_id uuid primary key,');
    expect(STATEMENTS).not.toMatch(/review_decision_id uuid primary key default/);
  });
});

describe('migration 011 RPC', () => {
  const SIG = 'public.record_presentation_review(jsonb, jsonb, uuid, text, text)';

  it('20 is SECURITY INVOKER with a pinned search_path', () => {
    expect(STATEMENTS).toContain('security invoker');
    expect(STATEMENTS).not.toContain('security definer');
    expect(STATEMENTS).toContain('set search_path = public, pg_temp');
  });

  it('21 is not executable by PUBLIC, anon or authenticated', () => {
    // PostgreSQL grants EXECUTE to PUBLIC by default, so this must be explicit.
    for (const role of ['public', 'anon', 'authenticated']) {
      expect(STATEMENTS, role).toContain(`revoke all on function ${SIG} from ${role};`);
    }
    expect(STATEMENTS).toContain(`grant execute on function ${SIG} to service_role;`);
    // the trigger functions carry the same PUBLIC default
    expect(STATEMENTS).toContain('revoke all on function public.refuse_review_decision_mutation() from public;');
    expect(STATEMENTS).toContain('revoke all on function public.refuse_presentation_snapshot_mutation() from public;');
  });

  it('21b the snapshot must have been derived against this exact decision', () => {
    expect(STATEMENTS).toContain(
      "if (p_snapshot ->> 'reviewDecisionId') is distinct from (p_decision ->> 'reviewDecisionId') then");
    expect(STATEMENTS).toContain('the snapshot was derived against a different decision id');
  });

  it('22 rechecks the immutable qualification input identity inside the write', () => {
    expect(STATEMENTS).toContain('select input_hash into v_stored_hash');
    expect(STATEMENTS).toContain('from public.qualification_inputs');
    expect(STATEMENTS).toContain('if v_stored_hash <> p_expected_input_hash then');
    expect(STATEMENTS).toContain('QUALIFICATION_INPUT_HASH_MISMATCH');
    expect(STATEMENTS).toContain('QUALIFICATION_INPUT_NOT_FOUND');
  });

  it('23 writes the decision and the snapshot in one function body', () => {
    const decisionAt = STATEMENTS.indexOf('insert into public.review_decisions');
    const snapshotAt = STATEMENTS.indexOf('insert into public.presentation_snapshots');
    const bodyEnd = STATEMENTS.indexOf('$fn$;', decisionAt);
    expect(decisionAt).toBeGreaterThan(0);
    expect(snapshotAt).toBeGreaterThan(decisionAt);
    expect(snapshotAt).toBeLessThan(bodyEnd);
    // exactly one insert per table, so there is no second uncoordinated write
    expect((STATEMENTS.match(/insert into public\.review_decisions/g) ?? [])).toHaveLength(1);
    expect((STATEMENTS.match(/insert into public\.presentation_snapshots/g) ?? [])).toHaveLength(1);
  });

  it('24 resolves a concurrent duplicate request through the unique constraint', () => {
    expect(STATEMENTS).toContain('when unique_violation then');
    expect(STATEMENTS).toContain('request_id text not null unique');
    // and it does not guess when the collision was on something else
    expect(STATEMENTS).toContain('raise;');
  });

  it('25 never re-evaluates TypeScript policy', () => {
    // No version acceptance, capability decision, eligibility or status
    // derivation may be encoded in SQL.
    for (const forbidden of ['or-0.1', 'oq-0.1.1', 'hra-0.1',
      'ELIGIBLE_FOR_HUMAN_APPROVAL', 'APPROVED_CURRENT', 'operator_capabilities',
      'QUALIFIED', 'PRESENTABLE']) {
      expect(STATEMENTS, forbidden).not.toContain(forbidden);
    }
  });

  it('26 refuses to store a state the frozen model cannot express', () => {
    for (const state of ['APPROVE_WITH_EDIT', 'REQUEST_MORE_EVIDENCE',
      'APPROVED_FOR_OUTREACH', 'EMAIL_READY', 'SEND_READY', 'CONTACT_READY',
      'CRM_READY', 'BEFORE', 'AFTER', 'IMPROVED', 'FIXED', 'VERIFIED']) {
      expect(STATEMENTS, state).not.toContain(state);
    }
    expect(STATEMENTS).toContain("check (temporal_frame = 'CURRENT_STATE')");
  });
});

/** The column list of an INSERT, in declaration order. */
function insertColumns(table: string): string[] {
  const at = STATEMENTS.indexOf(`insert into public.${table} (`);
  const open = STATEMENTS.indexOf('(', at);
  const close = STATEMENTS.indexOf(')', open);
  return STATEMENTS.slice(open + 1, close)
    .split(',').map(c => c.trim()).filter(c => c.length > 0);
}

const camelToSnake = (k: string) => k.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);

describe('every frozen field survives the round trip', () => {
  it('27 all 20 ReviewDecisionRecord fields map to a persisted column', () => {
    const decision = UNSAFE_testOnlyDecision({
      decisionType: 'REVOKE',
      packet: approvablePacket(),
      reviewDecisionId: DECISION_ID,
      requestId: 'req-all-fields',
      reviewer: REVIEWER,
      structuredRejectionReason: 'other_bounded',
      boundedReviewerNote: 'a bounded note',
      revokesReviewDecisionId: '77777777-2222-4333-8444-555555555555',
    });
    const keys = Object.keys(decision);
    expect(keys).toHaveLength(20);

    const cols = insertColumns('review_decisions');
    // reviewerId is stored as reviewer_user_id: the column names WHO, and the
    // name makes clear it is an auth user id, not an opaque reviewer handle.
    const special: Record<string, string> = { reviewerId: 'reviewer_user_id' };
    for (const key of keys) {
      expect(cols, key).toContain(special[key] ?? camelToSnake(key));
    }
    // the three columns with no frozen counterpart are the write-time evidence
    expect(cols).toContain('canonical_payload_hash');
    expect(cols).toContain('source_scan_id');
    expect(cols).toContain('qualification_input_hash');
    expect(cols).toHaveLength(23);
  });

  it('28 all 18 PresentationSnapshotRecord fields map to a persisted column', () => {
    const snapshot = approveSnapshot(approveDecision());
    const keys = Object.keys(snapshot);
    expect(keys).toHaveLength(18);

    const cols = insertColumns('presentation_snapshots');
    for (const key of keys) {
      expect(cols, key).toContain(camelToSnake(key));
    }
    expect(cols).toHaveLength(18);
  });

  it('29 the wrapper sends every field it claims to send', () => {
    const decision = approveDecision();
    const snapshot = approveSnapshot(decision);
    stubRpc(recordedReply());
    return recordPresentationReview({
      decision, snapshot, scanId: SCAN_ID, expectedInputHash: INPUT_HASH,
    }).then(() => {
      const sentDecision = calls[0].args.p_decision as Record<string, unknown>;
      const sentSnapshot = calls[0].args.p_snapshot as Record<string, unknown>;
      // 20 decision fields; the two absent optionals are sent as explicit null
      expect(Object.keys(sentDecision)).toHaveLength(20);
      expect(Object.keys(sentSnapshot)).toHaveLength(18);
      for (const key of Object.keys(snapshot)) {
        expect(sentSnapshot, key).toHaveProperty(key);
      }
    });
  });
});

describe('frozen HRA semantics are unchanged by this tranche', () => {
  it('30 the seven accepted packet hashes still reproduce exactly', () => {
    const accepted: Record<string, string> = {
      'https://michaelhingson.com/about/': 'cb4bfaa08dae48871f7b8e90a6973aef',
      'https://michaelhingson.com/accessibility-statement/': '36c27a3a7df6daa2c99e764756ccbc2c',
      'https://michaelhingson.com/author/': 'b15cd876d69396a5789eb5734cd2ed6a',
      'https://michaelhingson.com/privacy-policy/': 'eddae93ac9f2d6e81a7d758071f962b7',
      'band:fragile': 'eea163d288f2466e4eb54842061a886d',
    };
    for (const [subject, expected] of Object.entries(accepted)) {
      const packet = bySubject.get(subject);
      expect(packet, subject).toBeDefined();
      expect(reviewPacketHash(toReviewPacketView(packet!)), subject).toBe(expected);
    }
  });

  it('31 status is still derived, and a REVOKE still de-authorizes the binding', () => {
    const packet = approvablePacket();
    const approve = approveDecision();
    expect(deriveDecisionStatus([approve], packet).status).toBe('APPROVED_CURRENT');

    const revoke = UNSAFE_testOnlyDecision({
      decisionType: 'REVOKE',
      packet,
      reviewDecisionId: '88888888-2222-4333-8444-555555555555',
      requestId: 'req-revoke-2',
      reviewer: REVIEWER,
      decisionTimestamp: '2026-09-30T19:00:00.000Z',
      revokesReviewDecisionId: approve.reviewDecisionId,
    });
    expect(deriveDecisionStatus([approve, revoke], packet).status).toBe('REVOKED');
  });

  it('32 decisionTimestamp is still excluded from the canonical payload', () => {
    expect(EXCLUDED_FROM_CANONICAL_PAYLOAD).toContain('decisionTimestamp');
    const a = approveDecision({ decisionTimestamp: '2026-09-30T18:00:00.000Z' });
    const b = approveDecision({ decisionTimestamp: '2026-09-30T18:30:00.000Z' });
    // A retry differing only in timestamp is the SAME logical decision, which
    // is what lets the database bound the timestamp without breaking retries.
    expect(canonicalDecisionPayloadHash(a)).toBe(canonicalDecisionPayloadHash(b));
  });
});

describe('2b-B stays inside its boundary', () => {
  it('33 this tranche adds no route and no UI', () => {
    expect(STATEMENTS).not.toContain('site_scans');
    expect(STATEMENTS).not.toContain('page_observations');
    // Comment-stripped, exactly as trust.test.ts does it: an assertion about
    // what the code DOES must not be satisfied or broken by prose.
    const wrapper = readFileSync(new URL('./review-persistence.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n')
      .filter(l => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*')); })
      .join('\n');
    // no identity is established here, and no capability is decided here
    for (const forbidden of ['getUser', 'authenticateReviewer', 'requirePresentationApprove',
      'TrustedReviewerIdentity', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'operator_capabilities']) {
      expect(wrapper, forbidden).not.toContain(forbidden);
    }
    // and the only write is the one RPC
    expect(wrapper).not.toContain('.insert(');
    expect(wrapper).not.toContain('.update(');
    expect(wrapper).not.toContain('.delete(');
    expect(wrapper).not.toContain('.upsert(');
    expect((wrapper.match(/\.rpc\(/g) ?? [])).toHaveLength(1);
  });
});
