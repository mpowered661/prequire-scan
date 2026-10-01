// Human Review & Approval v0.1 — Michael approval calibration.
//
// Accepted fixture only. Michael was NOT run live and nothing was fetched.
// NO REAL HUMAN APPROVAL OCCURRED: every reviewer identity, decision id,
// snapshot id and timestamp below is a TEST-ONLY PLACEHOLDER.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { qualify } from '../opportunity-qualification/qualify';
import type { QualificationInput } from '../opportunity-qualification/types';
import { deriveReview, type QualificationResultView } from '../opportunity-review/review-packet';
import type { ReviewPacket } from '../opportunity-review/types';
import { deriveApprovalEligibility } from './approval-eligibility';
import { deriveDecisionStatus, validateReviewDecision } from './approval-status';
import { compareBinding } from './binding';
import { reviewPacketHash } from './packet-hash';
import { derivePresentationSnapshotFromDecision, deterministicSnapshotId, deriveSnapshotConsumability } from './snapshot';
import { PLACEHOLDER_OPERATOR, UNSAFE_testOnlyDecision } from './test-only-fixtures';
import type { ReviewPacketView } from './types';

const input = JSON.parse(
  readFileSync(new URL('../opportunity-qualification/__fixtures__/michael-pilot.json', import.meta.url), 'utf8'),
) as QualificationInput;

const qualification = qualify(input) as unknown as QualificationResultView;
const review = deriveReview(qualification);

/** Bridges an or-0.1 packet into this layer's structural view. */
export function toPacketView(p: ReviewPacket): ReviewPacketView {
  const direct = p.claimCandidates.find(c => c.epistemicClass === 'DIRECT_OBSERVATION' && c.externallyPresentable)
    ?? p.claimCandidates[0];
  return {
    opportunityKey: p.opportunityKey,
    evidenceFingerprint: p.evidenceFingerprint,
    claimHash: p.claimHash,
    qualificationStatus: p.qualificationStatus,
    gateTrace: p.gateTrace.map(g => ({ gate: g.gate, passed: g.passed })),
    presentationPermission: direct.presentationPermission,
    presentationMode: p.presentationMode,
    demonstrabilityStatus: p.demonstration.status,
    meetsScoutEvidenceRequirements: p.meetsScoutEvidenceRequirements,
    temporalFrame: p.canonicalClaim.temporalFrame,
    reviewContractVersion: p.reviewContractVersion,
    qualificationVersion: p.qualificationVersion,
    evidenceRefs: p.evidenceRefs,
    displayProse: direct.prose,
    canonicalClaim: p.canonicalClaim,
    demonstration: p.demonstration,
    observedAt: p.canonicalClaim.observedAt,
    scanId: p.scanId,
  };
}

const packets = review.packets.map(toPacketView);
export const BROKEN_SUBJECTS = [
  'https://michaelhingson.com/about/',
  'https://michaelhingson.com/accessibility-statement/',
  'https://michaelhingson.com/author/',
  'https://michaelhingson.com/privacy-policy/',
];

function byOpportunity(subject: string): { packet: ReviewPacketView; source: ReviewPacket } {
  const source = review.packets.find(p => p.subject === subject);
  if (!source) throw new Error(`no packet for ${subject}`);
  return { packet: toPacketView(source), source };
}

describe('Michael approval calibration — totals', () => {
  it('13 qualification opportunities, 7 review packets, 4 approvable, 3 not', () => {
    expect(qualification.qualificationVersion).toBe('oq-0.1.1');
    expect(qualification.opportunities).toHaveLength(13);
    expect(review.packets).toHaveLength(7);

    const eligible = packets.filter(p => deriveApprovalEligibility(p).outcome === 'ELIGIBLE_FOR_HUMAN_APPROVAL');
    const notEligible = packets.filter(p => deriveApprovalEligibility(p).outcome === 'NOT_ELIGIBLE_FOR_HUMAN_APPROVAL');
    expect(eligible).toHaveLength(4);
    expect(notEligible).toHaveLength(3);
  });

  it('no real or persisted approvals exist', () => {
    // There is no production path that creates a decision. The only decisions in
    // this suite come from an explicitly UNSAFE test-only builder.
    expect(review.completedApprovals).toBe(0);
    expect(review.reviewDecisionsInstantiated).toBe(0);
    expect(review.presentationSnapshotsInstantiated).toBe(0);
    expect(review.persistedRecords).toBe(0);
  });
});

describe('Michael approval calibration — the 4 broken destinations are approvable', () => {
  it('each is ELIGIBLE_FOR_HUMAN_APPROVAL, and eligibility never implies approval', () => {
    for (const subject of BROKEN_SUBJECTS) {
      const { packet } = byOpportunity(subject);
      const e = deriveApprovalEligibility(packet);
      expect(e.outcome, subject).toBe('ELIGIBLE_FOR_HUMAN_APPROVAL');
      expect(e.blockingReasons, subject).toHaveLength(0);
      expect(e.impliesApproval, subject).toBe(false);
    }
  });

  it('a correctly supplied APPROVE_PRESENTATION fixture validates and binds exactly', () => {
    for (const subject of BROKEN_SUBJECTS) {
      const { packet } = byOpportunity(subject);
      const decision = UNSAFE_testOnlyDecision({ decisionType: 'APPROVE_PRESENTATION', packet });
      const v = validateReviewDecision(decision);
      expect(v.valid, `${subject}: ${JSON.stringify(v.failures)}`).toBe(true);
      expect(compareBinding(decision, packet).outcome, subject).toBe('EXACT');
      expect(deriveDecisionStatus([decision], packet).status, subject).toBe('APPROVED_CURRENT');
    }
  });

  it('PresentationSnapshot derivation PASSES for each', () => {
    for (const subject of BROKEN_SUBJECTS) {
      const { packet } = byOpportunity(subject);
      const decision = UNSAFE_testOnlyDecision({ decisionType: 'APPROVE_PRESENTATION', packet });
      const id = deterministicSnapshotId(
        decision.reviewDecisionId, decision.claimHash, decision.evidenceFingerprint, decision.reviewPacketHash);
      const result = derivePresentationSnapshotFromDecision({
        packet, decision, allDecisions: [decision], presentationSnapshotId: id,
      });
      expect(result.failures, `${subject}: ${JSON.stringify(result.failures)}`).toHaveLength(0);
      expect(result.snapshot, subject).not.toBeNull();
      expect(result.snapshot!.presentationMode).toBe('STATEMENT_WITH_DEMONSTRATION');
      expect(result.snapshot!.demonstrability).toBe('DEMONSTRABLE');
      expect(result.snapshot!.temporalFrame).toBe('CURRENT_STATE');
      expect(result.snapshot!.hraVersion).toBe('hra-0.1.1');
      expect(result.snapshot!.sourceScanId).toBe('michael-pilot-001');
      expect(deriveSnapshotConsumability(result.snapshot!, packet, [decision]).status).toBe('CONSUMABLE');
    }
  });

  it('/about/ preserves both populations and the observed date, unconflated', () => {
    const { packet } = byOpportunity('https://michaelhingson.com/about/');
    const decision = UNSAFE_testOnlyDecision({ decisionType: 'APPROVE_PRESENTATION', packet });
    const snap = derivePresentationSnapshotFromDecision({
      packet, decision, allDecisions: [decision],
      presentationSnapshotId: 'PLACEHOLDER-SNAPSHOT-0001',
    }).snapshot!;
    const claim = snap.canonicalClaim as {
      populations: { label: string; numerator: number; denominator: number }[];
      metric: string; observedValue: string; observedAt: string;
    };
    const byLabel = Object.fromEntries(claim.populations.map(p => [p.label, p]));
    expect(byLabel.analyzed_pages).toEqual({ label: 'analyzed_pages', numerator: 25, denominator: 25 });
    expect(byLabel.checked_link_destinations).toEqual({ label: 'checked_link_destinations', numerator: 1, denominator: 40 });
    expect(claim.metric).toBe('http_status');
    expect(claim.observedValue).toBe('404');
    expect(claim.observedAt).toBe('2026-09-30');
    expect(snap.observedAt).toBe('2026-09-30');
  });

  it('packet hash changes if either population changes; claim hash semantics are unchanged from or-0.1', () => {
    const { packet, source } = byOpportunity('https://michaelhingson.com/about/');
    // claimHash is carried through from or-0.1, never recomputed here.
    expect(packet.claimHash).toBe(source.claimHash);
    const baseline = reviewPacketHash(packet);
    // A changed population changes claimHash upstream, which is a packet input.
    expect(reviewPacketHash({ ...packet, claimHash: 'different-claim-hash' })).not.toBe(baseline);
    expect(reviewPacketHash({ ...packet, evidenceFingerprint: 'different-fingerprint' })).not.toBe(baseline);
  });
});

describe('Michael approval calibration — the 3 STATEMENT_ONLY packets are not approvable', () => {
  const subjects = ['band:fragile', 'fact_attribution', 'qualifier_preservation'];

  it('each is NOT_ELIGIBLE_FOR_HUMAN_APPROVAL, naming the v0.1 rule', () => {
    for (const s of subjects) {
      const { packet } = byOpportunity(s);
      const e = deriveApprovalEligibility(packet);
      expect(e.outcome, s).toBe('NOT_ELIGIBLE_FOR_HUMAN_APPROVAL');
      expect(e.blockingReasons.join(' '), s).toContain('statement_only_not_approvable_in_v0_1');
    }
  });

  it('an APPROVE_PRESENTATION attempt is REJECTED BY THE VALIDATOR', () => {
    for (const s of subjects) {
      const { packet } = byOpportunity(s);
      const decision = UNSAFE_testOnlyDecision({ decisionType: 'APPROVE_PRESENTATION', packet });
      const v = validateReviewDecision(decision);
      expect(v.valid, s).toBe(false);
      const codes = v.failures.map(f => f.code);
      expect(codes, s).toContain('approve_requires_demonstration_mode');
      expect(codes, s).toContain('approve_requires_demonstrable');
    }
  });

  it('NO PresentationSnapshot can be derived', () => {
    for (const s of subjects) {
      const { packet } = byOpportunity(s);
      const decision = UNSAFE_testOnlyDecision({ decisionType: 'APPROVE_PRESENTATION', packet });
      const result = derivePresentationSnapshotFromDecision({
        packet, decision, allDecisions: [decision], presentationSnapshotId: 'PLACEHOLDER-SNAPSHOT-X',
      });
      expect(result.snapshot, s).toBeNull();
      expect(result.failures.length, s).toBeGreaterThan(0);
      expect(result.failures.map(f => f.code), s).toContain('packet_not_approvable');
    }
  });

  it('they remain reviewable and are not discarded or converted', () => {
    for (const s of subjects) {
      const { packet, source } = byOpportunity(s);
      expect(source.reviewEligibility.entry, s).toBe('ELIGIBLE_FOR_REVIEW');
      expect(packet.presentationMode, s).toBe('STATEMENT_ONLY');
      expect(packet.demonstrabilityStatus, s).toBe('NOT_DEMONSTRABLE');
      // nothing here converted them to a demonstration mode
      expect(packet.meetsScoutEvidenceRequirements, s).toBe(false);
    }
  });
});

describe('Michael approval calibration — hypothetical only', () => {
  it('every reviewer identity used is an explicit placeholder', () => {
    expect(PLACEHOLDER_OPERATOR as string).toContain('PLACEHOLDER-OPERATOR');
  });

  it('no snapshot carries raw HTML, large prose, tokens, credentials or PII', () => {
    const { packet } = byOpportunity('https://michaelhingson.com/about/');
    const decision = UNSAFE_testOnlyDecision({ decisionType: 'APPROVE_PRESENTATION', packet });
    const snap = derivePresentationSnapshotFromDecision({
      packet, decision, allDecisions: [decision], presentationSnapshotId: 'PLACEHOLDER-SNAPSHOT-0001',
    }).snapshot!;
    const json = JSON.stringify(snap);
    for (const bad of ['<html', '<body', '<div', '<script', 'Bearer ', 'service_role', 'SUPABASE', 'api_key', 'password']) {
      expect(json).not.toContain(bad);
    }
    // The snapshot stores a prose HASH, not the prose.
    expect(json).not.toContain(packet.displayProse);
    expect(snap.reviewedProseHash).toMatch(/^[0-9a-f]{32}$/);
    // It does not duplicate the whole ReviewPacket.
    expect(json).not.toContain('gateTrace');
    expect(json).not.toContain('claimCandidates');
    expect(json).not.toContain('uncertainties');
  });

  it('no outreach, publishing, BEFORE/AFTER or VERIFIED state appears', () => {
    const { packet } = byOpportunity('https://michaelhingson.com/about/');
    const decision = UNSAFE_testOnlyDecision({ decisionType: 'APPROVE_PRESENTATION', packet });
    const snap = derivePresentationSnapshotFromDecision({
      packet, decision, allDecisions: [decision], presentationSnapshotId: 'PLACEHOLDER-SNAPSHOT-0001',
    }).snapshot!;
    const json = JSON.stringify(snap);
    for (const s of ['APPROVED_FOR_OUTREACH', 'EMAIL_READY', 'SEND_READY', 'CONTACT_READY', 'CRM_READY',
      'BEFORE', 'AFTER', 'IMPROVED', 'VERIFIED', 'youtube', 'publish']) {
      expect(json).not.toContain(s);
    }
  });
});
