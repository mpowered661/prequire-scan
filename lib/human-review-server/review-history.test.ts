// Phase 2b-C1 — immutable review history reader.
//
// The Supabase client is stubbed: this tranche has no HTTP layer and touches no
// database. Structural tests read the production sources as text.
import { readdirSync, readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { deriveDecisionStatus, orderDecisions } from '../human-review/approval-status';
import { reviewPacketHash } from '../human-review/packet-hash';
import type { ReviewPacketView } from '../human-review/types';
import { qualify } from '../opportunity-qualification/qualify';
import type { QualificationInput } from '../opportunity-qualification/types';
import { deriveReview, type QualificationResultView } from '../opportunity-review/review-packet';
import { toReviewPacketView } from './packet-view';
import {
  loadDecisionsForOpportunity,
  UNSAFE_setHistoryClientForTests,
} from './review-history';

// ── a real packet, so hydrated history can be fed to the frozen functions ───

const FIXTURE = JSON.parse(readFileSync(
  new URL('../opportunity-qualification/__fixtures__/michael-pilot.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
function fixtureInput(): QualificationInput {
  const { _provenance, ...rest } = FIXTURE;
  return JSON.parse(JSON.stringify(rest)) as QualificationInput;
}
const review = deriveReview(qualify(fixtureInput()) as unknown as QualificationResultView);
const ABOUT: ReviewPacketView = toReviewPacketView(
  review.packets.find(p => p.subject === 'https://michaelhingson.com/about/')!);
const ABOUT_HASH = reviewPacketHash(ABOUT);

const REVIEWER = '8f14e45f-ceea-467a-9a36-dedd4bea2543';
const PROSE_HASH = 'd41d8cd98f00b204e9800998ecf8427e';

/** A well-formed persisted row bound to the real /about/ packet. */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    review_decision_id: '11111111-2222-4333-8444-555555555551',
    request_id: 'req-approve-1',
    decision_type: 'APPROVE_PRESENTATION',
    reviewer_user_id: REVIEWER,
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
    reviewed_prose_hash: PROSE_HASH,
    structured_rejection_reason: null,
    bounded_reviewer_note: null,
    revokes_review_decision_id: null,
    ...over,
  };
}

// ── stub client ─────────────────────────────────────────────────────────────

interface Recorded {
  table: string;
  columns: string;
  filters: [string, string, unknown][];
  orders: [string, unknown][];
  authTouched: boolean;
  methods: string[];
}
let recorded: Recorded[] = [];

type Reply = { data?: unknown; error?: { message: string } } | (() => never);

function stubClient(reply: Reply) {
  UNSAFE_setHistoryClientForTests({
    // Present so a test can prove it is never consulted.
    auth: {
      getUser() {
        recorded[recorded.length - 1].authTouched = true;
        throw new Error('history must never authenticate');
      },
    },
    from(table: string) {
      const call: Recorded = {
        table, columns: '', filters: [], orders: [], authTouched: false, methods: ['from'],
      };
      recorded.push(call);
      const builder: Record<string, unknown> = {};
      const chain = (name: string, fn: (...a: never[]) => void) => {
        builder[name] = (...args: unknown[]) => {
          call.methods.push(name);
          (fn as (...a: unknown[]) => void)(...args);
          return builder;
        };
      };
      chain('select', (c: unknown) => { call.columns = String(c); });
      chain('eq', (k: unknown, v: unknown) => { call.filters.push(['eq', String(k), v]); });
      chain('order', (c: unknown, o: unknown) => { call.orders.push([String(c), o]); });
      // Mutation surface: present, so a test can prove it is never called.
      for (const forbidden of ['insert', 'update', 'upsert', 'delete', 'rpc']) {
        builder[forbidden] = () => { throw new Error(`history must never call ${forbidden}`); };
      }
      builder.then = (resolve: (v: unknown) => unknown) => {
        // Early return so the union narrows: `reply()` returns never, but that
        // alone does not narrow `reply` for the line below.
        if (typeof reply === 'function') return reply();
        return Promise.resolve({ data: reply.data ?? null, error: reply.error ?? null }).then(resolve);
      };
      return builder;
    },
  });
}

beforeEach(() => {
  recorded = [];
  UNSAFE_setHistoryClientForTests(null);
});

describe('history reader — behaviour', () => {
  it('1 a configured reader returns hydrated decisions', async () => {
    stubClient({ data: [row()] });
    const out = await loadDecisionsForOpportunity(ABOUT.opportunityKey);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.decisions).toHaveLength(1);
    const d = out.decisions[0];
    expect(d.reviewDecisionId).toBe('11111111-2222-4333-8444-555555555551');
    expect(d.decisionType).toBe('APPROVE_PRESENTATION');
    expect(d.opportunityKey).toBe(ABOUT.opportunityKey);
    expect(d.reviewPacketHash).toBe(ABOUT_HASH);
    expect(d.temporalFrame).toBe('CURRENT_STATE');
  });

  it('2 the exact opportunity_key filter is pushed to the database', async () => {
    stubClient({ data: [] });
    await loadDecisionsForOpportunity('opp:some-specific-key');
    expect(recorded).toHaveLength(1);
    const c = recorded[0];
    expect(c.table).toBe('review_decisions');
    expect(c.filters).toEqual([['eq', 'opportunity_key', 'opp:some-specific-key']]);
    // deterministic ordering, and the whole table is never scanned client-side
    expect(c.orders).toEqual([
      ['decision_timestamp', { ascending: true }],
      ['review_decision_id', { ascending: true }],
    ]);
    // explicit column list, never '*'
    expect(c.columns).not.toContain('*');
    expect(c.columns).toContain('reviewer_user_id');
    // columns that are NOT on the frozen record are not even selected
    for (const absent of ['canonical_payload_hash', 'source_scan_id',
      'qualification_input_hash', 'recorded_at', 'created_at']) {
      expect(c.columns, absent).not.toContain(absent);
    }
  });

  it('3 zero rows is an empty history, not an error', async () => {
    stubClient({ data: [] });
    const out = await loadDecisionsForOpportunity(ABOUT.opportunityKey);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.decisions).toEqual([]);
    stubClient({ data: null });
    const nul = await loadDecisionsForOpportunity(ABOUT.opportunityKey);
    expect(nul.ok).toBe(true);
    if (nul.ok) expect(nul.decisions).toEqual([]);
  });

  it('4 missing service-role configuration fails closed', async () => {
    UNSAFE_setHistoryClientForTests(null);
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    try {
      const out = await loadDecisionsForOpportunity(ABOUT.opportunityKey);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.code).toBe('history_store_not_configured');
    } finally {
      if (url !== undefined) process.env.NEXT_PUBLIC_SUPABASE_URL = url;
      if (key !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = key;
    }
  });

  it('5 a lookup failure becomes a bounded history_lookup_failed', async () => {
    stubClient({ error: { message: 'relation does not exist' } });
    const a = await loadDecisionsForOpportunity(ABOUT.opportunityKey);
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.code).toBe('history_lookup_failed');

    stubClient(() => { throw new Error('socket hang up'); });
    const b = await loadDecisionsForOpportunity(ABOUT.opportunityKey);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.code).toBe('history_lookup_failed');

    stubClient({ data: { not: 'an array' } });
    const c = await loadDecisionsForOpportunity(ABOUT.opportunityKey);
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.code).toBe('history_lookup_failed');
  });
});

describe('history reader — hydration fails closed', () => {
  async function reject(over: Record<string, unknown>, label: string) {
    stubClient({ data: [row(over)] });
    const out = await loadDecisionsForOpportunity(ABOUT.opportunityKey);
    expect(out.ok, label).toBe(false);
    if (!out.ok) expect(out.code, label).toBe('history_row_malformed');
  }

  it('6 a structurally malformed row fails closed', async () => {
    for (const bad of [null, 'a string', 42, [], undefined]) {
      stubClient({ data: [bad] });
      const out = await loadDecisionsForOpportunity(ABOUT.opportunityKey);
      expect(out.ok, JSON.stringify(bad)).toBe(false);
      if (!out.ok) expect(out.code).toBe('history_row_malformed');
    }
    // and a missing required column
    await reject({ request_id: undefined }, 'request_id absent');
    await reject({ opportunity_key: '' }, 'opportunity_key empty');
    await reject({ reviewer_capability: 'presentation.publish' }, 'wrong capability');
    await reject({ temporal_frame: 'BEFORE' }, 'unrepresentable temporal frame');
  });

  it('7 a malformed reviewer_user_id fails closed', async () => {
    await reject({ reviewer_user_id: 'not-a-uuid' }, 'non-uuid');
    await reject({ reviewer_user_id: '' }, 'empty');
    await reject({ reviewer_user_id: null }, 'null');
    await reject({ reviewer_user_id: 42 }, 'number');
    // placeholder identities are not uuids, so they cannot hydrate either
    await reject({ reviewer_user_id: 'admin' }, 'admin');
    await reject({ reviewer_user_id: 'system' }, 'system');
  });

  it('8 an unknown decision_type fails closed', async () => {
    for (const bad of ['APPROVE_WITH_EDIT', 'REQUEST_MORE_EVIDENCE', 'APPROVED_FOR_OUTREACH',
      'approve_presentation', 'VERIFIED', '']) {
      await reject({ decision_type: bad }, bad || '(empty)');
    }
  });

  it('9 a malformed decision timestamp fails closed', async () => {
    for (const bad of ['2026-09-30 18:00:00', '2026-09-30T18:00:00Z',
      '2026-09-30T18:00:00.5Z', '2026-09-30T18:00:00.000', 'yesterday', '']) {
      await reject({ decision_timestamp: bad }, bad || '(empty)');
    }
    // the normalized frozen form is the only accepted one
    stubClient({ data: [row({ decision_timestamp: '2026-09-30T18:00:00.000Z' })] });
    const ok = await loadDecisionsForOpportunity(ABOUT.opportunityKey);
    expect(ok.ok).toBe(true);
  });

  it('10 a malformed required hash fails closed', async () => {
    await reject({ review_packet_hash: 'too-short' }, 'packet hash short');
    await reject({ review_packet_hash: 'A'.repeat(32) }, 'packet hash uppercase');
    await reject({ review_packet_hash: 'f'.repeat(64) }, 'packet hash 64');
    await reject({ reviewed_prose_hash: 'zz' }, 'prose hash');
    await reject({ reviewed_prose_hash: null }, 'prose hash null');
  });

  it('11 nullable fields hydrate as ABSENT, not null, per the frozen type', async () => {
    // APPROVE: all three optionals null in the row -> keys absent on the record
    stubClient({ data: [row()] });
    const approve = await loadDecisionsForOpportunity(ABOUT.opportunityKey);
    expect(approve.ok).toBe(true);
    if (approve.ok) {
      const d = approve.decisions[0];
      // `null` would make the frozen `!== undefined` checks see a value, and an
      // APPROVE would look like it carried a rejection reason.
      expect(d.structuredRejectionReason).toBeUndefined();
      expect(d.boundedReviewerNote).toBeUndefined();
      expect(d.revokesReviewDecisionId).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(d, 'structuredRejectionReason')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(d, 'revokesReviewDecisionId')).toBe(false);
    }

    // REJECT carries a vocabulary reason
    stubClient({ data: [row({
      decision_type: 'REJECT', structured_rejection_reason: 'evidence_not_convincing',
      bounded_reviewer_note: 'not convincing enough',
    })] });
    const rej = await loadDecisionsForOpportunity(ABOUT.opportunityKey);
    expect(rej.ok).toBe(true);
    if (rej.ok) {
      expect(rej.decisions[0].structuredRejectionReason).toBe('evidence_not_convincing');
      expect(rej.decisions[0].boundedReviewerNote).toBe('not convincing enough');
    }
    // an off-vocabulary reason fails closed
    await reject({ decision_type: 'REJECT', structured_rejection_reason: 'made_up' }, 'bad reason');
    // an over-long note fails closed
    await reject({ bounded_reviewer_note: 'x'.repeat(501) }, 'note too long');

    // REVOKE carries a uuid target
    stubClient({ data: [row({
      decision_type: 'REVOKE', revokes_review_decision_id: '22222222-2222-4333-8444-555555555552',
    })] });
    const rev = await loadDecisionsForOpportunity(ABOUT.opportunityKey);
    expect(rev.ok).toBe(true);
    if (rev.ok) {
      expect(rev.decisions[0].revokesReviewDecisionId).toBe('22222222-2222-4333-8444-555555555552');
    }
    await reject({ decision_type: 'REVOKE', revokes_review_decision_id: 'nope' }, 'bad target');
  });

  it('12 the recorded reviewer identity is restored exactly', async () => {
    stubClient({ data: [row()] });
    const out = await loadDecisionsForOpportunity(ABOUT.opportunityKey);
    expect(out.ok).toBe(true);
    if (out.ok) expect(String(out.decisions[0].reviewerId)).toBe(REVIEWER);
  });

  it('13 one unhydratable row rejects the WHOLE history', async () => {
    // A partial history could read a revoked binding as current, so a single
    // bad row must not be skipped.
    stubClient({ data: [row(), row({ review_decision_id: 'not-a-uuid' })] });
    const out = await loadDecisionsForOpportunity(ABOUT.opportunityKey);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe('history_row_malformed');
  });
});

// ── authority separation ────────────────────────────────────────────────────

/** Comment-stripped production sources in this layer, discovered not listed. */
function productionSources(): { file: string; code: string }[] {
  const dir = new URL('./', import.meta.url);
  return readdirSync(dir)
    .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .sort()
    .map(file => {
      const raw = readFileSync(new URL(file, dir), 'utf8');
      const code = raw
        .replace(/[/][*][\s\S]*?[*][/]/g, ' ')
        .split('\n')
        .filter(l => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*')); })
        .join('\n');
      return { file, code };
    });
}

describe('history reader performs no authority operation', () => {
  it('14 it never authenticates and never reads the capability store', async () => {
    stubClient({ data: [row(), row({ review_decision_id: '33333333-2222-4333-8444-555555555553', request_id: 'r2' })] });
    const out = await loadDecisionsForOpportunity(ABOUT.opportunityKey);
    expect(out.ok).toBe(true);
    // one query, against review_decisions only
    expect(recorded).toHaveLength(1);
    expect(recorded[0].table).toBe('review_decisions');
    expect(recorded.some(c => c.table === 'operator_capabilities')).toBe(false);
    expect(recorded.some(c => c.table === 'auth.users')).toBe(false);
    // auth.getUser throws if touched; it was not
    expect(recorded[0].authTouched).toBe(false);
  });

  it('15 it never calls a mutation method', async () => {
    // the stub throws on insert/update/upsert/delete/rpc
    stubClient({ data: [row()] });
    const out = await loadDecisionsForOpportunity(ABOUT.opportunityKey);
    expect(out.ok).toBe(true);
    expect(recorded[0].methods).toEqual(['from', 'select', 'eq', 'order', 'order']);
    for (const forbidden of ['insert', 'update', 'upsert', 'delete', 'rpc']) {
      expect(recorded[0].methods, forbidden).not.toContain(forbidden);
    }
  });

  it('16 the module does not import or reference the authority path', () => {
    const self = productionSources().find(f => f.file === 'review-history.ts')!;
    for (const forbidden of ['./capability', './trusted-reviewer',
      'requirePresentationApprove', 'authenticateReviewer', 'hasActivePresentationApprove',
      'getUser', 'operator_capabilities', 'NEXT_PUBLIC_SUPABASE_ANON_KEY']) {
      expect(self.code, forbidden).not.toContain(forbidden);
    }
    // the branded type is obtained by a TYPE-ONLY import, erased at runtime
    expect(self.code).toContain("import type { ReviewerCapability, TrustedReviewerIdentity }");
    // and it exposes no way to brand an arbitrary string
    expect(self.code).not.toContain('asTrustedReviewerIdentity');
    expect(self.code).not.toMatch(/export function [a-zA-Z]*[Tt]rusted/);
  });

  it('17 exactly two assertion sites exist, each at its named location', () => {
    const pattern =
      /as\s+unknown\s+as\s+TrustedReviewerIdentity|as\s+TrustedReviewerIdentity|<TrustedReviewerIdentity>/g;
    const sources = productionSources();
    // discovered, not hard-coded: proves the scan covers the real surface
    expect(sources.map(s => s.file)).toContain('capability.ts');
    expect(sources.map(s => s.file)).toContain('review-history.ts');
    expect(sources.length).toBeGreaterThanOrEqual(5);

    const counts = new Map<string, number>();
    let total = 0;
    for (const { file, code } of sources) {
      const n = (code.match(pattern) ?? []).length;
      counts.set(file, n);
      total += n;
    }

    // LIVE AUTHORITY: one, and only in the capability path.
    expect(counts.get('capability.ts'), 'capability.ts').toBe(1);
    // HISTORICAL ATTRIBUTION: one, and only in the history reader.
    expect(counts.get('review-history.ts'), 'review-history.ts').toBe(1);
    // No third site anywhere in this trust surface.
    for (const { file } of sources) {
      if (file === 'capability.ts' || file === 'review-history.ts') continue;
      expect(counts.get(file), file).toBe(0);
    }
    expect(total).toBe(2);
  });

  it('18 each assertion site documents which of the two operations it is', () => {
    const byFile = new Map(productionSources().map(s => [s.file, s]));
    const cap = readFileSync(new URL('./capability.ts', import.meta.url), 'utf8');
    expect(cap).toContain('the only production mint');

    const hist = readFileSync(new URL('./review-history.ts', import.meta.url), 'utf8');
    expect(hist).toContain('HISTORICAL ATTRIBUTION ASSERTION');
    expect(hist).toContain('does not establish current authentication or authorization');
    expect(hist).toContain('requirePresentationApprove');
    // the history reader must not call itself a mint
    expect(byFile.get('review-history.ts')!.code).not.toContain('mint');
  });
});

// ── frozen HRA compatibility ────────────────────────────────────────────────

describe('hydrated history is consumable by the frozen functions', () => {
  const APPROVE_ID = '11111111-2222-4333-8444-555555555551';
  const REVOKE_ID = '44444444-2222-4333-8444-555555555554';

  async function hydrate(rows: Record<string, unknown>[]) {
    stubClient({ data: rows });
    const out = await loadDecisionsForOpportunity(ABOUT.opportunityKey);
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error('hydration failed');
    return out.decisions;
  }

  it('19 orderDecisions accepts hydrated records and orders them deterministically', async () => {
    const decisions = await hydrate([
      row({ review_decision_id: REVOKE_ID, request_id: 'r-later',
            decision_timestamp: '2026-09-30T19:00:00.000Z' }),
      row({ review_decision_id: APPROVE_ID, request_id: 'r-earlier',
            decision_timestamp: '2026-09-30T18:00:00.000Z' }),
    ]);
    const ordered = orderDecisions(decisions);
    expect(ordered.map(d => d.reviewDecisionId)).toEqual([APPROVE_ID, REVOKE_ID]);
  });

  it('20 deriveDecisionStatus reads a hydrated approval as APPROVED_CURRENT', async () => {
    const decisions = await hydrate([row({ review_decision_id: APPROVE_ID })]);
    const status = deriveDecisionStatus(decisions, ABOUT);
    expect(status.status).toBe('APPROVED_CURRENT');
    expect(status.decisionId).toBe(APPROVE_ID);
  });

  it('21 a hydrated REVOKE de-authorizes the binding through resolveRevocations', async () => {
    const decisions = await hydrate([
      row({ review_decision_id: APPROVE_ID, request_id: 'r-approve',
            decision_timestamp: '2026-09-30T18:00:00.000Z' }),
      row({ review_decision_id: REVOKE_ID, request_id: 'r-revoke',
            decision_type: 'REVOKE', revokes_review_decision_id: APPROVE_ID,
            decision_timestamp: '2026-09-30T19:00:00.000Z' }),
    ]);
    const status = deriveDecisionStatus(decisions, ABOUT);
    expect(status.status).toBe('REVOKED');
    expect(status.consideredDecisionIds).toEqual([APPROVE_ID, REVOKE_ID]);
  });

  it('22 a REJECT history reads as REJECTED_CURRENT', async () => {
    const decisions = await hydrate([row({
      decision_type: 'REJECT', structured_rejection_reason: 'evidence_not_convincing',
    })]);
    expect(deriveDecisionStatus(decisions, ABOUT).status).toBe('REJECTED_CURRENT');
  });

  it('23 derived status is INVARIANT under the hydrated reviewer identity', async () => {
    // The proof that historical attribution grants no authority: swapping the
    // recorded reviewer changes nothing the frozen layer decides.
    const a = await hydrate([row({ reviewer_user_id: REVIEWER })]);
    const b = await hydrate([row({ reviewer_user_id: 'c0ffee00-dead-4bee-8fed-0123456789ab' })]);
    const sa = deriveDecisionStatus(a, ABOUT);
    const sb = deriveDecisionStatus(b, ABOUT);
    expect(sb.status).toBe(sa.status);
    expect(sb.decisionId).toBe(sa.decisionId);
    expect(sb.reason).toBe(sa.reason);
    // the identities really did differ
    expect(String(b[0].reviewerId)).not.toBe(String(a[0].reviewerId));
  });

  it('24 history for a different opportunity is UNREVIEWED against this packet', async () => {
    const decisions = await hydrate([row({ opportunity_key: 'opp:something-else' })]);
    expect(deriveDecisionStatus(decisions, ABOUT).status).toBe('UNREVIEWED');
  });

  it('25 the seven accepted packet hashes are unchanged by this tranche', () => {
    const accepted: Record<string, string> = {
      'https://michaelhingson.com/about/': 'cb4bfaa08dae48871f7b8e90a6973aef',
      'https://michaelhingson.com/accessibility-statement/': '36c27a3a7df6daa2c99e764756ccbc2c',
      'https://michaelhingson.com/author/': 'b15cd876d69396a5789eb5734cd2ed6a',
      'https://michaelhingson.com/privacy-policy/': 'eddae93ac9f2d6e81a7d758071f962b7',
      'band:fragile': 'eea163d288f2466e4eb54842061a886d',
      'fact_attribution': 'f59f39474e538a049e5a6a934a1671ee',
      'qualifier_preservation': '26712cba94dbcf224d03a7b56c800a6b',
    };
    expect(review.packets).toHaveLength(7);
    for (const p of review.packets) {
      expect(reviewPacketHash(toReviewPacketView(p)), p.subject).toBe(accepted[p.subject]);
    }
  });

  it('26 the history reader stays isolated from orchestration and HTTP concerns', () => {
    // DURABLE INVARIANT. This asserts what review-history.ts IS, not which
    // sibling files happen to exist beside it.
    //
    // It previously also asserted that presentation-review-service.ts did not
    // exist. That encoded the Phase 2b-C1 boundary at a moment when no
    // orchestration layer was authorized, and it became obsolete the moment
    // Phase 2b-C2 was authorized to create exactly that file. Later phases may
    // add orchestration (2b-C2) and an HTTP route (2b-C3) alongside the reader;
    // what must never change is that neither leaks INTO the reader.
    const self = productionSources().find(f => f.file === 'review-history.ts')!;
    // the reader must still be present and substantive, so this cannot pass by
    // the file having been emptied or removed
    expect(self.code).toContain('loadDecisionsForOpportunity');
    expect(self.code.length).toBeGreaterThan(1000);
    for (const forbidden of ['NextResponse', 'NextRequest', 'next/server',
      'deriveReview', 'qualify(', 'toReviewPacketView', 'recordPresentationReview',
      'deriveApprovalEligibility', 'derivePresentationSnapshotFromDecision',
      'validateReviewDecision', 'compareBinding']) {
      expect(self.code, forbidden).not.toContain(forbidden);
    }
  });
});
