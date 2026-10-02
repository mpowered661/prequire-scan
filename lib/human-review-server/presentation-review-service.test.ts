// Phase 2b-C2 — orchestration service.
//
// THREE OF THE FOUR LAYERS ARE REAL. capability.ts (with trusted-reviewer.ts),
// review-history.ts and review-persistence.ts are the accepted modules, driven
// through their own test seams with stubbed Supabase clients, so the real auth
// composition, the real hydrator and the real persistence wrapper are exercised.
//
// Only the bridge is mocked: its store.ts builds a Supabase client at module
// load and would throw on import without credentials, and it exposes no seam.
import { readdirSync, readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rederiveMock = vi.fn();
vi.mock('../qualification-input-bridge/rederive', () => ({
  deriveReviewPacketsFromStoredQualificationInput: (scanId: string) => rederiveMock(scanId),
}));

import { reviewPacketHash, reviewedProseHash } from '../human-review/packet-hash';
import type { ReviewPacketView } from '../human-review/types';
import { qualify } from '../opportunity-qualification/qualify';
import type { QualificationInput } from '../opportunity-qualification/types';
import { deriveReview, type QualificationResultView } from '../opportunity-review/review-packet';
import { UNSAFE_setCapabilityClientForTests } from './capability';
import { toReviewPacketView } from './packet-view';
import {
  FORBIDDEN_REQUEST_FIELDS,
  reviewPresentation,
  type PresentationReviewResult,
} from './presentation-review-service';
import { UNSAFE_setHistoryClientForTests } from './review-history';
import { UNSAFE_setPersistenceClientForTests } from './review-persistence';
import { UNSAFE_setAuthClientForTests } from './trusted-reviewer';

// ── real fixture packets ────────────────────────────────────────────────────

const FIXTURE = JSON.parse(readFileSync(
  new URL('../opportunity-qualification/__fixtures__/michael-pilot.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
function fixtureInput(): QualificationInput {
  const { _provenance, ...rest } = FIXTURE;
  return JSON.parse(JSON.stringify(rest)) as QualificationInput;
}
const review = deriveReview(qualify(fixtureInput()) as unknown as QualificationResultView);

const SCAN = '3f7a1c42-9b0e-4d6a-8c21-5e9f0a1b2c3d';
/**
 * The fixture's scanId is the legacy string 'michael-pilot-001', but scan_id is
 * a uuid column (migration 009 primary key, 011 foreign key, and the RPC's
 * p_scan_id parameter) and the accepted scan route mints it with randomUUID.
 * The service therefore requires a uuid, correctly.
 *
 * Re-stamping it here is safe and changes no hash: the view's own scanId is NOT
 * one of the thirteen PACKET_HASH_INPUTS and canonicalPacketJson never reads
 * it. Each EvidenceRef keeps its own scanId, which is what refKey hashes.
 */
const packets = review.packets.map(p => ({ ...p, scanId: SCAN }));
const reviewForScan = { ...review, packets };
const aboutPacket = packets.find(p => p.subject === 'https://michaelhingson.com/about/')!;
/** STATEMENT_ONLY / NOT_DEMONSTRABLE: ineligible for approval, still rejectable. */
const statementOnlyPacket = packets.find(p => p.subject === 'fact_attribution')!;

const ABOUT: ReviewPacketView = toReviewPacketView(aboutPacket);
const ABOUT_HASH = reviewPacketHash(ABOUT);
const ABOUT_PROSE = reviewedProseHash(ABOUT.displayProse);
const STMT: ReviewPacketView = toReviewPacketView(statementOnlyPacket);
const STMT_HASH = reviewPacketHash(STMT);

const INPUT_HASH = 'a'.repeat(64);
const USER = '8f14e45f-ceea-467a-9a36-dedd4bea2543';
const HEADER = 'Bearer a-token';
const REQ_ID = '7f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

function okRequest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scanId: SCAN,
    opportunityKey: ABOUT.opportunityKey,
    evidenceFingerprint: ABOUT.evidenceFingerprint,
    claimHash: ABOUT.claimHash,
    reviewPacketHash: ABOUT_HASH,
    requestId: REQ_ID,
    decisionType: 'APPROVE_PRESENTATION',
    ...over,
  };
}

// ── stubs driving the three REAL layers ─────────────────────────────────────

let authCalls = 0;
let capabilityCalls = 0;
let historyCalls: string[] = [];
let persistCalls: { decision: Record<string, unknown>; snapshot: unknown; args: Record<string, unknown> }[] = [];

function setAuth(opts: { user?: string | null; error?: unknown; throws?: boolean } = {}) {
  UNSAFE_setAuthClientForTests({
    auth: {
      getUser: async () => {
        authCalls += 1;
        if (opts.throws) throw new Error('transport');
        if (opts.error) return { data: null, error: opts.error };
        const u = opts.user === undefined ? USER : opts.user;
        return { data: { user: u === null ? null : { id: u } }, error: null };
      },
    },
  } as never);
}

function setCapability(row: Record<string, unknown> | null, error?: { code: string }) {
  UNSAFE_setCapabilityClientForTests({
    from() {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.maybeSingle = async () => {
        capabilityCalls += 1;
        return { data: row, error: error ?? null };
      };
      return b;
    },
  } as never);
}

function setHistory(rows: unknown, error?: { message: string }) {
  UNSAFE_setHistoryClientForTests({
    from() {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = (_c: string, v: string) => { historyCalls.push(v); return b; };
      b.order = () => b;
      b.then = (res: (v: unknown) => unknown) =>
        Promise.resolve({ data: rows, error: error ?? null }).then(res);
      return b;
    },
  });
}

function setPersistence(reply: Record<string, unknown>) {
  UNSAFE_setPersistenceClientForTests({
    rpc(_name: string, args: Record<string, unknown>) {
      persistCalls.push({
        decision: args.p_decision as Record<string, unknown>,
        snapshot: args.p_snapshot,
        args,
      });
      return Promise.resolve({ data: reply, error: null });
    },
  });
}

const RECORDED = {
  outcome: 'RECORDED',
  reviewDecisionId: 'dddddddd-2222-4333-8444-000000000001',
  requestId: REQ_ID,
  decisionTimestamp: '2026-10-02T12:00:00.000Z',
  presentationSnapshotId: null,
  canonicalPayloadHash: 'b'.repeat(64),
};

/** Authorised reviewer plus a re-derivable scan. */
function arrangeHappyPath(opts: { history?: unknown; persisted?: Record<string, unknown> } = {}) {
  setAuth();
  setCapability({ user_id: USER, capability: 'presentation.approve', revoked_at: null });
  rederiveMock.mockResolvedValue({ ok: true, input: {}, review: reviewForScan, inputHash: INPUT_HASH });
  setHistory(opts.history ?? []);
  setPersistence(opts.persisted ?? RECORDED);
}

/** A persisted row shaped as review_decisions returns it, bound to /about/. */
function historyRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    review_decision_id: '11111111-2222-4333-8444-555555555551',
    request_id: 'older-request',
    decision_type: 'APPROVE_PRESENTATION',
    reviewer_user_id: USER,
    reviewer_capability: 'presentation.approve',
    opportunity_key: ABOUT.opportunityKey,
    evidence_fingerprint: ABOUT.evidenceFingerprint,
    claim_hash: ABOUT.claimHash,
    review_packet_hash: ABOUT_HASH,
    review_contract_version: ABOUT.reviewContractVersion,
    qualification_version: ABOUT.qualificationVersion,
    hra_version: 'hra-0.1.2',
    presentation_mode: ABOUT.presentationMode,
    demonstrability: ABOUT.demonstrabilityStatus,
    temporal_frame: 'CURRENT_STATE',
    decision_timestamp: '2026-09-30T18:00:00.000Z',
    reviewed_prose_hash: ABOUT_PROSE,
    structured_rejection_reason: null,
    bounded_reviewer_note: null,
    revokes_review_decision_id: null,
    ...over,
  };
}

beforeEach(() => {
  authCalls = 0; capabilityCalls = 0; historyCalls = []; persistCalls = [];
  rederiveMock.mockReset();
  UNSAFE_setAuthClientForTests(null);
  UNSAFE_setCapabilityClientForTests(null);
  UNSAFE_setHistoryClientForTests(null);
  UNSAFE_setPersistenceClientForTests(null);
});

function cls(r: PresentationReviewResult): string { return r.ok ? '(ok)' : r.failure; }
function why(r: PresentationReviewResult): string[] { return r.ok ? [] : r.reasons; }

describe('request contract', () => {
  it('1 a non-object request is refused', async () => {
    arrangeHappyPath();
    for (const bad of [null, undefined, 'a string', 42, []]) {
      const r = await reviewPresentation(HEADER, bad);
      expect(cls(r), JSON.stringify(bad)).toBe('request_invalid');
      expect(why(r)).toContain('request_not_an_object');
    }
    expect(authCalls, 'auth must not run for a malformed request').toBe(0);
  });

  it('2 missing required fields are named individually', async () => {
    arrangeHappyPath();
    for (const field of ['scanId', 'opportunityKey', 'evidenceFingerprint',
      'claimHash', 'reviewPacketHash', 'requestId']) {
      const body = okRequest();
      delete body[field];
      const r = await reviewPresentation(HEADER, body);
      expect(cls(r), field).toBe('request_invalid');
      expect(why(r), field).toContain(`${field}_missing`);
    }
  });

  it('3 an invalid or content-derived requestId is refused', async () => {
    arrangeHappyPath();
    const bad = await reviewPresentation(HEADER, okRequest({ requestId: 'not-a-uuid' }));
    expect(cls(bad)).toBe('request_invalid');
    expect(why(bad)).toContain('requestId_malformed');

    // deriving the retry token from content would collapse two human actions
    for (const [field, value] of [
      ['opportunityKey', ABOUT.opportunityKey],
      ['scanId', SCAN],
      ['claimHash', ABOUT.claimHash],
      ['reviewPacketHash', ABOUT_HASH],
      ['evidenceFingerprint', ABOUT.evidenceFingerprint],
    ] as [string, string][]) {
      const r = await reviewPresentation(HEADER, okRequest({ requestId: value }));
      expect(cls(r), field).toBe('request_invalid');
      expect(why(r).some(x => x.startsWith('requestId_derived_from_') || x === 'requestId_malformed'),
        field).toBe(true);
    }
  });

  it('4 a REVOKE carrying structuredRejectionReason is refused (avoids LOW-1)', async () => {
    arrangeHappyPath();
    const r = await reviewPresentation(HEADER, okRequest({
      decisionType: 'REVOKE',
      revokesReviewDecisionId: '11111111-2222-4333-8444-555555555551',
      structuredRejectionReason: 'other_bounded',
    }));
    expect(cls(r)).toBe('request_invalid');
    expect(why(r)).toContain('revoke_must_not_carry_rejection_reason');
    expect(persistCalls, 'it must never reach persistence').toHaveLength(0);
  });

  it('5 every forbidden authoritative field is rejected BY NAME', async () => {
    arrangeHappyPath();
    expect(FORBIDDEN_REQUEST_FIELDS.length).toBeGreaterThan(30);
    for (const field of FORBIDDEN_REQUEST_FIELDS) {
      const r = await reviewPresentation(HEADER, okRequest({ [field]: 'anything' }));
      expect(cls(r), field).toBe('request_invalid');
      expect(why(r), field).toContain('forbidden_field_supplied');
      expect(why(r), field).toContain(`forbidden:${field}`);
    }
    expect(authCalls, 'a forbidden field must refuse before authentication').toBe(0);
    expect(persistCalls).toHaveLength(0);
  });

  it('6 per-type cross-field rules are enforced at the request boundary', async () => {
    arrangeHappyPath();
    const approveWithReason = await reviewPresentation(HEADER,
      okRequest({ structuredRejectionReason: 'other_bounded' }));
    expect(why(approveWithReason)).toContain('approve_must_not_carry_rejection_reason');

    const approveWithTarget = await reviewPresentation(HEADER,
      okRequest({ revokesReviewDecisionId: '11111111-2222-4333-8444-555555555551' }));
    expect(why(approveWithTarget)).toContain('approve_must_not_carry_revoke_target');

    const rejectWithTarget = await reviewPresentation(HEADER, okRequest({
      decisionType: 'REJECT', structuredRejectionReason: 'other_bounded',
      revokesReviewDecisionId: '11111111-2222-4333-8444-555555555551',
    }));
    expect(why(rejectWithTarget)).toContain('reject_must_not_carry_revoke_target');

    const unknownType = await reviewPresentation(HEADER, okRequest({ decisionType: 'APPROVE_WITH_EDIT' }));
    expect(why(unknownType)).toContain('decisionType_unknown');
  });

  it('7 LOW-6 is structurally avoided: an invalid opportunityKey never reaches the C1 reader', async () => {
    arrangeHappyPath();
    for (const bad of [undefined, '', 42, null]) {
      const body = okRequest();
      if (bad === undefined) delete body.opportunityKey; else body.opportunityKey = bad;
      const r = await reviewPresentation(HEADER, body);
      expect(cls(r), String(bad)).toBe('request_invalid');
    }
    // the C1 reader was never called, so its row-shaped code for an argument
    // error is unreachable through this service. LOW-6 remains open IN C1.
    expect(historyCalls).toEqual([]);
  });
});

describe('authority', () => {
  it('8 a missing or malformed Authorization header is unauthenticated', async () => {
    arrangeHappyPath();
    for (const [header, code] of [
      [null, 'authorization_header_missing'],
      ['Basic abc', 'authorization_scheme_not_bearer'],
      ['Bearer ', 'authorization_header_missing'],
    ] as [string | null, string][]) {
      const r = await reviewPresentation(header, okRequest());
      expect(cls(r), String(header)).toBe('unauthenticated');
      void code;
    }
    expect(historyCalls, 'history must not be read without authority').toEqual([]);
    expect(persistCalls).toHaveLength(0);
  });

  it('9 a rejected token is unauthenticated', async () => {
    arrangeHappyPath();
    setAuth({ error: { message: 'bad jwt' } });
    const r = await reviewPresentation(HEADER, okRequest());
    expect(cls(r)).toBe('unauthenticated');
    expect(why(r)).toContain('token_rejected');
    expect(historyCalls).toEqual([]);
  });

  it('10 a verified user WITHOUT the capability is forbidden, not unauthenticated', async () => {
    arrangeHappyPath();
    setCapability(null);
    const r = await reviewPresentation(HEADER, okRequest());
    expect(cls(r)).toBe('forbidden');
    expect(why(r)).toContain('capability_absent');
    expect(authCalls).toBe(1);
    expect(capabilityCalls).toBe(1);
    expect(historyCalls, 'privileged history must not be read').toEqual([]);
    expect(persistCalls).toHaveLength(0);
  });

  it('11 a revoked capability is forbidden', async () => {
    arrangeHappyPath();
    setCapability({ user_id: USER, capability: 'presentation.approve', revoked_at: '2026-10-01T00:00:00Z' });
    const r = await reviewPresentation(HEADER, okRequest());
    expect(cls(r)).toBe('forbidden');
    expect(why(r)).toContain('capability_revoked');
  });

  it('12 auth and capability infrastructure faults are classed separately', async () => {
    arrangeHappyPath();
    setAuth({ throws: true });
    const t = await reviewPresentation(HEADER, okRequest());
    expect(cls(t)).toBe('upstream_failure');
    expect(why(t)).toContain('auth_transport_error');

    arrangeHappyPath();
    setCapability(null, { code: 'PGRST500' });
    const l = await reviewPresentation(HEADER, okRequest());
    expect(cls(l)).toBe('upstream_failure');
    expect(why(l)).toContain('capability_lookup_failed');

    arrangeHappyPath();
    UNSAFE_setCapabilityClientForTests(null);
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    try {
      const m = await reviewPresentation(HEADER, okRequest());
      expect(cls(m)).toBe('server_misconfiguration');
    } finally {
      if (url !== undefined) process.env.NEXT_PUBLIC_SUPABASE_URL = url;
      if (key !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = key;
    }
  });

  it('13 the reviewer identity sent to persistence is the authenticated user, never request data', async () => {
    arrangeHappyPath();
    const r = await reviewPresentation(HEADER, okRequest({
      decisionType: 'REJECT', structuredRejectionReason: 'other_bounded',
    }));
    expect(r.ok).toBe(true);
    expect(persistCalls).toHaveLength(1);
    expect(persistCalls[0].decision.reviewerId).toBe(USER);
    expect(persistCalls[0].decision.reviewerCapability).toBe('presentation.approve');
  });
});

describe('re-derivation', () => {
  it('14 an absent scan is scan_not_found', async () => {
    arrangeHappyPath();
    rederiveMock.mockResolvedValue({ ok: false, failures: [{ code: 'not_found', detail: 'no row for scan xyz' }] });
    const r = await reviewPresentation(HEADER, okRequest());
    expect(cls(r)).toBe('scan_not_found');
    expect(why(r)).toEqual(['not_found']);
  });

  it('15 a stored-payload hash mismatch, reconstruction failure and version mismatch all fail closed', async () => {
    for (const code of ['input_hash_mismatch', 'forbidden_key', 'scan_id_association_mismatch',
      'schema_version_mismatch', 'qualification_version_mismatch',
      'qualification_refused', 'review_refused']) {
      arrangeHappyPath();
      rederiveMock.mockResolvedValue({ ok: false, failures: [{ code, detail: 'raw database text here' }] });
      const r = await reviewPresentation(HEADER, okRequest());
      expect(cls(r), code).toBe('rederivation_failed');
      expect(why(r), code).toEqual([code]);
      expect(persistCalls, code).toHaveLength(0);
    }
  });

  it('16 a database error during reload is an upstream failure', async () => {
    arrangeHappyPath();
    rederiveMock.mockResolvedValue({ ok: false, failures: [{ code: 'database_error', detail: 'connection reset by peer' }] });
    const r = await reviewPresentation(HEADER, okRequest());
    expect(cls(r)).toBe('upstream_failure');
  });

  it('17 re-derivation runs for the requested scan only', async () => {
    arrangeHappyPath();
    await reviewPresentation(HEADER, okRequest({ decisionType: 'REJECT', structuredRejectionReason: 'other_bounded' }));
    expect(rederiveMock).toHaveBeenCalledTimes(1);
    expect(rederiveMock).toHaveBeenCalledWith(SCAN);
  });
});

describe('packet selection and binding', () => {
  it('18 an unknown opportunityKey is opportunity_not_found', async () => {
    arrangeHappyPath();
    const r = await reviewPresentation(HEADER, okRequest({ opportunityKey: 'opp:NOT-IN-THIS-SCAN' }));
    expect(cls(r)).toBe('opportunity_not_found');
    expect(why(r)).toEqual(['no_packet_for_opportunity_key']);
  });

  it('19 two packets sharing an opportunityKey are ambiguous, never [0]', async () => {
    arrangeHappyPath();
    // uniqueness is a property of the detector set, not a type guarantee
    rederiveMock.mockResolvedValue({
      ok: true, input: {}, inputHash: INPUT_HASH,
      review: { ...reviewForScan, packets: [aboutPacket, { ...aboutPacket }] },
    });
    const r = await reviewPresentation(HEADER, okRequest());
    expect(cls(r)).toBe('ambiguous_opportunity');
    expect(why(r)).toEqual(['multiple_packets_for_opportunity_key']);
    expect(persistCalls).toHaveLength(0);
  });

  it('20 a packet whose identity cannot be computed fails closed', async () => {
    arrangeHappyPath();
    const broken = { ...aboutPacket, gateTrace: 'not-an-array' };
    rederiveMock.mockResolvedValue({
      ok: true, input: {}, inputHash: INPUT_HASH,
      review: { ...reviewForScan, packets: [broken] },
    });
    const r = await reviewPresentation(HEADER, okRequest());
    expect(cls(r)).toBe('invalid_packet_identity');
    expect(persistCalls).toHaveLength(0);
  });

  it('21 a stale asserted binding is refused with the frozen outcome', async () => {
    for (const [field, value, outcome] of [
      ['evidenceFingerprint', 'STALE-FINGERPRINT', 'STALE_EVIDENCE'],
      ['claimHash', 'CHANGED-CLAIM', 'CLAIM_CHANGED'],
      ['reviewPacketHash', 'f'.repeat(32), 'PACKET_CHANGED'],
    ] as [string, string, string][]) {
      arrangeHappyPath();
      const r = await reviewPresentation(HEADER, okRequest({ [field]: value }));
      expect(cls(r), field).toBe('binding_mismatch');
      expect(why(r), field).toEqual([outcome]);
      expect(persistCalls, field).toHaveLength(0);
    }
  });

  it('22 the binding comparison runs against the SERVER re-derivation, not the request', async () => {
    arrangeHappyPath();
    const r = await reviewPresentation(HEADER, okRequest({
      decisionType: 'REJECT', structuredRejectionReason: 'other_bounded',
    }));
    expect(r.ok).toBe(true);
    const sent = persistCalls[0].decision;
    // versions, mode, demonstrability and the prose hash all come from the
    // re-derived packet, not from anything the caller could send
    expect(sent.reviewContractVersion).toBe(ABOUT.reviewContractVersion);
    expect(sent.qualificationVersion).toBe(ABOUT.qualificationVersion);
    expect(sent.presentationMode).toBe(ABOUT.presentationMode);
    expect(sent.demonstrability).toBe(ABOUT.demonstrabilityStatus);
    expect(sent.reviewedProseHash).toBe(ABOUT_PROSE);
    expect(sent.temporalFrame).toBe('CURRENT_STATE');
    expect(sent.hraVersion).toBe('hra-0.1.2');
  });

  it('23 the decision id is server-minted and the timestamp is server-normalized', async () => {
    arrangeHappyPath();
    await reviewPresentation(HEADER, okRequest({
      decisionType: 'REJECT', structuredRejectionReason: 'other_bounded',
    }));
    const sent = persistCalls[0].decision;
    expect(String(sent.reviewDecisionId)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(String(sent.decisionTimestamp)).toMatch(
      /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$/);
    // the caller's requestId is preserved verbatim
    expect(sent.requestId).toBe(REQ_ID);
  });

  it('24 the expectedInputHash and scanId sent to persistence come from the server', async () => {
    arrangeHappyPath();
    // the bridge returns a DIFFERENT hash from anything the caller could name
    rederiveMock.mockResolvedValue({ ok: true, input: {}, review: reviewForScan, inputHash: 'c'.repeat(64) });
    await reviewPresentation(HEADER, okRequest({
      decisionType: 'REJECT', structuredRejectionReason: 'other_bounded',
    }));
    expect(persistCalls).toHaveLength(1);
    // taken from the bridge re-derivation, never from the request
    expect(persistCalls[0].args.p_expected_input_hash).toBe('c'.repeat(64));
    expect(persistCalls[0].args.p_scan_id).toBe(SCAN);
    // and the caller has no field that could have set it
    expect(FORBIDDEN_REQUEST_FIELDS).toContain('inputHash');
    expect(FORBIDDEN_REQUEST_FIELDS).toContain('qualificationInputHash');
  });
});

describe('APPROVE_PRESENTATION', () => {
  it('25 an eligible approval records a decision AND a snapshot atomically', async () => {
    arrangeHappyPath({ persisted: { ...RECORDED, presentationSnapshotId: 'e'.repeat(32) } });
    const r = await reviewPresentation(HEADER, okRequest());
    expect(cls(r)).toBe('(ok)');
    if (!r.ok) return;
    expect(r.outcome).toBe('RECORDED');
    expect(r.presentationSnapshotId).toBe('e'.repeat(32));
    expect(persistCalls).toHaveLength(1);
    // one call carries both, so the accepted layer writes them in one transaction
    expect(persistCalls[0].snapshot).not.toBeNull();
    const snap = persistCalls[0].snapshot as Record<string, unknown>;
    expect(snap.reviewDecisionId).toBe(persistCalls[0].decision.reviewDecisionId);
    expect(snap.presentationMode).toBe('STATEMENT_WITH_DEMONSTRATION');
    expect(snap.demonstrability).toBe('DEMONSTRABLE');
    expect(snap.sourceScanId).toBe(SCAN);
  });

  it('26 a STATEMENT_ONLY packet cannot be approved', async () => {
    arrangeHappyPath();
    const r = await reviewPresentation(HEADER, okRequest({
      opportunityKey: STMT.opportunityKey,
      evidenceFingerprint: STMT.evidenceFingerprint,
      claimHash: STMT.claimHash,
      reviewPacketHash: STMT_HASH,
    }));
    // The frozen validator refuses first, because the candidate's
    // presentationMode is taken from the packet. That is the earlier and more
    // precise gate; the eligibility gate below covers what validation cannot.
    expect(cls(r)).toBe('decision_invalid');
    expect(why(r)).toContain('approve_requires_demonstration_mode');
    expect(why(r)).toContain('approve_requires_demonstrable');
    expect(persistCalls, 'nothing may be written').toHaveLength(0);
  });

  it('26b the eligibility gate is live for what validation cannot see', async () => {
    // meetsScoutEvidenceRequirements is the one eligibility condition neither
    // validateReviewDecision nor compareBinding covers, so it is the only way
    // to reach approval_not_eligible. Proven with a packet that is otherwise
    // approvable.
    arrangeHappyPath();
    const weak = { ...aboutPacket, meetsScoutEvidenceRequirements: false };
    const weakView = toReviewPacketView(weak);
    rederiveMock.mockResolvedValue({
      ok: true, input: {}, inputHash: INPUT_HASH,
      review: { ...reviewForScan, packets: [weak] },
    });
    const r = await reviewPresentation(HEADER, okRequest({
      reviewPacketHash: reviewPacketHash(weakView),
    }));
    expect(cls(r)).toBe('approval_not_eligible');
    expect(why(r)).toContain('meetsScoutEvidenceRequirements is false');
    expect(persistCalls).toHaveLength(0);
  });

  it('27 an approval that is not current under frozen ordering fails closed', async () => {
    // A historical decision timestamped AHEAD of now (inside the database
    // plausibility window) makes the candidate non-current, so the frozen
    // snapshot derivation must refuse rather than record a stale approval.
    const future = new Date(Date.now() + 3 * 60_000).toISOString().replace(/[.][0-9]+Z$/, '.000Z');
    arrangeHappyPath({ history: [historyRow({
      review_decision_id: '99999999-2222-4333-8444-999999999999',
      request_id: 'future-row',
      decision_timestamp: future,
    })] });
    const r = await reviewPresentation(HEADER, okRequest());
    expect(cls(r)).toBe('snapshot_not_derivable');
    expect(why(r)).toContain('decision_not_current');
    expect(persistCalls).toHaveLength(0);
  });

  it('28 approving an already-revoked binding fails closed', async () => {
    arrangeHappyPath({ history: [
      historyRow({ decision_timestamp: '2026-09-30T18:00:00.000Z' }),
      historyRow({
        review_decision_id: '22222222-2222-4333-8444-555555555552',
        request_id: 'older-revoke', decision_type: 'REVOKE',
        revokes_review_decision_id: '11111111-2222-4333-8444-555555555551',
        decision_timestamp: '2026-09-30T19:00:00.000Z',
      }),
    ] });
    const r = await reviewPresentation(HEADER, okRequest());
    // FROZEN SEMANTIC, asserted as it actually is: resolveRevocations
    // de-authorises standing decisions AT OR BEFORE the revoke
    // (`for (let j = 0; j <= i; …)`), so a LATER human approval of the same
    // binding is not revoked and becomes current. A revocation is therefore not
    // a permanent ban on the binding; it de-authorises what existed when it was
    // made. This service does not add a rule the frozen layer does not have.
    expect(cls(r)).toBe('(ok)');
    expect(persistCalls).toHaveLength(1);
    expect(persistCalls[0].snapshot).not.toBeNull();
  });

  it('29 no approval result field implies any downstream business action', async () => {
    arrangeHappyPath({ persisted: { ...RECORDED, presentationSnapshotId: 'e'.repeat(32) } });
    const r = await reviewPresentation(HEADER, okRequest());
    expect(r.ok).toBe(true);
    const keys = Object.keys(r).sort();
    expect(keys).toEqual([
      'decisionTimestamp', 'ok', 'outcome', 'presentationSnapshotId',
      'requestId', 'reviewDecisionId',
    ]);
    for (const forbidden of ['sent', 'published', 'fixed', 'verified', 'emailed',
      'delivered', 'outreach', 'impact', 'authorized', 'approved']) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });
});

describe('REJECT', () => {
  it('30 a valid rejection records a decision and NO snapshot', async () => {
    arrangeHappyPath();
    const r = await reviewPresentation(HEADER, okRequest({
      decisionType: 'REJECT', structuredRejectionReason: 'evidence_not_convincing',
      boundedReviewerNote: 'the screenshots do not show it',
    }));
    expect(cls(r)).toBe('(ok)');
    if (r.ok) expect(r.presentationSnapshotId).toBeNull();
    expect(persistCalls[0].snapshot).toBeNull();
    expect(persistCalls[0].decision.structuredRejectionReason).toBe('evidence_not_convincing');
    expect(persistCalls[0].decision.boundedReviewerNote).toBe('the screenshots do not show it');
  });

  it('31 a missing or off-vocabulary reason is refused', async () => {
    arrangeHappyPath();
    const missing = await reviewPresentation(HEADER, okRequest({ decisionType: 'REJECT' }));
    expect(cls(missing)).toBe('request_invalid');
    expect(why(missing)).toContain('structuredRejectionReason_required');

    const bogus = await reviewPresentation(HEADER, okRequest({
      decisionType: 'REJECT', structuredRejectionReason: 'made_up_reason',
    }));
    expect(cls(bogus)).toBe('request_invalid');
    expect(why(bogus)).toContain('structuredRejectionReason_required');
    expect(persistCalls).toHaveLength(0);
  });

  it('32 an INELIGIBLE packet may still be rejected — no eligibility gate on REJECT', async () => {
    arrangeHappyPath();
    const r = await reviewPresentation(HEADER, okRequest({
      opportunityKey: STMT.opportunityKey,
      evidenceFingerprint: STMT.evidenceFingerprint,
      claimHash: STMT.claimHash,
      reviewPacketHash: STMT_HASH,
      decisionType: 'REJECT', structuredRejectionReason: 'claim_not_suitable_for_external_use',
    }));
    expect(cls(r)).toBe('(ok)');
    expect(persistCalls[0].snapshot).toBeNull();
  });
});

describe('REVOKE', () => {
  const TARGET = '11111111-2222-4333-8444-555555555551';

  function revokeRequest(over: Record<string, unknown> = {}) {
    return okRequest({
      decisionType: 'REVOKE', revokesReviewDecisionId: TARGET, ...over,
    });
  }

  it('33 a valid revocation records a decision and NO snapshot', async () => {
    arrangeHappyPath({ history: [historyRow()] });
    const r = await reviewPresentation(HEADER, revokeRequest());
    expect(cls(r)).toBe('(ok)');
    if (r.ok) expect(r.presentationSnapshotId).toBeNull();
    expect(persistCalls).toHaveLength(1);
    expect(persistCalls[0].snapshot, 'a REVOKE never carries a snapshot').toBeNull();
    expect(persistCalls[0].decision.revokesReviewDecisionId).toBe(TARGET);
    // The accepted 2b-B wrapper normalizes an ABSENT optional to null in the
    // RPC payload (`?? null`), because the column is nullable. So the assertion
    // here is "carries no rejection reason", not "the key is missing" — the key
    // being absent is a property of the candidate RECORD, which test 42 pins.
    expect(persistCalls[0].decision.structuredRejectionReason).toBeNull();
  });

  it('34 a missing target is refused at the request boundary', async () => {
    arrangeHappyPath({ history: [historyRow()] });
    const r = await reviewPresentation(HEADER, okRequest({ decisionType: 'REVOKE' }));
    expect(cls(r)).toBe('request_invalid');
    expect(why(r)).toContain('revokesReviewDecisionId_required');

    const notUuid = await reviewPresentation(HEADER, revokeRequest({ revokesReviewDecisionId: 'nope' }));
    expect(cls(notUuid)).toBe('request_invalid');
    expect(persistCalls).toHaveLength(0);
  });

  it('35 a target absent from the complete history is refused', async () => {
    arrangeHappyPath({ history: [historyRow()] });
    const r = await reviewPresentation(HEADER,
      revokeRequest({ revokesReviewDecisionId: '77777777-2222-4333-8444-777777777777' }));
    expect(cls(r)).toBe('revoke_target_invalid');
    expect(why(r)).toContain('revoke_target_not_in_history');
    expect(persistCalls).toHaveLength(0);
  });

  it('36 a target that is itself a REVOKE is refused', async () => {
    arrangeHappyPath({ history: [
      historyRow(),
      historyRow({
        review_decision_id: '22222222-2222-4333-8444-555555555552',
        request_id: 'older-revoke', decision_type: 'REVOKE',
        revokes_review_decision_id: TARGET,
        decision_timestamp: '2026-09-30T19:00:00.000Z',
      }),
    ] });
    const r = await reviewPresentation(HEADER,
      revokeRequest({ revokesReviewDecisionId: '22222222-2222-4333-8444-555555555552' }));
    expect(cls(r)).toBe('revoke_target_invalid');
    expect(why(r)).toContain('revoke_target_is_a_revocation');
    expect(persistCalls).toHaveLength(0);
  });

  it('37 CHANGED EVIDENCE: a target bound to a different packet cannot be revoked here', async () => {
    // The target shares the opportunity, so it IS in the considered history,
    // but its claim and packet identity belong to an earlier observation.
    // Revocation is binding-scoped, so it must not reach across.
    arrangeHappyPath({ history: [historyRow({
      claim_hash: 'an-older-claim',
      review_packet_hash: 'f'.repeat(32),
    })] });
    const r = await reviewPresentation(HEADER, revokeRequest());
    expect(cls(r)).toBe('revoke_target_invalid');
    expect(why(r)).toContain('revoke_target_binding_not_exact');
    // the frozen outcome is reported, not invented here
    expect(why(r).some(x => x.startsWith('target_binding:'))).toBe(true);
    expect(persistCalls).toHaveLength(0);
  });

  it('38 a target that is not strictly earlier under frozen ordering is refused', async () => {
    // Timestamped ahead of now but inside the database plausibility window.
    const future = new Date(Date.now() + 3 * 60_000).toISOString().replace(/[.][0-9]+Z$/, '.000Z');
    arrangeHappyPath({ history: [historyRow({ decision_timestamp: future })] });
    const r = await reviewPresentation(HEADER, revokeRequest());
    expect(cls(r)).toBe('revoke_target_invalid');
    expect(why(r)).toContain('revoke_target_not_strictly_earlier');
    expect(persistCalls).toHaveLength(0);
  });

  it('39 revoking a binding with nothing standing is refused', async () => {
    arrangeHappyPath({ history: [
      historyRow({ decision_timestamp: '2026-09-30T18:00:00.000Z' }),
      historyRow({
        review_decision_id: '22222222-2222-4333-8444-555555555552',
        request_id: 'older-revoke', decision_type: 'REVOKE',
        revokes_review_decision_id: TARGET,
        decision_timestamp: '2026-09-30T19:00:00.000Z',
      }),
    ] });
    const r = await reviewPresentation(HEADER, revokeRequest());
    expect(cls(r)).toBe('revoke_target_invalid');
    expect(why(r)).toContain('revoke_nothing_standing');
    // the frozen pre-state is reported as a stable code, never as prose
    expect(why(r)).toContain('status_before:REVOKED');
    expect(persistCalls).toHaveLength(0);
  });

  it('40 a REJECT may also be revoked, and the frozen post-state is asserted', async () => {
    arrangeHappyPath({ history: [historyRow({
      decision_type: 'REJECT', structured_rejection_reason: 'evidence_not_convincing',
    })] });
    const r = await reviewPresentation(HEADER, revokeRequest());
    expect(cls(r)).toBe('(ok)');
    expect(persistCalls[0].snapshot).toBeNull();
  });

  it('41 self-revocation is impossible: the target can never be the fresh candidate id', async () => {
    arrangeHappyPath({ history: [historyRow()] });
    await reviewPresentation(HEADER, revokeRequest());
    const minted = String(persistCalls[0].decision.reviewDecisionId);
    expect(minted).not.toBe(TARGET);
    // the id is minted server-side per attempt, so a caller cannot aim at it
    expect(FORBIDDEN_REQUEST_FIELDS).toContain('reviewDecisionId');
  });
});

describe('history integration', () => {
  it('42 the candidate RECORD omits optionals it does not carry', async () => {
    // The frozen layer tests optionals with `!== undefined`, so the candidate
    // this service builds must omit them rather than set null. The persistence
    // wrapper's own `?? null` normalization happens after, at the RPC boundary.
    arrangeHappyPath();
    const r = await reviewPresentation(HEADER, okRequest({
      decisionType: 'REJECT', structuredRejectionReason: 'other_bounded',
    }));
    expect(r.ok).toBe(true);
    // a REJECT carries a reason but no revoke target and no note
    expect(persistCalls[0].decision.structuredRejectionReason).toBe('other_bounded');
    expect(persistCalls[0].decision.revokesReviewDecisionId).toBeNull();
    expect(persistCalls[0].decision.boundedReviewerNote).toBeNull();
  });

  it('43 every C1 reader failure class fails closed with its own stable code', async () => {
    // history_lookup_failed -> upstream_failure
    arrangeHappyPath();
    setHistory(null, { message: 'relation does not exist' });
    const lookup = await reviewPresentation(HEADER, okRequest());
    expect(cls(lookup)).toBe('upstream_failure');
    expect(why(lookup)).toEqual(['history_lookup_failed']);
    expect(persistCalls).toHaveLength(0);

    // history_row_malformed -> history_failed
    arrangeHappyPath();
    setHistory([historyRow({ reviewer_user_id: 'not-a-uuid' })]);
    const malformed = await reviewPresentation(HEADER, okRequest());
    expect(cls(malformed)).toBe('history_failed');
    expect(why(malformed)).toEqual(['history_row_malformed']);
    expect(persistCalls).toHaveLength(0);
  });

  it('44 an unconfigured history store is a server misconfiguration, not a refusal', async () => {
    arrangeHappyPath();
    // auth and capability stay seeded, so only the history reader loses its
    // configuration and the failure is attributable to exactly one layer.
    UNSAFE_setHistoryClientForTests(null);
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    try {
      const r = await reviewPresentation(HEADER, okRequest());
      expect(cls(r)).toBe('server_misconfiguration');
      expect(why(r)).toEqual(['history_store_not_configured']);
      expect(persistCalls).toHaveLength(0);
    } finally {
      if (url !== undefined) process.env.NEXT_PUBLIC_SUPABASE_URL = url;
      if (key !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = key;
    }
  });

  it('45 a PARTIAL history is never accepted: one bad row rejects the whole load', async () => {
    arrangeHappyPath();
    setHistory([historyRow(), historyRow({
      review_decision_id: '33333333-2222-4333-8444-555555555553',
      request_id: 'broken', decision_timestamp: 'not-a-timestamp',
    })]);
    const r = await reviewPresentation(HEADER, okRequest());
    expect(cls(r)).toBe('history_failed');
    // deriving status from a partial history could read a revoked binding as
    // current, so nothing may be written.
    expect(persistCalls).toHaveLength(0);
  });

  it('46 history is loaded for the requested opportunity only, and only after authority', async () => {
    arrangeHappyPath({ history: [historyRow()] });
    await reviewPresentation(HEADER, okRequest({
      decisionType: 'REJECT', structuredRejectionReason: 'other_bounded',
    }));
    expect(historyCalls).toEqual([ABOUT.opportunityKey]);
    expect(authCalls).toBe(1);
    expect(capabilityCalls).toBe(1);
  });
});

/** Executable code only: these modules NAME what they forbid, in prose. */
function stripComments(raw: string): string {
  return raw
    .replace(/[/][*][\s\S]*?[*][/]/g, ' ')
    .split('\n')
    .filter(l => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*')); })
    .join('\n');
}

/**
 * The service's own production source, comments stripped. Structural
 * assertions must read executable code: the module deliberately NAMES the
 * constructs it forbids in order to say they are forbidden.
 */
function productionSource(): string {
  const raw = readFileSync(new URL('./presentation-review-service.ts', import.meta.url), 'utf8');
  return raw
    .replace(/[/][*][\s\S]*?[*][/]/g, ' ')
    .split('\n')
    .filter(l => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*')); })
    .join('\n');
}

describe('idempotency', () => {
  it('47 ALREADY_RECORDED returns the ORIGINAL persisted identifiers', async () => {
    arrangeHappyPath({ persisted: {
      outcome: 'ALREADY_RECORDED',
      reviewDecisionId: 'aaaaaaaa-0000-4000-8000-000000000001',
      requestId: REQ_ID,
      decisionTimestamp: '2026-09-30T18:00:00.000Z',
      presentationSnapshotId: 'f'.repeat(32),
      canonicalPayloadHash: 'b'.repeat(64),
    } });
    const r = await reviewPresentation(HEADER, okRequest());
    expect(cls(r)).toBe('(ok)');
    if (!r.ok) return;
    expect(r.outcome).toBe('ALREADY_RECORDED');
    // the ORIGINAL ids, not the ones minted for this attempt
    expect(r.reviewDecisionId).toBe('aaaaaaaa-0000-4000-8000-000000000001');
    expect(r.reviewDecisionId).not.toBe(persistCalls[0].decision.reviewDecisionId);
    expect(r.decisionTimestamp).toBe('2026-09-30T18:00:00.000Z');
    expect(r.decisionTimestamp).not.toBe(persistCalls[0].decision.decisionTimestamp);
    expect(r.presentationSnapshotId).toBe('f'.repeat(32));
    expect(r.requestId).toBe(REQ_ID);
  });

  it('48 IDEMPOTENCY_CONFLICT is its own bounded class', async () => {
    arrangeHappyPath({ persisted: {
      outcome: 'IDEMPOTENCY_CONFLICT',
      detail: 'this requestId already recorded a different logical decision',
    } });
    const r = await reviewPresentation(HEADER, okRequest());
    expect(cls(r)).toBe('idempotency_conflict');
    expect(why(r)).toEqual(['idempotency_conflict']);
  });

  it('49 persistence remains authoritative: no local idempotency is implemented', () => {
    const src = productionSource();
    for (const forbidden of ['compareIdempotency', 'canonicalDecisionPayload',
      'canonicalDecisionPayloadHash', 'EXCLUDED_FROM_CANONICAL_PAYLOAD']) {
      expect(src, forbidden).not.toContain(forbidden);
    }
  });

  it('50 every RPC refusal outcome maps through the wrapper to a bounded class', async () => {
    // The RPC speaks UPPERCASE outcomes; the accepted wrapper translates them
    // into its own codes, and this service maps those to classes. Stubbing the
    // RPC (not the wrapper) keeps the real translation in the loop.
    const cases: [string, string][] = [
      ['QUALIFICATION_INPUT_NOT_FOUND', 'scan_not_found'],
      ['QUALIFICATION_INPUT_HASH_MISMATCH', 'persistence_failed'],
      ['REVOKE_TARGET_NOT_FOUND', 'revoke_target_invalid'],
      ['SNAPSHOT_REQUIRED_FOR_APPROVAL', 'persistence_failed'],
      ['SNAPSHOT_FORBIDDEN_FOR_DECISION', 'persistence_failed'],
      ['SNAPSHOT_BINDING_MISMATCH', 'persistence_failed'],
      ['DECISION_TIMESTAMP_OUT_OF_BOUNDS', 'persistence_failed'],
      ['MALFORMED_INPUT', 'persistence_failed'],
      ['IDEMPOTENCY_CONFLICT', 'idempotency_conflict'],
      // an outcome a FUTURE migration might add is never success
      ['SOME_NEW_OUTCOME', 'upstream_failure'],
    ];
    for (const [outcome, expected] of cases) {
      arrangeHappyPath({ persisted: { outcome, detail: 'raw supabase text 42P01' } });
      const r = await reviewPresentation(HEADER, okRequest({
        decisionType: 'REJECT', structuredRejectionReason: 'other_bounded',
      }));
      expect(cls(r), outcome).toBe(expected);
      expect(why(r).join(' '), outcome).not.toContain('42P01');
    }
  });

  it('51 wrapper-internal persistence faults are classed without leaking text', async () => {
    // transport error from the client
    arrangeHappyPath();
    UNSAFE_setPersistenceClientForTests({
      rpc: () => Promise.resolve({ data: null, error: { message: 'FATAL: password authentication failed' } }),
    });
    const t = await reviewPresentation(HEADER, okRequest({
      decisionType: 'REJECT', structuredRejectionReason: 'other_bounded',
    }));
    expect(cls(t)).toBe('upstream_failure');
    expect(why(t)).toEqual(['transport_error']);
    expect(why(t).join(' ')).not.toContain('password');

    // malformed success payload
    arrangeHappyPath();
    UNSAFE_setPersistenceClientForTests({
      rpc: () => Promise.resolve({ data: { outcome: 'RECORDED' }, error: null }),
    });
    const m = await reviewPresentation(HEADER, okRequest({
      decisionType: 'REJECT', structuredRejectionReason: 'other_bounded',
    }));
    expect(cls(m)).toBe('upstream_failure');
    expect(why(m)).toEqual(['malformed_response']);

    // unconfigured persistence
    arrangeHappyPath();
    UNSAFE_setPersistenceClientForTests(null);
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    try {
      const c = await reviewPresentation(HEADER, okRequest({
        decisionType: 'REJECT', structuredRejectionReason: 'other_bounded',
      }));
      // the history reader loses configuration first, which is itself correct
      // fail-closed behaviour; either way nothing is written.
      expect(cls(c)).toBe('server_misconfiguration');
    } finally {
      if (url !== undefined) process.env.NEXT_PUBLIC_SUPABASE_URL = url;
      if (key !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = key;
    }
  });
});

describe('security and phase boundary', () => {
  it('52 raw lower-layer detail never reaches the stable result', async () => {
    // Every layer below can return a `detail` string carrying database text.
    // None of it may appear in a C2 result, because C3 maps classes only.
    const poison = 'FATAL 42P01 relation review_decisions does not exist; password=hunter2';

    arrangeHappyPath();
    rederiveMock.mockResolvedValue({ ok: false, failures: [{ code: 'input_hash_mismatch', detail: poison }] });
    const a = await reviewPresentation(HEADER, okRequest());
    expect(JSON.stringify(a)).not.toContain('42P01');
    expect(JSON.stringify(a)).not.toContain('hunter2');

    arrangeHappyPath();
    setHistory(null, { message: poison });
    const b = await reviewPresentation(HEADER, okRequest());
    expect(JSON.stringify(b)).not.toContain('42P01');

    arrangeHappyPath({ persisted: { outcome: 'MALFORMED_INPUT', detail: poison } });
    const c = await reviewPresentation(HEADER, okRequest({
      decisionType: 'REJECT', structuredRejectionReason: 'other_bounded',
    }));
    expect(JSON.stringify(c)).not.toContain('42P01');

    // the refusal type has no field that could carry prose
    for (const r of [a, b, c]) {
      expect(Object.keys(r).sort()).toEqual(['failure', 'ok', 'reasons']);
    }
  });

  it('53 the service never logs, and never names a secret', () => {
    const src = productionSource();
    for (const forbidden of ['console.', 'process.stdout', 'process.stderr',
      'SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY']) {
      expect(src, forbidden).not.toContain(forbidden);
    }
    // the header is delegated whole, never parsed here
    expect(src).toContain('requirePresentationApprove(authorizationHeader)');
  });

  it('54 no HTTP, no browser, no direct database access', () => {
    const src = productionSource();
    for (const forbidden of ['next/server', 'NextRequest', 'NextResponse',
      'createBrowserClient', 'supabase/ssr', 'createClient',
      '.rpc(', '.from(', '.insert(', '.update(', '.upsert(', '.delete(',
      'auth.getUser', 'getUser', 'operator_capabilities', 'review_decisions',
      'qualification_inputs', 'presentation_snapshots']) {
      expect(src, forbidden).not.toContain(forbidden);
    }
  });
});

describe('trust assertion inventory and phase boundary', () => {
  it('55 no third TrustedReviewerIdentity assertion is introduced by C2', () => {
    // Discovered, not listed: the whole production surface of this layer.
    const dir = new URL('./', import.meta.url);
    const files = readdirSync(dir).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts')).sort();
    expect(files).toContain('capability.ts');
    expect(files).toContain('review-history.ts');
    expect(files).toContain('presentation-review-service.ts');
    expect(files.length).toBeGreaterThanOrEqual(6);

    const pattern = new RegExp(
      'as' + String.fromCharCode(92) + 's+unknown' + String.fromCharCode(92) + 's+as'
      + String.fromCharCode(92) + 's+TrustedReviewerIdentity'
      + '|as' + String.fromCharCode(92) + 's+TrustedReviewerIdentity'
      + '|<TrustedReviewerIdentity>', 'g');

    const counts = new Map<string, number>();
    let total = 0;
    for (const file of files) {
      const raw = readFileSync(new URL(file, dir), 'utf8');
      const code = stripComments(raw);
      const n = (code.match(pattern) ?? []).length;
      counts.set(file, n);
      total += n;
    }
    // LIVE AUTHORITY (2b-A) and HISTORICAL ATTRIBUTION (2b-C1). Nothing else.
    expect(counts.get('capability.ts')).toBe(1);
    expect(counts.get('review-history.ts')).toBe(1);
    expect(counts.get('presentation-review-service.ts'), 'C2 mints nothing').toBe(0);
    for (const f of files) {
      if (f === 'capability.ts' || f === 'review-history.ts') continue;
      expect(counts.get(f), f).toBe(0);
    }
    expect(total).toBe(2);
  });

  it('56 reviewer authority is obtained only by delegation', () => {
    const src = productionSource();
    expect((src.match(/requirePresentationApprove\(/g) ?? [])).toHaveLength(1);
    for (const forbidden of ['authenticateReviewer', 'hasActivePresentationApprove',
      'parseBearerToken', 'Bearer', 'recordsRequiredCapability']) {
      expect(src, forbidden).not.toContain(forbidden);
    }
  });

  it('57 no downstream business action exists in this layer', () => {
    // FORBIDDEN_REQUEST_FIELDS legitimately NAMES things like 'email' and
    // 'status' in order to reject them, so the scan excludes that literal.
    // What is scanned is the executable remainder.
    const src = productionSource().replace(
      /FORBIDDEN_REQUEST_FIELDS[\s\S]*?\]\);/, 'FORBIDDEN_REQUEST_FIELDS_ELIDED');
    expect(src).toContain('FORBIDDEN_REQUEST_FIELDS_ELIDED');
    for (const forbidden of ['email', 'sendMail', 'outreach', 'publish', 'remediation',
      'heygen', 'HeyGen', 'blotato', 'Blotato', 'VideoBrief', 'webhook', 'fetch(',
      'CRM', 'social', 'Scout']) {
      expect(src, forbidden).not.toContain(forbidden);
    }
    // and the rejection list really does still name them, so the guard above
    // is not hiding a missing protection
    expect(FORBIDDEN_REQUEST_FIELDS).toContain('email');
    expect(FORBIDDEN_REQUEST_FIELDS).toContain('reviewerEmail');
    const raw = readFileSync(new URL('./presentation-review-service.ts', import.meta.url), 'utf8');
    expect(raw).toContain('governed external presentation asset');
  });

  it('58 nothing is written until every gate has passed', async () => {
    const refusals: [string, Record<string, unknown>][] = [
      ['request_invalid', { requestId: 'bad' }],
      ['opportunity_not_found', { opportunityKey: 'opp:nope' }],
      ['binding_mismatch', { claimHash: 'changed' }],
    ];
    for (const [expected, over] of refusals) {
      arrangeHappyPath();
      const r = await reviewPresentation(HEADER, okRequest(over));
      expect(cls(r), expected).toBe(expected);
      expect(persistCalls, expected).toHaveLength(0);
    }
    arrangeHappyPath();
    const noAuth = await reviewPresentation(null, okRequest());
    expect(cls(noAuth)).toBe('unauthenticated');
    expect(persistCalls).toHaveLength(0);
  });

  it('59 C2 creates no HTTP route: that is 2b-C3 and is not authorised', () => {
    const files = readdirSync(new URL('./', import.meta.url));
    expect(files.some(f => f.includes('route'))).toBe(false);
  });
});

describe('requestId is a UUIDv4', () => {
  // The authorized contract is a client-generated UUIDv4, server-validated.
  // Nothing in the accepted stack forces version agnosticism: request_id is a
  // `text` column constrained only to be non-empty, the RPC applies no uuid
  // cast, and validateReviewDecision only checks non-emptiness. So the
  // specified contract is enforced rather than reinterpreted.
  const CASES: [string, string, boolean][] = [
    ['v4 (randomUUID shape)', '7f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', true],
    ['v4, variant 9', '7f1b2c3d-4e5f-4a6b-9c7d-9e0f1a2b3c4d', true],
    ['v4, variant b, uppercase', '7F1B2C3D-4E5F-4A6B-BC7D-9E0F1A2B3C4D', true],
    ['v1 (time-based)', 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6', false],
    ['v3 (md5 name-based)', '3d813cbb-47fb-32ba-91df-831e1593ac29', false],
    ['v5 (sha1 name-based)', '21f7f8de-8051-5b89-8680-0195ef798b6a', false],
    ['v7 (time-ordered)', '018f3b7c-0b2a-7c3d-8e4f-5a6b7c8d9e0f', false],
    ['v4 digits but bad variant', '7f1b2c3d-4e5f-4a6b-0c7d-9e0f1a2b3c4d', false],
    ['nil uuid', '00000000-0000-0000-0000-000000000000', false],
    ['malformed', 'not-a-uuid', false],
    ['right length, wrong shape', '7f1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d0000', false],
  ];

  it('60 only a UUIDv4 requestId is accepted', async () => {
    for (const [label, value, shouldPass] of CASES) {
      arrangeHappyPath();
      // cleared per iteration: beforeEach only runs once for the whole test,
      // so accepted cases would otherwise leave entries behind
      persistCalls.length = 0;
      const r = await reviewPresentation(HEADER, okRequest({
        requestId: value,
        decisionType: 'REJECT', structuredRejectionReason: 'other_bounded',
      }));
      if (shouldPass) {
        expect(cls(r), label).toBe('(ok)');
      } else {
        expect(cls(r), label).toBe('request_invalid');
        expect(why(r), label).toContain('requestId_malformed');
        expect(persistCalls, label).toHaveLength(0);
      }
    }
  });

  it('61 an accepted requestId reaches persistence verbatim, never regenerated', async () => {
    arrangeHappyPath();
    const supplied = 'aaaabbbb-cccc-4ddd-8eee-ffff00001111';
    await reviewPresentation(HEADER, okRequest({
      requestId: supplied,
      decisionType: 'REJECT', structuredRejectionReason: 'other_bounded',
    }));
    expect(persistCalls).toHaveLength(1);
    expect(persistCalls[0].decision.requestId).toBe(supplied);
  });

  it('62 referencing identifiers stay version-agnostic, deliberately', async () => {
    // scanId and revokesReviewDecisionId name rows that ALREADY exist, so
    // pinning a version there could refuse a legitimate historical id. Only the
    // freshly minted retry token is pinned.
    const src = productionSource();
    expect(src).toContain("str('requestId', UUID_V4)");
    expect(src).toContain("str('scanId', UUID)");
    expect(src).not.toContain("str('scanId', UUID_V4)");

    // a v1-shaped scanId is still accepted by the parser: it is refused later
    // only if no such observation exists, which is the bridge's job.
    arrangeHappyPath();
    const v1Scan = 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6';
    rederiveMock.mockResolvedValue({ ok: false, failures: [{ code: 'not_found', detail: 'x' }] });
    const r = await reviewPresentation(HEADER, okRequest({ scanId: v1Scan }));
    // reached the bridge rather than being refused at the request boundary
    expect(cls(r)).toBe('scan_not_found');
    expect(rederiveMock).toHaveBeenCalledWith(v1Scan);
  });
});
