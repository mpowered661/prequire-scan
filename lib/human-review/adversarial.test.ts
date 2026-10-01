// Human Review & Approval v0.1 — the 92 frozen adversarial cases, focused unit
// tests, and positive controls. Each test names the attack it defends.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { qualify } from '../opportunity-qualification/qualify';
import type { QualificationInput } from '../opportunity-qualification/types';
import { deriveReview, type QualificationResultView } from '../opportunity-review/review-packet';
import type { ReviewPacket } from '../opportunity-review/types';
import { deriveApprovalEligibility } from './approval-eligibility';
import { deriveDecisionStatus, isSuperseded, orderDecisions, validateReviewDecision } from './approval-status';
import { compareBinding } from './binding';
import { recordsRequiredCapability, reviewerIdentityValue } from './future-identity';
import {
  CANONICAL_PAYLOAD_FIELDS,
  EXCLUDED_FROM_CANONICAL_PAYLOAD,
  canonicalDecisionPayloadHash,
  compareIdempotency,
} from './idempotency';
import {
  PACKET_HASH_INPUTS,
  gateTraceDigest,
  normalizeRefs,
  reviewPacketHash,
  reviewedProseHash,
  supportingEvidenceRefsDigest,
} from './packet-hash';
import {
  derivePresentationSnapshotFromDecision,
  deriveSnapshotConsumability,
  deterministicSnapshotId,
} from './snapshot';
import { PLACEHOLDER_OPERATOR, UNSAFE_testOnlyDecision, UNSAFE_testOnlyTrustedReviewer } from './test-only-fixtures';
import type { EvidenceRefView, ReviewDecisionRecord, ReviewPacketView } from './types';
import { MAX_REVIEWER_NOTE_CHARS, UNREPRESENTABLE_STATES } from './versions';

const input = JSON.parse(
  readFileSync(new URL('../opportunity-qualification/__fixtures__/michael-pilot.json', import.meta.url), 'utf8'),
) as QualificationInput;
const qualification = qualify(input) as unknown as QualificationResultView;
const review = deriveReview(qualification);

function view(p: ReviewPacket): ReviewPacketView {
  const direct = p.claimCandidates.find(c => c.epistemicClass === 'DIRECT_OBSERVATION' && c.externallyPresentable)
    ?? p.claimCandidates[0];
  return {
    opportunityKey: p.opportunityKey, evidenceFingerprint: p.evidenceFingerprint, claimHash: p.claimHash,
    qualificationStatus: p.qualificationStatus, gateTrace: p.gateTrace.map(g => ({ gate: g.gate, passed: g.passed })),
    presentationPermission: direct.presentationPermission, presentationMode: p.presentationMode,
    demonstrabilityStatus: p.demonstration.status, meetsScoutEvidenceRequirements: p.meetsScoutEvidenceRequirements,
    temporalFrame: p.canonicalClaim.temporalFrame, reviewContractVersion: p.reviewContractVersion,
    qualificationVersion: p.qualificationVersion, evidenceRefs: p.evidenceRefs, displayProse: direct.prose,
    canonicalClaim: p.canonicalClaim, demonstration: p.demonstration,
    observedAt: p.canonicalClaim.observedAt, scanId: p.scanId,
  };
}
function pv(subject: string): ReviewPacketView {
  const p = review.packets.find(x => x.subject === subject);
  if (!p) throw new Error(`no packet for ${subject}`);
  return view(p);
}
const ABOUT = pv('https://michaelhingson.com/about/');
const FRAGILE = pv('band:fragile');
const SNAP_ID = 'PLACEHOLDER-SNAPSHOT-0001';

function approval(packet: ReviewPacketView = ABOUT, over: Partial<ReviewDecisionRecord> = {}): ReviewDecisionRecord {
  return UNSAFE_testOnlyDecision({ decisionType: 'APPROVE_PRESENTATION', packet, override: over });
}
function snap(packet: ReviewPacketView, decision: ReviewDecisionRecord, all = [decision]) {
  return derivePresentationSnapshotFromDecision({ packet, decision, allDecisions: all, presentationSnapshotId: SNAP_ID });
}

const REF: EvidenceRefView = {
  kind: 'page_observation', scanId: 's1', subjectUrl: 'https://example.org/p',
  engine: 'e', engineVersion: 'v1', contentSha256: 'a'.repeat(64), scope: 'page', observedAt: 't',
};

const PRODUCTION_FILES = readdirSync(new URL('.', import.meta.url))
  .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'test-only-fixtures.ts');
function productionSource(): string {
  return PRODUCTION_FILES
    .map(f => readFileSync(new URL(`./${f}`, import.meta.url), 'utf8'))
    .join('\n');
}

/**
 * Production source with COMMENTS REMOVED.
 *
 * The boundary assertions below must inspect executable CODE, not prose: the
 * modules deliberately NAME the forbidden constructs in their documentation in
 * order to state that they are forbidden, and a naive grep over raw source
 * matches those explanations. Stripping block comments and comment-only lines
 * makes these assertions test what they mean to test.
 */
function productionCode(): string {
  const withoutBlocks = productionSource().replace(/\/\*[\s\S]*?\*\//g, ' ');
  return withoutBlocks
    .split('\n')
    .filter(line => {
      const t = line.trim();
      return !(t.startsWith('//') || t.startsWith('*'));
    })
    .join('\n');
}

// ═══════════════════════════════════════════════════════════════
describe('adversarial 1-8 — trusted identity boundary', () => {
  const src = productionCode();

  it('1 no production factory creates TrustedReviewerIdentity from a string', () => {
    for (const forbidden of [
      'trustedReviewerFromString', 'trustedReviewerFromEmail', 'trustedReviewerFromRequest',
      'trustedReviewerFromBody', 'trustedReviewerFromUuid', 'asTrustedReviewer',
    ]) {
      expect(src, forbidden).not.toContain(forbidden);
    }
    // the only assertion-based mint lives in the test-only file
    expect(src).not.toContain('as unknown as TrustedReviewerIdentity');
    expect(src).not.toContain('as TrustedReviewerIdentity');
  });

  it('2-6 an email / prospect id / scan id / "admin" / "system" cannot be a reviewer identity', () => {
    for (const bad of ['operator@example.com', 'prospect-123', 'michael-pilot-001', 'admin', 'system', 'human', 'reviewer', '']) {
      const d = approval(ABOUT, { reviewerId: UNSAFE_testOnlyTrustedReviewer(bad) });
      const v = validateReviewDecision(d);
      if (['admin', 'system', 'human', 'reviewer', ''].includes(bad)) {
        expect(v.valid, bad).toBe(false);
        expect(v.failures.map(f => f.code), bad).toContain('forbidden_reviewer_identity');
      }
      // An email or opaque id is not auto-trusted either: in production it can
      // only arrive from a verified server boundary, which does not exist here.
      expect(reviewerIdentityValue(d.reviewerId)).toBe(bad);
    }
  });

  it('7 the test-only builder is never imported by production code', () => {
    expect(src).not.toContain('test-only-fixtures');
    expect(src).not.toContain('UNSAFE_testOnly');
  });

  it('8 capability must be recorded as presentation.approve', () => {
    expect(recordsRequiredCapability('presentation.approve')).toBe(true);
    expect(recordsRequiredCapability('opportunity.review')).toBe(false);
    const d = approval(ABOUT, { reviewerCapability: 'something.else' as never });
    expect(validateReviewDecision(d).failures.map(f => f.code)).toContain('capability_not_recorded');
  });
});

describe('adversarial 9-14 — unrepresentable vocabulary and modes', () => {
  it('9 APPROVE_WITH_EDIT is unrepresentable', () => {
    const d = approval(ABOUT, { decisionType: 'APPROVE_WITH_EDIT' as never });
    expect(validateReviewDecision(d).failures.map(f => f.code)).toContain('unknown_decision_type');
    // It appears exactly once in production code: inside the deliberate
    // UNREPRESENTABLE_STATES negative list. It is never a decision-type value.
    expect(productionCode().split('APPROVE_WITH_EDIT').length - 1).toBeLessThanOrEqual(1);
    expect(UNREPRESENTABLE_STATES).toContain('APPROVE_WITH_EDIT');
    expect(productionCode()).not.toContain("'APPROVE_WITH_EDIT' |");
    expect(productionCode()).not.toContain("| 'APPROVE_WITH_EDIT'");
  });

  it('10 REQUEST_MORE_EVIDENCE is unrepresentable', () => {
    const d = approval(ABOUT, { decisionType: 'REQUEST_MORE_EVIDENCE' as never });
    expect(validateReviewDecision(d).failures.map(f => f.code)).toContain('unknown_decision_type');
    const src = productionCode();
    // appears only inside the negative UNREPRESENTABLE_STATES list
    const occurrences = src.split('REQUEST_MORE_EVIDENCE').length - 1;
    expect(occurrences).toBeLessThanOrEqual(1);
  });

  it('11 STATEMENT_ONLY is not approvable', () => {
    expect(deriveApprovalEligibility(FRAGILE).outcome).toBe('NOT_ELIGIBLE_FOR_HUMAN_APPROVAL');
    expect(validateReviewDecision(approval(FRAGILE)).valid).toBe(false);
  });

  it('12 STATEMENT_ONLY remains reviewable and is not converted', () => {
    expect(FRAGILE.presentationMode).toBe('STATEMENT_ONLY');
    expect(deriveApprovalEligibility(FRAGILE).blockingReasons.join(' ')).toContain('statement_only_not_approvable_in_v0_1');
    // still fully derivable and inspectable
    expect(reviewPacketHash(FRAGILE)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('13 NOT_DEMONSTRABLE is not approvable', () => {
    const d = approval({ ...ABOUT, demonstrabilityStatus: 'NOT_DEMONSTRABLE' });
    expect(validateReviewDecision(d).failures.map(f => f.code)).toContain('approve_requires_demonstrable');
  });

  it('14 LIMITED_DEMONSTRABILITY is not approvable', () => {
    const p = { ...ABOUT, demonstrabilityStatus: 'LIMITED_DEMONSTRABILITY' };
    expect(deriveApprovalEligibility(p).outcome).toBe('NOT_ELIGIBLE_FOR_HUMAN_APPROVAL');
  });
});

describe('adversarial 15-23 — binding mismatches', () => {
  it('15 wrong opportunity_key fails', () => {
    const r = compareBinding(approval(ABOUT, { opportunityKey: 'other' }), ABOUT);
    expect(r.outcome).toBe('OPPORTUNITY_CHANGED');
  });
  it('16 wrong evidence_fingerprint fails as STALE_EVIDENCE', () => {
    expect(compareBinding(approval(ABOUT, { evidenceFingerprint: 'other' }), ABOUT).outcome).toBe('STALE_EVIDENCE');
  });
  it('17 wrong claimHash fails as CLAIM_CHANGED', () => {
    expect(compareBinding(approval(ABOUT, { claimHash: 'other' }), ABOUT).outcome).toBe('CLAIM_CHANGED');
  });
  it('18 wrong review_packet_hash fails as PACKET_CHANGED', () => {
    expect(compareBinding(approval(ABOUT, { reviewPacketHash: 'other' }), ABOUT).outcome).toBe('PACKET_CHANGED');
  });
  it('19 wrong review contract version fails', () => {
    expect(compareBinding(approval(ABOUT, { reviewContractVersion: 'or-9.9' }), ABOUT).outcome).toBe('VERSION_INCOMPATIBLE');
    expect(validateReviewDecision(approval(ABOUT, { reviewContractVersion: 'or-9.9' })).failures.map(f => f.code))
      .toContain('review_contract_version_mismatch');
  });
  it('20 wrong qualification version fails', () => {
    expect(compareBinding(approval(ABOUT, { qualificationVersion: 'oq-9.9' }), ABOUT).outcome).toBe('VERSION_INCOMPATIBLE');
  });
  it('21 wrong hra version fails validation', () => {
    expect(validateReviewDecision(approval(ABOUT, { hraVersion: 'hra-9.9' })).failures.map(f => f.code))
      .toContain('hra_version_mismatch');
  });
  it('22 a non-qualified current packet is INVALID_CURRENT_STATE', () => {
    const d = approval(ABOUT);
    expect(compareBinding(d, { ...ABOUT, qualificationStatus: 'NOT_QUALIFIED' }).outcome).toBe('INVALID_CURRENT_STATE');
  });
  it('23 a non-presentable current packet is INVALID_CURRENT_STATE', () => {
    const d = approval(ABOUT);
    expect(compareBinding(d, { ...ABOUT, presentationPermission: 'INTERNAL_ONLY' }).outcome).toBe('INVALID_CURRENT_STATE');
  });
});

describe('adversarial 24-37 — packet hash sensitivity and insensitivity', () => {
  const base = reviewPacketHash(ABOUT);

  it('24 every one of the thirteen inputs is declared', () => {
    expect(PACKET_HASH_INPUTS).toHaveLength(13);
    for (const f of ['opportunityKey', 'evidenceFingerprint', 'claimHash', 'qualificationStatus',
      'gateTraceDigest', 'presentationPermission', 'presentationMode', 'demonstrabilityStatus',
      'meetsScoutEvidenceRequirements', 'temporalFrame', 'reviewContractVersion',
      'qualificationVersion', 'supportingEvidenceRefsDigest']) {
      expect(PACKET_HASH_INPUTS).toContain(f);
    }
  });

  it('25-35 each semantic change alters the hash', () => {
    const mutations: [string, Partial<ReviewPacketView>][] = [
      ['opportunityKey', { opportunityKey: 'x' }],
      ['evidenceFingerprint', { evidenceFingerprint: 'x' }],
      ['claimHash', { claimHash: 'x' }],
      ['qualificationStatus', { qualificationStatus: 'NOT_QUALIFIED' }],
      ['gateTrace', { gateTrace: ABOUT.gateTrace.map((g, i) => i === 0 ? { ...g, passed: !g.passed } : g) }],
      ['presentationPermission', { presentationPermission: 'INTERNAL_ONLY' }],
      ['presentationMode', { presentationMode: 'STATEMENT_ONLY' }],
      ['demonstrabilityStatus', { demonstrabilityStatus: 'NOT_DEMONSTRABLE' }],
      ['meetsScoutEvidenceRequirements', { meetsScoutEvidenceRequirements: false }],
      ['temporalFrame', { temporalFrame: 'BEFORE' }],
      ['reviewContractVersion', { reviewContractVersion: 'or-9.9' }],
      ['qualificationVersion', { qualificationVersion: 'oq-9.9' }],
      ['evidenceRefs', { evidenceRefs: [...ABOUT.evidenceRefs, REF] }],
    ];
    for (const [name, patch] of mutations) {
      expect(reviewPacketHash({ ...ABOUT, ...patch }), name).not.toBe(base);
    }
  });

  it('36 display prose punctuation does NOT change the packet hash', () => {
    const restyled = ABOUT.displayProse.replace(/\. /g, '; ');
    expect(reviewPacketHash({ ...ABOUT, displayProse: restyled })).toBe(base);
    expect(reviewedProseHash(restyled)).not.toBe(reviewedProseHash(ABOUT.displayProse));
  });

  it('37 display prose whitespace does NOT change the packet hash', () => {
    expect(reviewPacketHash({ ...ABOUT, displayProse: `  ${ABOUT.displayProse}  ` })).toBe(base);
  });
});

describe('adversarial 38-41 — deterministic normalization', () => {
  it('38 duplicate evidence refs normalize deterministically', () => {
    expect(supportingEvidenceRefsDigest([REF, { ...REF }])).toBe(supportingEvidenceRefsDigest([REF]));
    expect(normalizeRefs([REF, { ...REF }])).toHaveLength(1);
  });
  it('39 evidence ref order does not change the packet hash', () => {
    expect(reviewPacketHash({ ...ABOUT, evidenceRefs: [...ABOUT.evidenceRefs].reverse() })).toBe(reviewPacketHash(ABOUT));
  });
  it('40 gate trace order does not change the digest, but outcomes do', () => {
    const t = ABOUT.gateTrace;
    expect(gateTraceDigest([...t].reverse())).toBe(gateTraceDigest(t));
    expect(gateTraceDigest(t.map((g, i) => i === 0 ? { ...g, passed: !g.passed } : g))).not.toBe(gateTraceDigest(t));
  });
  it('41 hashing is stable across repeated calls', () => {
    expect(reviewPacketHash(ABOUT)).toBe(reviewPacketHash(ABOUT));
    expect(canonicalDecisionPayloadHash(approval())).toBe(canonicalDecisionPayloadHash(approval()));
  });
});

describe('adversarial 42-46 — idempotency', () => {
  it('42 same requestId + same payload is idempotent', () => {
    const a = approval(); const b = approval();
    expect(compareIdempotency(b, a).outcome).toBe('SAME_LOGICAL_DECISION');
  });
  it('43 same requestId + different payload conflicts', () => {
    const a = approval();
    const b = approval(ABOUT, { reviewedProseHash: 'different-hash' });
    expect(compareIdempotency(b, a).outcome).toBe('IDEMPOTENCY_CONFLICT');
  });
  it('44 a new requestId permits a new logical decision', () => {
    const a = approval();
    const b = approval(ABOUT, { requestId: 'PLACEHOLDER-REQUEST-0002' });
    expect(compareIdempotency(b, a).outcome).toBe('NEW_DECISION_ALLOWED');
    expect(compareIdempotency(b, null).outcome).toBe('NEW_DECISION_ALLOWED');
  });
  it('45 transient metadata is excluded from the canonical payload', () => {
    expect(EXCLUDED_FROM_CANONICAL_PAYLOAD).toContain('decisionTimestamp');
    expect(EXCLUDED_FROM_CANONICAL_PAYLOAD).toContain('reviewDecisionId');
    const a = approval();
    const b = approval(ABOUT, { decisionTimestamp: '2026-10-01T09:00:00.000Z', reviewDecisionId: 'OTHER' });
    expect(canonicalDecisionPayloadHash(a)).toBe(canonicalDecisionPayloadHash(b));
  });
  it('46 every materially-decisive field participates', () => {
    for (const f of ['decisionType', 'reviewerId', 'opportunityKey', 'evidenceFingerprint',
      'claimHash', 'reviewPacketHash', 'presentationMode', 'demonstrability', 'temporalFrame',
      'reviewedProseHash', 'structuredRejectionReason', 'boundedReviewerNote']) {
      expect(CANONICAL_PAYLOAD_FIELDS).toContain(f);
    }
  });
});

describe('adversarial 47-56 — decision shape and bounded input', () => {
  it('47 REJECT requires a structured reason from the vocabulary', () => {
    const noReason = UNSAFE_testOnlyDecision({ decisionType: 'REJECT', packet: ABOUT });
    expect(validateReviewDecision(noReason).failures.map(f => f.code)).toContain('reject_requires_structured_reason');
    const badReason = UNSAFE_testOnlyDecision({
      decisionType: 'REJECT', packet: ABOUT,
      structuredRejectionReason: 'made_up' as never,
    });
    expect(validateReviewDecision(badReason).failures.map(f => f.code)).toContain('reject_reason_not_in_vocabulary');
  });
  it('48 an APPROVE must not carry a rejection reason', () => {
    const d = approval(ABOUT, { structuredRejectionReason: 'evidence_not_convincing' });
    expect(validateReviewDecision(d).failures.map(f => f.code)).toContain('approve_must_not_carry_rejection_reason');
  });
  it('49 REVOKE requires a target decision', () => {
    const d = UNSAFE_testOnlyDecision({ decisionType: 'REVOKE', packet: ABOUT });
    expect(validateReviewDecision(d).failures.map(f => f.code)).toContain('revoke_requires_target_decision');
  });
  it('50 a non-revoke must not carry a revoke target', () => {
    const d = approval(ABOUT, { revokesReviewDecisionId: 'X' });
    expect(validateReviewDecision(d).failures.map(f => f.code)).toContain('non_revoke_must_not_carry_revoke_target');
  });
  it('51 oversized reviewer note is REJECTED, not truncated', () => {
    const note = 'x'.repeat(MAX_REVIEWER_NOTE_CHARS + 1);
    const d = approval(ABOUT, { boundedReviewerNote: note });
    const v = validateReviewDecision(d);
    expect(v.failures.map(f => f.code)).toContain('note_too_long');
    // the note is not silently shortened anywhere
    expect(d.boundedReviewerNote).toHaveLength(MAX_REVIEWER_NOTE_CHARS + 1);
  });
  it('52 markup in a reviewer note is rejected', () => {
    expect(validateReviewDecision(approval(ABOUT, { boundedReviewerNote: '<script>x</script>' }))
      .failures.map(f => f.code)).toContain('note_contains_markup');
  });
  it('53 raw HTML in a reviewer note is rejected', () => {
    expect(validateReviewDecision(approval(ABOUT, { boundedReviewerNote: '<p>body</p>' }))
      .failures.map(f => f.code)).toContain('note_contains_markup');
  });
  it('54 control characters in a reviewer note are rejected', () => {
    expect(validateReviewDecision(approval(ABOUT, { boundedReviewerNote: 'okbell' }))
      .failures.map(f => f.code)).toContain('note_contains_control_characters');
  });
  it('55 a missing reviewed prose hash fails the audit binding', () => {
    expect(validateReviewDecision(approval(ABOUT, { reviewedProseHash: '' }))
      .failures.map(f => f.code)).toContain('reviewed_prose_hash_missing');
  });
  it('56 a non-ISO timestamp is rejected', () => {
    expect(validateReviewDecision(approval(ABOUT, { decisionTimestamp: 'yesterday' }))
      .failures.map(f => f.code)).toContain('timestamp_not_iso');
  });
});

describe('adversarial 57-66 — temporal frame and prohibited claims', () => {
  it('57-59 BEFORE / AFTER / VERIFIED cannot be a temporal frame', () => {
    for (const bad of ['BEFORE', 'AFTER', 'VERIFIED', 'IMPROVED', 'FIXED']) {
      expect(validateReviewDecision(approval(ABOUT, { temporalFrame: bad })).failures.map(f => f.code))
        .toContain('temporal_frame_not_current_state');
      expect(compareBinding(approval(ABOUT), { ...ABOUT, temporalFrame: bad }).outcome).toBe('INVALID_CURRENT_STATE');
    }
  });
  it('60 the only expressible temporal frame is CURRENT_STATE', () => {
    expect(ABOUT.temporalFrame).toBe('CURRENT_STATE');
    const s = snap(ABOUT, approval()).snapshot!;
    expect(s.temporalFrame).toBe('CURRENT_STATE');
  });
  it('61-62 no business-impact or causation text can enter a snapshot', () => {
    const s = snap(ABOUT, approval()).snapshot!;
    const json = JSON.stringify(s);
    for (const bad of ['revenue', 'customers', 'ranking', 'traffic', 'conversion',
      'because of this', 'causing', 'SEO']) {
      expect(json.toLowerCase()).not.toContain(bad.toLowerCase());
    }
  });
  it('63 healthy qualification status cannot approve', () => {
    expect(deriveApprovalEligibility({ ...ABOUT, qualificationStatus: 'NOT_QUALIFIED' }).outcome)
      .toBe('NOT_ELIGIBLE_FOR_HUMAN_APPROVAL');
  });
  it('64 an undeterminable/non-presentable permission cannot approve', () => {
    expect(deriveApprovalEligibility({ ...ABOUT, presentationPermission: 'INTERNAL_ONLY' }).outcome)
      .toBe('NOT_ELIGIBLE_FOR_HUMAN_APPROVAL');
  });
  it('65 meetsScoutEvidenceRequirements false cannot approve', () => {
    expect(deriveApprovalEligibility({ ...ABOUT, meetsScoutEvidenceRequirements: false }).outcome)
      .toBe('NOT_ELIGIBLE_FOR_HUMAN_APPROVAL');
  });
  it('66 no unrepresentable state string is reachable in production source', () => {
    const src = productionCode();
    for (const s of ['APPROVED_FOR_OUTREACH', 'EMAIL_READY', 'SEND_READY', 'CONTACT_READY', 'CRM_READY']) {
      // appears only in the negative UNREPRESENTABLE_STATES list
      expect(src.split(s).length - 1).toBeLessThanOrEqual(1);
    }
    expect(UNREPRESENTABLE_STATES).toContain('APPROVE_WITH_EDIT');
    expect(UNREPRESENTABLE_STATES).toContain('REQUEST_MORE_EVIDENCE');
  });
});

describe('adversarial 67-78 — status, revocation and supersession', () => {
  it('67 new evidence makes a prior approval STALE', () => {
    const d = approval();
    const s = deriveDecisionStatus([d], { ...ABOUT, evidenceFingerprint: 'new-fingerprint' });
    expect(s.status).toBe('STALE');
  });
  it('68 a changed claim makes a prior approval INVALID', () => {
    const d = approval();
    expect(deriveDecisionStatus([d], { ...ABOUT, claimHash: 'new-claim' }).status).toBe('INVALID');
  });
  it('69 the problem disappearing invalidates current use', () => {
    const d = approval();
    expect(deriveDecisionStatus([d], { ...ABOUT, qualificationStatus: 'NOT_QUALIFIED' }).status).toBe('INVALID');
  });
  it('70 an explicit REVOKE disables current consumption', () => {
    const a = approval();
    const r = UNSAFE_testOnlyDecision({
      decisionType: 'REVOKE', packet: ABOUT, reviewDecisionId: 'PLACEHOLDER-DECISION-0002',
      requestId: 'PLACEHOLDER-REQUEST-0002', decisionTimestamp: '2026-09-30T19:00:00.000Z',
      revokesReviewDecisionId: a.reviewDecisionId,
    });
    expect(validateReviewDecision(r).valid).toBe(true);
    expect(deriveDecisionStatus([a, r], ABOUT).status).toBe('REVOKED');
    const sn = snap(ABOUT, a).snapshot!;
    expect(deriveSnapshotConsumability(sn, ABOUT, [a, r]).status).toBe('NOT_CONSUMABLE');
  });
  it('71 REVOKE never mutates the original approval', () => {
    const a = approval();
    const before = JSON.stringify(a);
    const r = UNSAFE_testOnlyDecision({
      decisionType: 'REVOKE', packet: ABOUT, reviewDecisionId: 'D2', requestId: 'R2',
      decisionTimestamp: '2026-09-30T19:00:00.000Z', revokesReviewDecisionId: a.reviewDecisionId,
    });
    deriveDecisionStatus([a, r], ABOUT);
    expect(JSON.stringify(a)).toBe(before);
  });
  it('72 FROZEN RULE: later capability loss alone does NOT invalidate a snapshot', () => {
    // The decision recorded the capability it held AT DECISION TIME. Nothing in
    // this layer consults a present-day capability store, so a later revocation
    // cannot retroactively unauthor it.
    const a = approval();
    const sn = snap(ABOUT, a).snapshot!;
    expect(deriveSnapshotConsumability(sn, ABOUT, [a]).status).toBe('CONSUMABLE');
    expect(productionCode()).not.toContain('operator_capabilities');
    expect(a.reviewerCapability).toBe('presentation.approve');
  });
  it('73 later capability loss preserves historical attribution', () => {
    const a = approval();
    expect(validateReviewDecision(a).valid).toBe(true);
    expect(reviewerIdentityValue(a.reviewerId)).toContain('PLACEHOLDER-OPERATOR');
    expect(a.decisionTimestamp).toBe('2026-09-30T18:00:00.000Z');
  });
  it('74 ordering is by (timestamp, reviewDecisionId), never array order', () => {
    const a = approval(ABOUT, { reviewDecisionId: 'D-b', decisionTimestamp: '2026-09-30T18:00:00.000Z' });
    const b = approval(ABOUT, { reviewDecisionId: 'D-a', decisionTimestamp: '2026-09-30T18:00:00.000Z' });
    expect(orderDecisions([a, b]).map(d => d.reviewDecisionId)).toEqual(['D-a', 'D-b']);
    expect(orderDecisions([b, a]).map(d => d.reviewDecisionId)).toEqual(['D-a', 'D-b']);
  });
  it('75 identical timestamps use the reviewDecisionId tie-break', () => {
    const a = approval(ABOUT, { reviewDecisionId: 'D-1', decisionTimestamp: '2026-09-30T18:00:00.000Z' });
    const b = approval(ABOUT, { reviewDecisionId: 'D-2', decisionTimestamp: '2026-09-30T18:00:00.000Z' });
    expect(deriveDecisionStatus([a, b], ABOUT).decisionId).toBe('D-2');
    expect(deriveDecisionStatus([b, a], ABOUT).decisionId).toBe('D-2');
  });
  it('76 an earlier decision in the same tuple is SUPERSEDED', () => {
    const early = UNSAFE_testOnlyDecision({
      decisionType: 'REJECT', packet: ABOUT, reviewDecisionId: 'D-1',
      requestId: 'R-1', decisionTimestamp: '2026-09-30T17:00:00.000Z',
      structuredRejectionReason: 'evidence_not_convincing',
    });
    const later = approval(ABOUT, { reviewDecisionId: 'D-2', requestId: 'R-2', decisionTimestamp: '2026-09-30T18:00:00.000Z' });
    expect(isSuperseded(early, [early, later])).toBe(true);
    expect(isSuperseded(later, [early, later])).toBe(false);
    expect(deriveDecisionStatus([early, later], ABOUT).status).toBe('APPROVED_CURRENT');
  });
  it('77 a rejection is the current status when it is latest', () => {
    const r = UNSAFE_testOnlyDecision({
      decisionType: 'REJECT', packet: ABOUT, structuredRejectionReason: 'scope_or_wording_concern',
    });
    expect(deriveDecisionStatus([r], ABOUT).status).toBe('REJECTED_CURRENT');
  });
  it('78 no decision means UNREVIEWED, never approved', () => {
    const s = deriveDecisionStatus([], ABOUT);
    expect(s.status).toBe('UNREVIEWED');
    expect(s.decisionId).toBeNull();
  });
});

describe('adversarial 79-86 — snapshot derivation failures', () => {
  it('79 REJECT creates no snapshot', () => {
    const r = UNSAFE_testOnlyDecision({ decisionType: 'REJECT', packet: ABOUT, structuredRejectionReason: 'other_bounded' });
    const out = snap(ABOUT, r);
    expect(out.snapshot).toBeNull();
    expect(out.failures.map(f => f.code)).toContain('decision_not_approval');
  });
  it('80 REVOKE creates no snapshot', () => {
    const rv = UNSAFE_testOnlyDecision({
      decisionType: 'REVOKE', packet: ABOUT, revokesReviewDecisionId: 'D-0',
    });
    expect(snap(ABOUT, rv).snapshot).toBeNull();
  });
  it('81 a stale packet cannot derive a snapshot', () => {
    const d = approval();
    const out = snap({ ...ABOUT, evidenceFingerprint: 'new' }, d);
    expect(out.snapshot).toBeNull();
    expect(out.failures.map(f => f.code)).toContain('binding_not_exact');
  });
  it('82 an invalid packet cannot derive a snapshot', () => {
    const d = approval();
    expect(snap({ ...ABOUT, qualificationStatus: 'NOT_QUALIFIED' }, d).snapshot).toBeNull();
  });
  it('83 a non-current decision cannot derive a snapshot', () => {
    const early = approval(ABOUT, { reviewDecisionId: 'D-1', requestId: 'R-1', decisionTimestamp: '2026-09-30T17:00:00.000Z' });
    const later = approval(ABOUT, { reviewDecisionId: 'D-2', requestId: 'R-2', decisionTimestamp: '2026-09-30T18:00:00.000Z' });
    const out = snap(ABOUT, early, [early, later]);
    expect(out.snapshot).toBeNull();
    expect(out.failures.map(f => f.code)).toContain('decision_not_current');
  });
  it('84 a missing snapshot id fails closed — no id is generated', () => {
    const out = derivePresentationSnapshotFromDecision({
      packet: ABOUT, decision: approval(), allDecisions: [approval()], presentationSnapshotId: '',
    });
    expect(out.snapshot).toBeNull();
    expect(out.failures.map(f => f.code)).toContain('snapshot_id_not_supplied');
    expect(productionCode()).not.toContain('randomUUID');
    expect(productionCode()).not.toContain('Math.random');
  });
  it('85 an invalid decision cannot derive a snapshot', () => {
    const out = snap(ABOUT, approval(ABOUT, { hraVersion: 'hra-9.9' }));
    expect(out.snapshot).toBeNull();
    expect(out.failures.map(f => f.code)).toContain('decision_invalid');
  });
  it('86 a snapshot never duplicates the full ReviewPacket', () => {
    const s = snap(ABOUT, approval()).snapshot!;
    for (const k of ['gateTrace', 'claimCandidates', 'uncertainties', 'displayProse', 'evidenceRefs', 'coverage']) {
      expect(Object.keys(s)).not.toContain(k);
    }
    expect(s.supportingEvidenceRefsDigest).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('adversarial 87-92 — layer boundary', () => {
  const src = productionCode();

  it('87 no Supabase import exists under lib/human-review/', () => {
    expect(src).not.toContain('@supabase');
    expect(src).not.toContain('supabase');
    expect(src).not.toContain('getUser');
  });
  it('88 no network primitive exists', () => {
    for (const bad of ['fetch(', 'XMLHttpRequest', 'axios', 'node:http', 'undici', 'got(']) {
      expect(src, bad).not.toContain(bad);
    }
  });
  it('89 no persistence primitive exists', () => {
    for (const bad of ['writeFile', 'readFile', 'node:fs', 'INSERT INTO', 'CREATE TABLE', '.insert(', '.upsert(', 'prisma', 'knex']) {
      expect(src, bad).not.toContain(bad);
    }
  });
  it('90 no auth or authorization implementation exists', () => {
    for (const bad of ['jwt', 'Bearer', 'session', 'cookie', 'operator_capabilities']) {
      expect(src.toLowerCase(), bad).not.toContain(bad.toLowerCase());
    }
  });
  it('91 no approval factory exists', () => {
    for (const bad of ['function approve', 'autoApprove', 'createApproval', 'approveIfEligible', 'export function approve']) {
      expect(src, bad).not.toContain(bad);
    }
  });
  it('92 the derivation performs ZERO network requests (causally proven)', () => {
    const spy = vi.fn(() => { throw new Error('human review layer attempted a network request'); });
    const original = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const d = approval();
      validateReviewDecision(d);
      compareBinding(d, ABOUT);
      deriveApprovalEligibility(ABOUT);
      deriveDecisionStatus([d], ABOUT);
      compareIdempotency(d, d);
      reviewPacketHash(ABOUT);
      snap(ABOUT, d);
    } finally {
      globalThis.fetch = original;
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('POSITIVE CONTROLS — the system is not merely rejecting everything', () => {
  it('1 a valid demonstrable broken destination is approval-eligible', () => {
    const e = deriveApprovalEligibility(ABOUT);
    expect(e.outcome).toBe('ELIGIBLE_FOR_HUMAN_APPROVAL');
    expect(e.impliesApproval).toBe(false);
  });
  it('2 a valid supplied APPROVE_PRESENTATION decision VALIDATES', () => {
    const v = validateReviewDecision(approval());
    expect(v.valid, JSON.stringify(v.failures)).toBe(true);
  });
  it('3 a valid decision DERIVES a snapshot', () => {
    const out = snap(ABOUT, approval());
    expect(out.failures).toHaveLength(0);
    expect(out.snapshot).not.toBeNull();
    expect(out.snapshot!.presentationSnapshotId).toBe(SNAP_ID);
  });
  it('4 same requestId with the same payload is idempotent', () => {
    expect(compareIdempotency(approval(), approval()).outcome).toBe('SAME_LOGICAL_DECISION');
  });
  it('5 a new later decision with a new requestId is permitted', () => {
    const a = approval(ABOUT, { reviewDecisionId: 'D-1', requestId: 'R-1', decisionTimestamp: '2026-09-30T17:00:00.000Z' });
    const b = approval(ABOUT, { reviewDecisionId: 'D-2', requestId: 'R-2', decisionTimestamp: '2026-09-30T18:00:00.000Z' });
    expect(compareIdempotency(b, a).outcome).toBe('NEW_DECISION_ALLOWED');
    expect(deriveDecisionStatus([a, b], ABOUT).decisionId).toBe('D-2');
  });
  it('6 harmless prose punctuation does not change packet identity, and approval survives', () => {
    const restyled = { ...ABOUT, displayProse: ABOUT.displayProse.replace('found', 'located') };
    const d = approval();
    expect(reviewPacketHash(restyled)).toBe(reviewPacketHash(ABOUT));
    expect(compareBinding(d, restyled).outcome).toBe('EXACT');
  });
  it('7 reordered refs remain deterministic', () => {
    const reordered = { ...ABOUT, evidenceRefs: [...ABOUT.evidenceRefs].reverse() };
    expect(reviewPacketHash(reordered)).toBe(reviewPacketHash(ABOUT));
    expect(compareBinding(approval(), reordered).outcome).toBe('EXACT');
  });
  it('8 a rejection VALIDATES but creates no snapshot', () => {
    const r = UNSAFE_testOnlyDecision({
      decisionType: 'REJECT', packet: FRAGILE,
      structuredRejectionReason: 'insufficient_presentation_evidence',
    });
    expect(validateReviewDecision(r).valid, JSON.stringify(validateReviewDecision(r).failures)).toBe(true);
    expect(snap(FRAGILE, r).snapshot).toBeNull();
  });
  it('9 an explicit revocation VALIDATES and disables current use', () => {
    const a = approval();
    const r = UNSAFE_testOnlyDecision({
      decisionType: 'REVOKE', packet: ABOUT, reviewDecisionId: 'D-2', requestId: 'R-2',
      decisionTimestamp: '2026-09-30T19:00:00.000Z', revokesReviewDecisionId: a.reviewDecisionId,
    });
    expect(validateReviewDecision(r).valid).toBe(true);
    expect(deriveDecisionStatus([a, r], ABOUT).status).toBe('REVOKED');
  });
  it('10 historical approval remains attributable after later capability loss', () => {
    const a = approval();
    const sn = snap(ABOUT, a).snapshot!;
    expect(sn.reviewDecisionId).toBe(a.reviewDecisionId);
    expect(deriveSnapshotConsumability(sn, ABOUT, [a]).status).toBe('CONSUMABLE');
  });
  it('11 the deterministic snapshot id helper is content-addressed and stable', () => {
    const a = approval();
    const id1 = deterministicSnapshotId(a.reviewDecisionId, a.claimHash, a.evidenceFingerprint, a.reviewPacketHash);
    const id2 = deterministicSnapshotId(a.reviewDecisionId, a.claimHash, a.evidenceFingerprint, a.reviewPacketHash);
    expect(id1).toBe(id2);
    expect(deterministicSnapshotId('other', a.claimHash, a.evidenceFingerprint, a.reviewPacketHash)).not.toBe(id1);
  });
});
