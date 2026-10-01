// Packet identity hard gate. Fixture only; Michael is never run live.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { reviewPacketHash, supportingEvidenceRefsDigest } from '../human-review/packet-hash';
import { qualify } from '../opportunity-qualification/qualify';
import type { QualificationInput } from '../opportunity-qualification/types';
import { deriveReview, type QualificationResultView } from '../opportunity-review/review-packet';
import type { ReviewPacket } from '../opportunity-review/types';
import { selectDirectClaimCandidate, toReviewPacketView } from './packet-view';

const FIXTURE = JSON.parse(
  readFileSync(new URL('../opportunity-qualification/__fixtures__/michael-pilot.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
function fixtureInput(): QualificationInput {
  const { _provenance, ...rest } = FIXTURE;
  return JSON.parse(JSON.stringify(rest)) as QualificationInput;
}

const review = deriveReview(qualify(fixtureInput()) as unknown as QualificationResultView);
const bySubject = new Map(review.packets.map(p => [p.subject, p]));

/** The accepted hashes. These are the gate: a change here is a STOP, not a fix. */
const ACCEPTED_HASHES: Record<string, string> = {
  'https://michaelhingson.com/about/': 'cb4bfaa08dae48871f7b8e90a6973aef',
  'https://michaelhingson.com/accessibility-statement/': '36c27a3a7df6daa2c99e764756ccbc2c',
  'https://michaelhingson.com/author/': 'b15cd876d69396a5789eb5734cd2ed6a',
  'https://michaelhingson.com/privacy-policy/': 'eddae93ac9f2d6e81a7d758071f962b7',
  'band:fragile': 'eea163d288f2466e4eb54842061a886d',
  'fact_attribution': 'f59f39474e538a049e5a6a934a1671ee',
  'qualifier_preservation': '26712cba94dbcf224d03a7b56c800a6b',
};

describe('packet view adapter — packet identity hard gate', () => {
  it('1 the accepted calibration shape is unchanged', () => {
    expect(qualify(fixtureInput()).opportunities).toHaveLength(13);
    expect(review.packets).toHaveLength(7);
    expect([...bySubject.keys()].sort()).toEqual(Object.keys(ACCEPTED_HASHES).sort());
  });

  it('2 all seven accepted review_packet_hash values are reproduced exactly', () => {
    for (const [subject, expected] of Object.entries(ACCEPTED_HASHES)) {
      const packet = bySubject.get(subject)!;
      expect(reviewPacketHash(toReviewPacketView(packet)), subject).toBe(expected);
    }
  });

  it('3 /about/ is exactly cb4bfaa08dae48871f7b8e90a6973aef', () => {
    const about = bySubject.get('https://michaelhingson.com/about/')!;
    expect(reviewPacketHash(toReviewPacketView(about))).toBe('cb4bfaa08dae48871f7b8e90a6973aef');
  });

  it('4 conversion is deterministic and takes no client or database input', () => {
    for (const packet of review.packets) {
      const a = toReviewPacketView(packet);
      const b = toReviewPacketView(packet);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      expect(reviewPacketHash(a)).toBe(reviewPacketHash(b));
    }
    const src = readFileSync(new URL('./packet-view.ts', import.meta.url), 'utf8');
    for (const forbidden of ['supabase', 'fetch(', 'process.env', 'Date.now', 'new Date', 'Math.random']) {
      expect(src, forbidden).not.toContain(forbidden);
    }
  });

  it('5 the direct-claim selection rule is pinned', () => {
    for (const packet of review.packets) {
      const direct = selectDirectClaimCandidate(packet);
      const expectedFirst = packet.claimCandidates.find(
        c => c.epistemicClass === 'DIRECT_OBSERVATION' && c.externallyPresentable);
      expect(direct, packet.subject).toBe(expectedFirst ?? packet.claimCandidates[0]);
      const view = toReviewPacketView(packet);
      expect(view.presentationPermission, packet.subject).toBe(direct.presentationPermission);
      expect(view.displayProse, packet.subject).toBe(direct.prose);
    }
  });

  it('6 the fallback branch is exercised when no presentable direct observation exists', () => {
    const base = bySubject.get('https://michaelhingson.com/about/')!;
    const noDirect = {
      ...base,
      claimCandidates: base.claimCandidates.map(c => ({ ...c, externallyPresentable: false })),
    } as ReviewPacket;
    expect(selectDirectClaimCandidate(noDirect)).toBe(noDirect.claimCandidates[0]);
  });
});

describe('packet view adapter — field fidelity', () => {
  it('7 every identity-bearing field is carried from its accepted source', () => {
    for (const packet of review.packets) {
      const v = toReviewPacketView(packet);
      expect(v.opportunityKey, packet.subject).toBe(packet.opportunityKey);
      expect(v.evidenceFingerprint).toBe(packet.evidenceFingerprint);
      expect(v.claimHash).toBe(packet.claimHash);
      expect(v.qualificationStatus).toBe(packet.qualificationStatus);
      expect(v.presentationMode).toBe(packet.presentationMode);
      expect(v.demonstrabilityStatus).toBe(packet.demonstration.status);
      expect(v.meetsScoutEvidenceRequirements).toBe(packet.meetsScoutEvidenceRequirements);
      expect(v.temporalFrame).toBe(packet.canonicalClaim.temporalFrame);
      expect(v.reviewContractVersion).toBe(packet.reviewContractVersion);
      expect(v.qualificationVersion).toBe(packet.qualificationVersion);
      expect(v.observedAt).toBe(packet.canonicalClaim.observedAt);
      expect(v.scanId).toBe(packet.scanId);
      expect(v.evidenceRefs).toBe(packet.evidenceRefs);
      expect(v.canonicalClaim).toBe(packet.canonicalClaim);
      expect(v.demonstration).toBe(packet.demonstration);
      expect(v.gateTrace).toEqual(packet.gateTrace.map(g => ({ gate: g.gate, passed: g.passed })));
      expect(supportingEvidenceRefsDigest(v.evidenceRefs))
        .toBe(supportingEvidenceRefsDigest(packet.evidenceRefs));
    }
  });

  it('8 the adapter matches the pre-existing test adapters field for field', () => {
    for (const p of review.packets) {
      const direct = p.claimCandidates.find(c => c.epistemicClass === 'DIRECT_OBSERVATION' && c.externallyPresentable)
        ?? p.claimCandidates[0];
      const legacy = {
        opportunityKey: p.opportunityKey, evidenceFingerprint: p.evidenceFingerprint, claimHash: p.claimHash,
        qualificationStatus: p.qualificationStatus,
        gateTrace: p.gateTrace.map(g => ({ gate: g.gate, passed: g.passed })),
        presentationPermission: direct.presentationPermission, presentationMode: p.presentationMode,
        demonstrabilityStatus: p.demonstration.status,
        meetsScoutEvidenceRequirements: p.meetsScoutEvidenceRequirements,
        temporalFrame: p.canonicalClaim.temporalFrame, reviewContractVersion: p.reviewContractVersion,
        qualificationVersion: p.qualificationVersion, evidenceRefs: p.evidenceRefs,
        displayProse: direct.prose, canonicalClaim: p.canonicalClaim, demonstration: p.demonstration,
        observedAt: p.canonicalClaim.observedAt, scanId: p.scanId,
      };
      expect(JSON.stringify(toReviewPacketView(p)), p.subject).toBe(JSON.stringify(legacy));
    }
  });
});
