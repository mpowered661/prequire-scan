// Human Review & Approval v0.1 — the 92 frozen adversarial cases, focused unit
// tests, and positive controls. Each test names the attack it defends.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { qualify } from '../opportunity-qualification/qualify';
import type { QualificationInput } from '../opportunity-qualification/types';
import { deriveReview, type QualificationResultView } from '../opportunity-review/review-packet';
import type { ReviewPacket } from '../opportunity-review/types';
import { deriveApprovalEligibility } from './approval-eligibility';
import {
  deriveDecisionStatus,
  isSuperseded,
  normalizedDecisionTimestamp,
  orderDecisions,
  validateReviewDecision,
} from './approval-status';
import { compareBinding } from './binding';
import { recordsRequiredCapability, reviewerIdentityValue } from './future-identity';
import {
  CANONICAL_PAYLOAD_FIELDS,
  EXCLUDED_FROM_CANONICAL_PAYLOAD,
  canonicalDecisionPayloadHash,
  compareIdempotency,
} from './idempotency';
import {
  InvalidPacketIdentityError,
  PACKET_HASH_INPUTS,
  canonicalPacketJson,
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
import { HRA_VERSION, MAX_REVIEWER_NOTE_CHARS, UNREPRESENTABLE_STATES } from './versions';

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

// ═══════════════════════════════════════════════════════════════
// hra-0.1.1 CONFORMANCE REPAIR — adversarial cases 93-112.
// Each names the defect it proves corrected.
// ═══════════════════════════════════════════════════════════════

/** Same opportunity, different evidence lineage. */
function relineage(packet: ReviewPacketView, fingerprint: string): ReviewPacketView {
  return { ...packet, evidenceFingerprint: fingerprint };
}
function revoke(target: string | undefined, over: Partial<ReviewDecisionRecord> = {},
  packet: ReviewPacketView = ABOUT): ReviewDecisionRecord {
  return UNSAFE_testOnlyDecision({
    decisionType: 'REVOKE', packet, revokesReviewDecisionId: target, override: over,
  });
}
function reject(packet: ReviewPacketView, over: Partial<ReviewDecisionRecord> = {}): ReviewDecisionRecord {
  return UNSAFE_testOnlyDecision({
    decisionType: 'REJECT', packet,
    structuredRejectionReason: 'evidence_not_convincing', override: over,
  });
}
const T = (hhmm: string) => `2026-09-30T${hhmm}:00.000Z`;

describe('repair 1 — REVOKE ordering and targeting', () => {
  it('93 APPROVE A, REVOKE A, then a later APPROVE B on new evidence becomes current', () => {
    const fresh = relineage(ABOUT, 'fp-second-generation');
    const a = approval(ABOUT, { reviewDecisionId: 'D-A', requestId: 'R-A', decisionTimestamp: T('08:00') });
    const r = revoke('D-A', { reviewDecisionId: 'D-R', requestId: 'R-R', decisionTimestamp: T('09:00') });
    const b = approval(fresh, { reviewDecisionId: 'D-B', requestId: 'R-B', decisionTimestamp: T('23:00') });
    const status = deriveDecisionStatus([a, r, b], fresh);
    expect(status.status).toBe('APPROVED_CURRENT');
    expect(status.decisionId).toBe('D-B');
    expect(snap(fresh, b, [a, r, b]).snapshot).not.toBeNull();
  });

  it('94 a prior REVOKE does not revoke a later approval merely by existing in history', () => {
    const a = approval(ABOUT, { reviewDecisionId: 'D-A', requestId: 'R-A', decisionTimestamp: T('08:00') });
    const r = revoke('D-A', { reviewDecisionId: 'D-R', requestId: 'R-R', decisionTimestamp: T('09:00') });
    const later = approval(ABOUT, { reviewDecisionId: 'D-L', requestId: 'R-L', decisionTimestamp: T('23:00') });
    expect(orderDecisions([a, r, later]).map(d => d.reviewDecisionId)).toEqual(['D-A', 'D-R', 'D-L']);
    const status = deriveDecisionStatus([a, r, later], ABOUT);
    expect(status.status).toBe('APPROVED_CURRENT');
    expect(status.decisionId).toBe('D-L');
  });

  it('95 a REVOKE naming one decision does not suppress an unrelated later approval', () => {
    const other = relineage(ABOUT, 'fp-other');
    const a = approval(ABOUT, { reviewDecisionId: 'D-A', requestId: 'R-A', decisionTimestamp: T('08:00') });
    const r = revoke('D-A', { reviewDecisionId: 'D-R', requestId: 'R-R', decisionTimestamp: T('09:00') });
    const unrelated = approval(other, { reviewDecisionId: 'D-U', requestId: 'R-U', decisionTimestamp: T('10:00') });
    const status = deriveDecisionStatus([a, r, unrelated], other);
    expect(status.status).toBe('APPROVED_CURRENT');
    expect(status.decisionId).toBe('D-U');
  });
});

describe('repair 1 — targeting precision and fail-closed ambiguity', () => {
  // hra-0.1.2: revoking DE-AUTHORIZES THE EXACT BINDING. Under hra-0.1.1 this
  // test asserted a fallback to the other same-binding approval, which is the
  // behaviour the frozen semantic now forbids.
  it('96 revoking either same-binding approval de-authorizes the whole binding', () => {
    const a1 = approval(ABOUT, { reviewDecisionId: 'D-1', requestId: 'R-1', decisionTimestamp: T('08:00') });
    const a2 = approval(ABOUT, { reviewDecisionId: 'D-2', requestId: 'R-2', decisionTimestamp: T('09:00') });
    expect(a1.reviewPacketHash).toBe(a2.reviewPacketHash);

    const r1 = revoke('D-1', { reviewDecisionId: 'D-R', requestId: 'R-R', decisionTimestamp: T('10:00') });
    const naming1 = deriveDecisionStatus([a1, a2, r1], ABOUT);
    expect(naming1.status).toBe('REVOKED');
    expect(naming1.decisionId).toBe('D-R');

    const r2 = revoke('D-2', { reviewDecisionId: 'D-R2', requestId: 'R-R2', decisionTimestamp: T('11:00') });
    const naming2 = deriveDecisionStatus([a1, a2, r2], ABOUT);
    expect(naming2.status).toBe('REVOKED');
    expect(naming2.decisionId).toBe('D-R2');

    // neither surviving approval can carry a snapshot for the revoked binding
    expect(snap(ABOUT, a1, [a1, a2, r1]).snapshot).toBeNull();
    expect(snap(ABOUT, a2, [a1, a2, r1]).snapshot).toBeNull();
    expect(snap(ABOUT, a1, [a1, a2, r2]).snapshot).toBeNull();
    expect(snap(ABOUT, a2, [a1, a2, r2]).snapshot).toBeNull();
  });

  it('97 when every decision is revoked the status is REVOKED and no snapshot derives', () => {
    const a = approval(ABOUT, { reviewDecisionId: 'D-A', requestId: 'R-A', decisionTimestamp: T('08:00') });
    const r = revoke('D-A', { reviewDecisionId: 'D-R', requestId: 'R-R', decisionTimestamp: T('09:00') });
    const status = deriveDecisionStatus([a, r], ABOUT);
    expect(status.status).toBe('REVOKED');
    expect(status.decisionId).toBe('D-R');
    expect(snap(ABOUT, a, [a, r]).snapshot).toBeNull();
  });

  it('98 malformed or ambiguous revocation targeting FAILS CLOSED', () => {
    const a = approval(ABOUT, { reviewDecisionId: 'D-A', requestId: 'R-A', decisionTimestamp: T('08:00') });
    const cases: [string, ReviewDecisionRecord[]][] = [
      ['no target', [a, revoke(undefined, { reviewDecisionId: 'D-R', requestId: 'R-R', decisionTimestamp: T('09:00') })]],
      ['target absent', [a, revoke('D-NOT-HERE', { reviewDecisionId: 'D-R', requestId: 'R-R', decisionTimestamp: T('09:00') })]],
      ['target is later', [a, revoke('D-LATER', { reviewDecisionId: 'D-R', requestId: 'R-R', decisionTimestamp: T('09:00') }),
        approval(ABOUT, { reviewDecisionId: 'D-LATER', requestId: 'R-X', decisionTimestamp: T('10:00') })]],
      ['self target', [a, revoke('D-R', { reviewDecisionId: 'D-R', requestId: 'R-R', decisionTimestamp: T('09:00') })]],
      ['target is a REVOKE', [a,
        revoke('D-A', { reviewDecisionId: 'D-R1', requestId: 'R-R1', decisionTimestamp: T('09:00') }),
        revoke('D-R1', { reviewDecisionId: 'D-R2', requestId: 'R-R2', decisionTimestamp: T('10:00') })]],
    ];
    for (const [label, decisions] of cases) {
      const status = deriveDecisionStatus(decisions, ABOUT);
      expect(status.status, label).toBe('REVOKED');
      expect(status.reason, label).toContain('failing closed');
    }
  });

  it('99 status derivation never mutates the supplied append-only history', () => {
    const a = approval(ABOUT, { reviewDecisionId: 'D-A', requestId: 'R-A', decisionTimestamp: T('08:00') });
    const r = revoke('D-A', { reviewDecisionId: 'D-R', requestId: 'R-R', decisionTimestamp: T('09:00') });
    const history = [a, r];
    const before = JSON.stringify(history);
    deriveDecisionStatus(history, ABOUT);
    deriveDecisionStatus(history, relineage(ABOUT, 'fp-x'));
    orderDecisions(history);
    expect(JSON.stringify(history)).toBe(before);
    expect(history.map(d => d.reviewDecisionId)).toEqual(['D-A', 'D-R']);
  });
});

describe('repair 2 — SUPERSEDED is derivable through deriveDecisionStatus', () => {
  // A later decision for the same opportunity bound to DIFFERENT evidence means
  // the decision matching this packet is no longer the operative one.
  const a1 = approval(ABOUT, { reviewDecisionId: 'D-A1', requestId: 'R-A1', decisionTimestamp: T('08:00') });
  const nextGen = relineage(ABOUT, 'fp-next-generation');
  const laterOnNewEvidence = reject(nextGen, { reviewDecisionId: 'D-R2', requestId: 'R-R2', decisionTimestamp: T('09:00') });

  it('100 SUPERSEDED is returned by deriveDecisionStatus, not only by isSuperseded', () => {
    const status = deriveDecisionStatus([a1, laterOnNewEvidence], ABOUT);
    expect(status.status).toBe('SUPERSEDED');
    expect(status.decisionId).toBe('D-A1');
    expect(status.reason).toContain('D-R2');
    expect(status.consideredDecisionIds).toEqual(['D-A1', 'D-R2']);
  });

  it('101 SUPERSEDED does not authorize: no snapshot, not consumable', () => {
    const all = [a1, laterOnNewEvidence];
    const out = snap(ABOUT, a1, all);
    expect(out.snapshot).toBeNull();
    expect(out.failures.map(f => f.code)).toContain('decision_not_current');
    const live = snap(ABOUT, a1, [a1]).snapshot!;
    expect(deriveSnapshotConsumability(live, ABOUT, all).status).toBe('NOT_CONSUMABLE');
  });

  it('102 SUPERSEDED is not reported when the current decision binds exactly', () => {
    const a2 = approval(ABOUT, { reviewDecisionId: 'D-A2', requestId: 'R-A2', decisionTimestamp: T('10:00') });
    expect(deriveDecisionStatus([a1, a2], ABOUT).status).toBe('APPROVED_CURRENT');
    expect(isSuperseded(a1, [a1, a2])).toBe(true);
    expect(isSuperseded(a2, [a1, a2])).toBe(false);
  });

  it('103 every DecisionStatus value in the frozen vocabulary is reachable', () => {
    const reached = new Set<string>();
    reached.add(deriveDecisionStatus([], ABOUT).status);
    reached.add(deriveDecisionStatus([approval(ABOUT)], ABOUT).status);
    reached.add(deriveDecisionStatus([reject(ABOUT)], ABOUT).status);
    const a = approval(ABOUT, { reviewDecisionId: 'D-X', requestId: 'R-X', decisionTimestamp: T('08:00') });
    reached.add(deriveDecisionStatus([a, revoke('D-X', { reviewDecisionId: 'D-Y', requestId: 'R-Y', decisionTimestamp: T('09:00') })], ABOUT).status);
    reached.add(deriveDecisionStatus([a1, laterOnNewEvidence], ABOUT).status);
    reached.add(deriveDecisionStatus([approval(ABOUT)], relineage(ABOUT, 'fp-moved')).status);
    reached.add(deriveDecisionStatus([approval(ABOUT)], { ...ABOUT, qualificationStatus: 'NOT_QUALIFIED' }).status);
    expect([...reached].sort()).toEqual([
      'APPROVED_CURRENT', 'INVALID', 'REJECTED_CURRENT', 'REVOKED', 'STALE', 'SUPERSEDED', 'UNREVIEWED',
    ]);
  });
});

describe('repair 3 — packet hash canonicalization, exact Codex collision classes', () => {
  // Raw delimiter bytes, built numerically so no escape appears in source.
  const D1 = String.fromCharCode(1);
  const D2 = String.fromCharCode(2);
  const D3 = String.fromCharCode(3);
  const BACKSLASH = String.fromCharCode(92);

  it('104 Codex collision 1: evidence-ref delimiter smuggling no longer collides', () => {
    const smuggled = ['u', 'e', 'v', 'c', 'sc', 'o'].join(D1) + D2 + ['k', 's', 'u2'].join(D1);
    const base: EvidenceRefView = { kind: 'k', scanId: 's', subjectUrl: 'u', engine: 'e',
      engineVersion: 'v', contentSha256: 'c', scope: 'sc', observedAt: 'o' };
    const crafted = [{ ...base, subjectUrl: smuggled }];
    const genuine = [{ ...base, subjectUrl: 'u' }, { ...base, subjectUrl: 'u2' }];
    expect(supportingEvidenceRefsDigest(crafted)).not.toBe(supportingEvidenceRefsDigest(genuine));
    expect(normalizeRefs(crafted)).toHaveLength(1);
    expect(normalizeRefs(genuine)).toHaveLength(2);
    expect(reviewPacketHash({ ...ABOUT, evidenceRefs: crafted }))
      .not.toBe(reviewPacketHash({ ...ABOUT, evidenceRefs: genuine }));
  });

  it('105 Codex collision 2: gate-trace delimiter and "=" no longer collide', () => {
    const crafted = [{ gate: 'A=1' + D3 + 'B', passed: false }];
    const genuine = [{ gate: 'A', passed: true }, { gate: 'B', passed: false }];
    expect(gateTraceDigest(crafted)).not.toBe(gateTraceDigest(genuine));
    expect(reviewPacketHash({ ...ABOUT, gateTrace: crafted }))
      .not.toBe(reviewPacketHash({ ...ABOUT, gateTrace: genuine }));
    // "=" alone, previously distinguished, still is
    expect(gateTraceDigest([{ gate: 'G1=0', passed: true }]))
      .not.toBe(gateTraceDigest([{ gate: 'G1', passed: false }]));
  });

  it('106 no delimiter byte in any ref field can imitate a field boundary', () => {
    const base: EvidenceRefView = { kind: 'k', scanId: 's', subjectUrl: 'u', engine: 'e',
      engineVersion: 'v', contentSha256: 'c', scope: 'sc', observedAt: 'o' };
    const fields: (keyof EvidenceRefView)[] = ['kind', 'scanId', 'subjectUrl', 'engine', 'engineVersion', 'contentSha256', 'scope', 'observedAt'];
    const seen = new Set<string>();
    for (const f of fields) {
      for (const d of [D1, D2, D3, '"', BACKSLASH, ',', ']', '=']) {
        seen.add(supportingEvidenceRefsDigest([{ ...base, [f]: 'x' + d + 'y' }]));
      }
    }
    // every injected variant is distinct from every other and from the baseline
    expect(seen.size).toBe(fields.length * 8);
    expect(seen.has(supportingEvidenceRefsDigest([base]))).toBe(false);
  });

  it('107 the frozen identity contract is unchanged by the new encoding', () => {
    const keys = Object.keys(JSON.parse(canonicalPacketJson(ABOUT)));
    expect(keys).toHaveLength(13);
    expect(PACKET_HASH_INPUTS.filter(k => !keys.includes(k))).toHaveLength(0);
    // display prose still excluded
    expect(reviewPacketHash({ ...ABOUT, displayProse: 'entirely different prose' }))
      .toBe(reviewPacketHash(ABOUT));
    // same semantic packet hashes identically, and ordering stays irrelevant
    expect(reviewPacketHash({ ...ABOUT })).toBe(reviewPacketHash(ABOUT));
    expect(reviewPacketHash({ ...ABOUT, gateTrace: [...ABOUT.gateTrace].reverse() }))
      .toBe(reviewPacketHash(ABOUT));
    expect(reviewPacketHash({ ...ABOUT, evidenceRefs: [...ABOUT.evidenceRefs].reverse() }))
      .toBe(reviewPacketHash(ABOUT));
    // materially different packet still moves the hash
    expect(reviewPacketHash({ ...ABOUT, claimHash: 'different' })).not.toBe(reviewPacketHash(ABOUT));
  });

  it('108 the hash encoding stays bound to its version and old decisions fail closed', () => {
    expect(HRA_VERSION).toBe('hra-0.1.2');
    const old = approval(ABOUT, { hraVersion: 'hra-0.1.1' });
    const v = validateReviewDecision(old);
    expect(v.valid).toBe(false);
    expect(v.failures.map(f => f.code)).toContain('hra_version_mismatch');
    expect(snap(ABOUT, old).snapshot).toBeNull();
  });
});

describe('hardening — chronological decision ordering', () => {
  it('109 18:00:00Z orders before 18:00:00.500Z', () => {
    expect(normalizedDecisionTimestamp('2026-09-30T18:00:00Z')).toBe('2026-09-30T18:00:00.000Z');
    expect(normalizedDecisionTimestamp('2026-09-30T18:00:00.500Z')).toBe('2026-09-30T18:00:00.500Z');
    const noFrac = approval(ABOUT, { reviewDecisionId: 'D-noFrac', requestId: 'R-1', decisionTimestamp: '2026-09-30T18:00:00Z' });
    const withFrac = approval(ABOUT, { reviewDecisionId: 'D-withFrac', requestId: 'R-2', decisionTimestamp: '2026-09-30T18:00:00.500Z' });
    expect(validateReviewDecision(noFrac).valid).toBe(true);
    expect(validateReviewDecision(withFrac).valid).toBe(true);
    expect(orderDecisions([noFrac, withFrac]).map(d => d.reviewDecisionId)).toEqual(['D-noFrac', 'D-withFrac']);
    expect(orderDecisions([withFrac, noFrac]).map(d => d.reviewDecisionId)).toEqual(['D-noFrac', 'D-withFrac']);
    expect(deriveDecisionStatus([noFrac, withFrac], ABOUT).decisionId).toBe('D-withFrac');
  });

  it('110 equivalent instants with differing fractional precision tie-break deterministically', () => {
    expect(normalizedDecisionTimestamp('2026-09-30T18:00:00.1Z'))
      .toBe(normalizedDecisionTimestamp('2026-09-30T18:00:00.10Z'));
    expect(normalizedDecisionTimestamp('2026-09-30T18:00:00.1Z')).toBe('2026-09-30T18:00:00.100Z');
    const a = approval(ABOUT, { reviewDecisionId: 'D-1', requestId: 'R-1', decisionTimestamp: '2026-09-30T18:00:00.1Z' });
    const b = approval(ABOUT, { reviewDecisionId: 'D-2', requestId: 'R-2', decisionTimestamp: '2026-09-30T18:00:00.100Z' });
    // same instant, so the reviewDecisionId tie-break decides, in both input orders
    expect(orderDecisions([a, b]).map(d => d.reviewDecisionId)).toEqual(['D-1', 'D-2']);
    expect(orderDecisions([b, a]).map(d => d.reviewDecisionId)).toEqual(['D-1', 'D-2']);
    // and .05Z precedes .1Z, which lexical comparison of raw strings also got right
    expect(normalizedDecisionTimestamp('2026-09-30T18:00:00.05Z') < normalizedDecisionTimestamp('2026-09-30T18:00:00.1Z')).toBe(true);
  });

  it('111 ordering introduces no clock, randomness or ambient time', () => {
    const src = productionCode();
    for (const bad of ['Date.now(', 'new Date(', 'Math.random', 'randomUUID', 'performance.now']) {
      expect(src, bad).not.toContain(bad);
    }
    const a = approval(ABOUT, { reviewDecisionId: 'D-1', requestId: 'R-1', decisionTimestamp: T('08:00') });
    const b = approval(ABOUT, { reviewDecisionId: 'D-2', requestId: 'R-2', decisionTimestamp: T('09:00') });
    const first = orderDecisions([b, a]).map(d => d.reviewDecisionId);
    expect(orderDecisions([b, a]).map(d => d.reviewDecisionId)).toEqual(first);
  });
});

describe('hardening — malformed packet identity fails closed before hashing', () => {
  const REQUIRED = ['opportunityKey', 'evidenceFingerprint', 'claimHash', 'qualificationStatus',
    'presentationPermission', 'presentationMode', 'demonstrabilityStatus', 'temporalFrame',
    'reviewContractVersion', 'qualificationVersion'] as const;

  it('112 an absent, undefined, null, empty or wrongly typed identity field throws', () => {
    for (const field of REQUIRED) {
      const absent = { ...ABOUT } as Record<string, unknown>;
      delete absent[field];
      expect(() => reviewPacketHash(absent as unknown as ReviewPacketView), `absent ${field}`)
        .toThrow(InvalidPacketIdentityError);
      for (const bad of [undefined, null, '', 42, {}]) {
        expect(() => reviewPacketHash({ ...ABOUT, [field]: bad } as unknown as ReviewPacketView), `${field}=${String(bad)}`)
          .toThrow(InvalidPacketIdentityError);
      }
    }
  });

  it('113 a non-boolean meetsScoutEvidenceRequirements throws rather than coercing', () => {
    for (const bad of [undefined, null, 'true', 1, 0]) {
      expect(() => reviewPacketHash({ ...ABOUT, meetsScoutEvidenceRequirements: bad } as unknown as ReviewPacketView))
        .toThrow(InvalidPacketIdentityError);
    }
    // the previously colliding pair — absent versus explicit undefined — now both throw
    const absent = { ...ABOUT } as Record<string, unknown>;
    delete absent.presentationMode;
    expect(() => canonicalPacketJson(absent as unknown as ReviewPacketView)).toThrow(/presentationMode/);
    expect(() => canonicalPacketJson({ ...ABOUT, presentationMode: undefined } as unknown as ReviewPacketView))
      .toThrow(/presentationMode/);
  });

  it('114 malformed gateTrace and evidenceRefs entries are rejected', () => {
    const bad: [string, unknown][] = [
      ['gateTrace not an array', { ...ABOUT, gateTrace: 'G1' }],
      ['gate not a string', { ...ABOUT, gateTrace: [{ gate: 1, passed: true }] }],
      ['gate empty', { ...ABOUT, gateTrace: [{ gate: '', passed: true }] }],
      ['passed not boolean', { ...ABOUT, gateTrace: [{ gate: 'G1', passed: 'yes' }] }],
      ['gate entry null', { ...ABOUT, gateTrace: [null] }],
      ['evidenceRefs not an array', { ...ABOUT, evidenceRefs: {} }],
      ['ref entry null', { ...ABOUT, evidenceRefs: [null] }],
      ['ref subjectUrl missing', { ...ABOUT, evidenceRefs: [{ ...REF, subjectUrl: undefined }] }],
      ['ref scope empty', { ...ABOUT, evidenceRefs: [{ ...REF, scope: '' }] }],
      ['ref engine wrongly typed', { ...ABOUT, evidenceRefs: [{ ...REF, engine: 7 }] }],
    ];
    for (const [label, packet] of bad) {
      expect(() => reviewPacketHash(packet as ReviewPacketView), label).toThrow(InvalidPacketIdentityError);
    }
    // a well-formed packet with explicit nulls on nullable ref fields is accepted
    expect(() => reviewPacketHash({ ...ABOUT, evidenceRefs: [{ ...REF, engine: null, observedAt: null }] })).not.toThrow();
  });
});

describe('hardening — snapshot immutability of approved truth', () => {
  /** A detached packet, so mutating it cannot disturb the shared fixtures. */
  function detached(): ReviewPacketView {
    return JSON.parse(JSON.stringify(ABOUT)) as ReviewPacketView;
  }

  it('115 nested approved truth cannot be mutated through the snapshot', () => {
    const packet = detached();
    const s = snap(packet, approval(packet)).snapshot!;
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(s.canonicalClaim)).toBe(true);
    expect(Object.isFrozen(s.demonstration)).toBe(true);
    const claim = s.canonicalClaim as Record<string, unknown>;
    const serialized = JSON.stringify(claim);
    expect(() => { claim.injected = 'MUTATED'; }).toThrow(TypeError);
    expect(claim.injected).toBeUndefined();
    expect(JSON.stringify(s.canonicalClaim)).toBe(serialized);
  });

  it('116 mutating the original packet after derivation cannot change the snapshot', () => {
    const packet = detached();
    const s = snap(packet, approval(packet)).snapshot!;
    const before = JSON.stringify(s.canonicalClaim);
    const beforeDemo = JSON.stringify(s.demonstration);
    // the snapshot must not alias the packet
    expect(s.canonicalClaim).not.toBe(packet.canonicalClaim);
    expect(s.demonstration).not.toBe(packet.demonstration);
    (packet.canonicalClaim as Record<string, unknown>).subject = 'TAMPERED';
    (packet.canonicalClaim as Record<string, unknown>).temporalFrame = 'AFTER';
    (packet.demonstration as Record<string, unknown>).status = 'TAMPERED';
    expect(JSON.stringify(s.canonicalClaim)).toBe(before);
    expect(JSON.stringify(s.demonstration)).toBe(beforeDemo);
    expect(JSON.stringify(s.canonicalClaim)).not.toContain('TAMPERED');
  });

  it('117 snapshot derivation stays deterministic', () => {
    const p1 = detached();
    const p2 = detached();
    const a = approval(p1);
    const s1 = snap(p1, a).snapshot!;
    const s2 = snap(p2, approval(p2)).snapshot!;
    expect(JSON.stringify(s1)).toBe(JSON.stringify(s2));
    expect(s1.reviewPacketHash).toBe(s2.reviewPacketHash);
    expect(s1.supportingEvidenceRefsDigest).toBe(s2.supportingEvidenceRefsDigest);
  });

  it('118 a non plain-JSON nested value fails closed rather than being flattened', () => {
    const packet = detached();
    (packet as unknown as Record<string, unknown>).canonicalClaim = new Map([['a', 1]]);
    expect(() => snap(packet, approval(packet))).toThrow(/not a plain JSON-shaped object/);
  });
});

// ═══════════════════════════════════════════════════════════════
// hra-0.1.2 REVOCATION SEMANTIC — adversarial cases 119-130.
// Frozen: revoking the current approval de-authorizes that EXACT
// presentation binding. An older approval of the same binding must never
// silently become current again; a new binding stays independently approvable.
// ═══════════════════════════════════════════════════════════════

describe('hra-0.1.2 revocation — no same-binding fallback', () => {
  it('119 case 1: APPROVE A1, APPROVE A2, REVOKE A2 de-authorizes the binding', () => {
    const a1 = approval(ABOUT, { reviewDecisionId: 'D-A1', requestId: 'R-1', decisionTimestamp: T('08:00') });
    const a2 = approval(ABOUT, { reviewDecisionId: 'D-A2', requestId: 'R-2', decisionTimestamp: T('09:00') });
    const r = revoke('D-A2', { reviewDecisionId: 'D-R', requestId: 'R-R', decisionTimestamp: T('10:00') });
    expect(a1.reviewPacketHash).toBe(a2.reviewPacketHash);
    const status = deriveDecisionStatus([a1, a2, r], ABOUT);
    expect(status.status).toBe('REVOKED');
    expect(status.status).not.toBe('APPROVED_CURRENT');
    expect(status.decisionId).toBe('D-R');
    expect(status.consideredDecisionIds).toEqual(['D-A1', 'D-A2', 'D-R']);
  });

  it('120 case 1: neither A1 nor A2 can derive a snapshot for the revoked binding', () => {
    const a1 = approval(ABOUT, { reviewDecisionId: 'D-A1', requestId: 'R-1', decisionTimestamp: T('08:00') });
    const a2 = approval(ABOUT, { reviewDecisionId: 'D-A2', requestId: 'R-2', decisionTimestamp: T('09:00') });
    const r = revoke('D-A2', { reviewDecisionId: 'D-R', requestId: 'R-R', decisionTimestamp: T('10:00') });
    const all = [a1, a2, r];
    for (const d of [a1, a2]) {
      const out = snap(ABOUT, d, all);
      expect(out.snapshot, d.reviewDecisionId).toBeNull();
      expect(out.failures.map(f => f.code), d.reviewDecisionId).toContain('decision_not_current');
    }
  });

  it('121 case 2: three same-binding approvals, revoke the latest, no fallback at all', () => {
    const a1 = approval(ABOUT, { reviewDecisionId: 'D-A1', requestId: 'R-1', decisionTimestamp: T('08:00') });
    const a2 = approval(ABOUT, { reviewDecisionId: 'D-A2', requestId: 'R-2', decisionTimestamp: T('09:00') });
    const a3 = approval(ABOUT, { reviewDecisionId: 'D-A3', requestId: 'R-3', decisionTimestamp: T('10:00') });
    const r = revoke('D-A3', { reviewDecisionId: 'D-R', requestId: 'R-R', decisionTimestamp: T('11:00') });
    const status = deriveDecisionStatus([a1, a2, a3, r], ABOUT);
    expect(status.status).toBe('REVOKED');
    expect(status.decisionId).toBe('D-R');
    for (const d of [a1, a2, a3]) expect(snap(ABOUT, d, [a1, a2, a3, r]).snapshot, d.reviewDecisionId).toBeNull();
  });

  it('122 case 4: revoking a later REJECT cannot resurrect the earlier approval', () => {
    const a = approval(ABOUT, { reviewDecisionId: 'D-A', requestId: 'R-1', decisionTimestamp: T('08:00') });
    const rj = reject(ABOUT, { reviewDecisionId: 'D-RJ', requestId: 'R-2', decisionTimestamp: T('09:00') });
    expect(a.reviewPacketHash).toBe(rj.reviewPacketHash);
    const r = revoke('D-RJ', { reviewDecisionId: 'D-R', requestId: 'R-R', decisionTimestamp: T('10:00') });
    const status = deriveDecisionStatus([a, rj, r], ABOUT);
    expect(status.status).toBe('REVOKED');
    expect(status.status).not.toBe('APPROVED_CURRENT');
    expect(snap(ABOUT, a, [a, rj, r]).snapshot).toBeNull();
  });
});

describe('hra-0.1.2 revocation — binding-scoped, future evidence unpoisoned', () => {
  it('123 case 3: OLD stays revoked while NEW evidence becomes approvable', () => {
    const fresh = relineage(ABOUT, 'fp-generation-2');
    const oldApp = approval(ABOUT, { reviewDecisionId: 'D-OLD', requestId: 'R-1', decisionTimestamp: T('08:00') });
    const rev1 = revoke('D-OLD', { reviewDecisionId: 'D-R', requestId: 'R-R', decisionTimestamp: T('09:00') });
    const newApp = approval(fresh, { reviewDecisionId: 'D-NEW', requestId: 'R-2', decisionTimestamp: T('10:00') });
    expect(oldApp.reviewPacketHash).not.toBe(newApp.reviewPacketHash);
    const all = [oldApp, rev1, newApp];
    // the OLD binding remains de-authorized, and says so
    const oldStatus = deriveDecisionStatus(all, ABOUT);
    expect(oldStatus.status).toBe('REVOKED');
    expect(snap(ABOUT, oldApp, all).snapshot).toBeNull();
    // the NEW binding is evaluated independently and may be current
    const newStatus = deriveDecisionStatus(all, fresh);
    expect(newStatus.status).toBe('APPROVED_CURRENT');
    expect(newStatus.decisionId).toBe('D-NEW');
    expect(snap(fresh, newApp, all).snapshot).not.toBeNull();
  });

  it('124 case 5: a revoked binding stays revoked while an unrelated binding is independent', () => {
    const other = relineage(ABOUT, 'fp-other');
    const a = approval(ABOUT, { reviewDecisionId: 'D-A', requestId: 'R-1', decisionTimestamp: T('08:00') });
    const r = revoke('D-A', { reviewDecisionId: 'D-R', requestId: 'R-R', decisionTimestamp: T('09:00') });
    const otherApprove = approval(other, { reviewDecisionId: 'D-O', requestId: 'R-2', decisionTimestamp: T('10:00') });
    const otherReject = reject(other, { reviewDecisionId: 'D-OR', requestId: 'R-3', decisionTimestamp: T('11:00') });
    expect(deriveDecisionStatus([a, r, otherApprove], ABOUT).status).toBe('REVOKED');
    expect(deriveDecisionStatus([a, r, otherApprove], other).status).toBe('APPROVED_CURRENT');
    expect(deriveDecisionStatus([a, r, otherApprove, otherReject], other).status).toBe('REJECTED_CURRENT');
    expect(deriveDecisionStatus([a, r, otherApprove, otherReject], ABOUT).status).toBe('REVOKED');
  });

  it('125 case 6: revocation never crosses evidence generations', () => {
    const gen1 = ABOUT;
    const gen2 = relineage(ABOUT, 'fp-gen-2');
    const gen3 = relineage(ABOUT, 'fp-gen-3');
    const a1 = approval(gen1, { reviewDecisionId: 'D-G1', requestId: 'R-1', decisionTimestamp: T('08:00') });
    const a2 = approval(gen2, { reviewDecisionId: 'D-G2', requestId: 'R-2', decisionTimestamp: T('09:00') });
    const a3 = approval(gen3, { reviewDecisionId: 'D-G3', requestId: 'R-3', decisionTimestamp: T('10:00') });
    // revoke generation 1 only
    const r1 = revoke('D-G1', { reviewDecisionId: 'D-R1', requestId: 'R-R1', decisionTimestamp: T('11:00') });
    const all1 = [a1, a2, a3, r1];
    expect(deriveDecisionStatus(all1, gen1).status).toBe('REVOKED');
    expect(deriveDecisionStatus(all1, gen3).status).toBe('APPROVED_CURRENT');
    expect(snap(gen3, a3, all1).snapshot).not.toBeNull();
    // revoke generation 2 instead: generation 1 attribution is untouched
    const r2 = revoke('D-G2', { reviewDecisionId: 'D-R2', requestId: 'R-R2', decisionTimestamp: T('11:00') });
    const all2 = [a1, a2, a3, r2];
    expect(deriveDecisionStatus(all2, gen2).status).toBe('REVOKED');
    // generation 1 is NOT revoked by a generation 2 revocation. It is merely
    // SUPERSEDED, by the later generation 3 approval — the accepted hra-0.1.1
    // semantic — and its attribution still names D-G1.
    const gen1Status = deriveDecisionStatus(all2, gen1);
    expect(gen1Status.status).toBe('SUPERSEDED');
    expect(gen1Status.status).not.toBe('REVOKED');
    expect(gen1Status.decisionId).toBe('D-G1');
    expect(gen1Status.consideredDecisionIds).toContain('D-G1');
    // with no later generation standing, generation 1 is current again
    expect(deriveDecisionStatus([a1, a2, r2], gen1).status).toBe('APPROVED_CURRENT');
    expect(deriveDecisionStatus([a1, a2, r2], gen1).decisionId).toBe('D-G1');
  });

  it('126 a later explicit human approval of the same binding is a new deliberate act', () => {
    const a = approval(ABOUT, { reviewDecisionId: 'D-A', requestId: 'R-1', decisionTimestamp: T('08:00') });
    const r = revoke('D-A', { reviewDecisionId: 'D-R', requestId: 'R-R', decisionTimestamp: T('09:00') });
    const later = approval(ABOUT, { reviewDecisionId: 'D-L', requestId: 'R-2', decisionTimestamp: T('23:00') });
    // the revoke precedes the new approval, so it does not reach it
    const status = deriveDecisionStatus([a, r, later], ABOUT);
    expect(status.status).toBe('APPROVED_CURRENT');
    expect(status.decisionId).toBe('D-L');
    expect(snap(ABOUT, later, [a, r, later]).snapshot).not.toBeNull();
    // but the revoked earlier approval still cannot carry it
    expect(snap(ABOUT, a, [a, r, later]).snapshot).toBeNull();
  });
});

describe('hra-0.1.2 revocation — preserved invariants', () => {
  it('127 malformed revoke targeting is still fail-closed, unweakened', () => {
    const a = approval(ABOUT, { reviewDecisionId: 'D-A', requestId: 'R-1', decisionTimestamp: T('08:00') });
    const cases: [string, ReviewDecisionRecord[]][] = [
      ['no target', [a, revoke(undefined, { reviewDecisionId: 'D-R', requestId: 'R-R', decisionTimestamp: T('09:00') })]],
      ['target absent', [a, revoke('D-NOT-HERE', { reviewDecisionId: 'D-R', requestId: 'R-R', decisionTimestamp: T('09:00') })]],
      ['target is later', [a, revoke('D-LATER', { reviewDecisionId: 'D-R', requestId: 'R-R', decisionTimestamp: T('09:00') }),
        approval(ABOUT, { reviewDecisionId: 'D-LATER', requestId: 'R-X', decisionTimestamp: T('10:00') })]],
      ['self target', [a, revoke('D-R', { reviewDecisionId: 'D-R', requestId: 'R-R', decisionTimestamp: T('09:00') })]],
      ['target is a REVOKE', [a,
        revoke('D-A', { reviewDecisionId: 'D-R1', requestId: 'R-R1', decisionTimestamp: T('09:00') }),
        revoke('D-R1', { reviewDecisionId: 'D-R2', requestId: 'R-R2', decisionTimestamp: T('10:00') })]],
    ];
    for (const [label, decisions] of cases) {
      const status = deriveDecisionStatus(decisions, ABOUT);
      expect(status.status, label).toBe('REVOKED');
      expect(status.reason, label).toContain('failing closed');
      expect(snap(ABOUT, a, decisions).snapshot, label).toBeNull();
    }
  });

  it('128 SUPERSEDED semantics are preserved and still never authorize', () => {
    const a1 = approval(ABOUT, { reviewDecisionId: 'D-A1', requestId: 'R-1', decisionTimestamp: T('08:00') });
    const laterOther = reject(relineage(ABOUT, 'fp-gen-2'), {
      reviewDecisionId: 'D-R2', requestId: 'R-2', decisionTimestamp: T('09:00') });
    const status = deriveDecisionStatus([a1, laterOther], ABOUT);
    expect(status.status).toBe('SUPERSEDED');
    expect(status.decisionId).toBe('D-A1');
    const out = snap(ABOUT, a1, [a1, laterOther]);
    expect(out.snapshot).toBeNull();
    expect(out.failures.map(f => f.code)).toContain('decision_not_current');
    const live = snap(ABOUT, a1, [a1]).snapshot!;
    expect(deriveSnapshotConsumability(live, ABOUT, [a1, laterOther]).status).toBe('NOT_CONSUMABLE');
  });

  it('129 a snapshot taken before revocation is no longer consumable afterwards', () => {
    const a1 = approval(ABOUT, { reviewDecisionId: 'D-A1', requestId: 'R-1', decisionTimestamp: T('08:00') });
    const a2 = approval(ABOUT, { reviewDecisionId: 'D-A2', requestId: 'R-2', decisionTimestamp: T('09:00') });
    // a snapshot legitimately derived while A1 was current
    const live = snap(ABOUT, a1, [a1]).snapshot!;
    expect(live).not.toBeNull();
    const r = revoke('D-A2', { reviewDecisionId: 'D-R', requestId: 'R-R', decisionTimestamp: T('10:00') });
    const after = deriveSnapshotConsumability(live, ABOUT, [a1, a2, r]);
    expect(after.status).toBe('NOT_CONSUMABLE');
    expect(after.reason).toContain('revoked');
  });

  it('130 revocation derivation mutates nothing and stays deterministic', () => {
    const a1 = approval(ABOUT, { reviewDecisionId: 'D-A1', requestId: 'R-1', decisionTimestamp: T('08:00') });
    const a2 = approval(ABOUT, { reviewDecisionId: 'D-A2', requestId: 'R-2', decisionTimestamp: T('09:00') });
    const r = revoke('D-A2', { reviewDecisionId: 'D-R', requestId: 'R-R', decisionTimestamp: T('10:00') });
    const history = [a1, a2, r];
    const before = JSON.stringify(history);
    const first = deriveDecisionStatus(history, ABOUT);
    const again = deriveDecisionStatus([...history].reverse(), ABOUT);
    expect(JSON.stringify(history)).toBe(before);
    expect(history.map(d => d.reviewDecisionId)).toEqual(['D-A1', 'D-A2', 'D-R']);
    expect(again.status).toBe(first.status);
    expect(again.decisionId).toBe(first.decisionId);
    // no mutable approval state exists to flip
    expect(productionCode()).not.toContain('approved =');
    expect(productionCode()).not.toContain('isApproved');
  });
});
