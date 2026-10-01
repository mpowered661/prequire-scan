// Opportunity Review v0.1 — Michael calibration.
//
// Uses the accepted fixture only. Michael was NOT run live and nothing is
// fetched. There is no Michael-specific rule anywhere in the review layer.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { qualify } from '../opportunity-qualification/qualify';
import type { QualificationInput } from '../opportunity-qualification/types';
import { deriveReview, type QualificationResultView } from './review-packet';
import type { ReviewPacket } from './types';

const input = JSON.parse(
  readFileSync(new URL('../opportunity-qualification/__fixtures__/michael-pilot.json', import.meta.url), 'utf8'),
) as QualificationInput;

const qualification = qualify(input) as unknown as QualificationResultView;
const review = deriveReview(qualification);

function packet(detector: string, subject: string): ReviewPacket {
  const hit = review.packets.find(p => p.detector === detector && p.subject === subject);
  if (!hit) throw new Error(`no packet for ${detector}:${subject}`);
  return hit;
}
function refusedFor(detector: string, subject: string) {
  const hit = review.refused.find(r => r.detector === detector && r.subject === subject);
  if (!hit) throw new Error(`not refused: ${detector}:${subject}`);
  return hit;
}

const BROKEN = [
  'https://michaelhingson.com/about/',
  'https://michaelhingson.com/accessibility-statement/',
  'https://michaelhingson.com/author/',
  'https://michaelhingson.com/privacy-policy/',
];

describe('Michael calibration — totals', () => {
  it('13 qualification opportunities, 7 packets, 6 refused', () => {
    expect(qualification.qualificationVersion).toBe('oq-0.1.1');
    expect(qualification.opportunities).toHaveLength(13);
    expect(review.packets).toHaveLength(7);
    expect(review.refused).toHaveLength(6);
    expect(review.packets.length + review.refused.length).toBe(13);
  });

  it('4 STATEMENT_WITH_DEMONSTRATION, 3 STATEMENT_ONLY', () => {
    const withDemo = review.packets.filter(p => p.presentationMode === 'STATEMENT_WITH_DEMONSTRATION');
    const only = review.packets.filter(p => p.presentationMode === 'STATEMENT_ONLY');
    expect(withDemo).toHaveLength(4);
    expect(only).toHaveLength(3);
    expect(withDemo.every(p => p.detector === 'broken_internal_target')).toBe(true);
  });

  it('4 meet Scout evidence requirements, 3 do not', () => {
    expect(review.packets.filter(p => p.meetsScoutEvidenceRequirements)).toHaveLength(4);
    expect(review.packets.filter(p => !p.meetsScoutEvidenceRequirements)).toHaveLength(3);
  });

  it('zero approvals, zero decisions, zero snapshots, zero network, zero persistence', () => {
    expect(review.completedApprovals).toBe(0);
    expect(review.reviewDecisionsInstantiated).toBe(0);
    expect(review.presentationSnapshotsInstantiated).toBe(0);
    expect(review.networkRequestsMade).toBe(0);
    expect(review.persistedRecords).toBe(0);
    for (const p of review.packets) expect(p.humanApprovalState).toBe('UNREPRESENTABLE_IN_V0_1');
  });
});

describe('Michael calibration — the four broken destinations', () => {
  it('each gets a packet at STATEMENT_WITH_DEMONSTRATION meeting Scout evidence requirements', () => {
    for (const subject of BROKEN) {
      const p = packet('broken_internal_target', subject);
      expect(p.presentationMode, subject).toBe('STATEMENT_WITH_DEMONSTRATION');
      expect(p.demonstration.status, subject).toBe('DEMONSTRABLE');
      expect(p.demonstration.reproductionMethod, subject).toBe('request_url_and_observe_status');
      expect(p.meetsScoutEvidenceRequirements, subject).toBe(true);
      expect(p.technicalPriority, subject).toBe('T1');
      expect(p.confidence, subject).toBe('verified');
      expect(p.reviewEligibility.entry, subject).toBe('ELIGIBLE_FOR_REVIEW');
      expect(p.reviewEligibility.blockingReasons, subject).toHaveLength(0);
    }
  });

  it('/about/ preserves BOTH populations without conflating them', () => {
    const p = packet('broken_internal_target', 'https://michaelhingson.com/about/');
    expect(p.populations).toHaveLength(2);
    const byLabel = Object.fromEntries(p.populations.map(x => [x.label, x]));
    expect(byLabel.analyzed_pages).toEqual({ label: 'analyzed_pages', numerator: 25, denominator: 25 });
    expect(byLabel.checked_link_destinations).toEqual({ label: 'checked_link_destinations', numerator: 1, denominator: 40 });
    expect(p.canonicalClaim.metric).toBe('http_status');
    expect(p.canonicalClaim.observedValue).toBe('404');
    expect(p.canonicalClaim.temporalFrame).toBe('CURRENT_STATE');
  });

  it('/author/ carries its own distinct source-page numerator', () => {
    const p = packet('broken_internal_target', 'https://michaelhingson.com/author/');
    const byLabel = Object.fromEntries(p.populations.map(x => [x.label, x]));
    expect(byLabel.analyzed_pages.numerator).toBe(9);
    expect(byLabel.analyzed_pages.denominator).toBe(25);
    expect(byLabel.checked_link_destinations).toEqual({ label: 'checked_link_destinations', numerator: 1, denominator: 40 });
  });

  it('the presentable prose states both populations and never widens scope', () => {
    const p = packet('broken_internal_target', 'https://michaelhingson.com/about/');
    const presentable = p.claimCandidates.filter(c => c.externallyPresentable);
    expect(presentable.length).toBeGreaterThanOrEqual(1);
    const direct = presentable.find(c => c.epistemicClass === 'DIRECT_OBSERVATION')!;
    expect(direct.prose).toContain('25 of the 25 analyzed pages');
    expect(direct.prose).toContain('40 checked link destinations');
    expect(direct.prose).toContain('HTTP 404');
    for (const c of presentable) {
      expect(c.prose).not.toMatch(/website|entire site|all links|everywhere|%|percent/i);
      expect(c.prose).not.toMatch(/revenue|ranking|customers|traffic|SEO/i);
    }
  });

  it('carries the full twelve-gate trace', () => {
    const p = packet('broken_internal_target', 'https://michaelhingson.com/about/');
    expect(p.gateTrace.map(g => g.gate)).toEqual(['G1','G2','G3','G4','G5','G6','G7','G8','G9','G10','G11','G12']);
    expect(p.gateTrace.every(g => g.passed)).toBe(true);
    expect(p.firstFailedGate).toBeNull();
  });
});

describe('Michael calibration — the three STATEMENT_ONLY packets', () => {
  const cases = [
    { detector: 'extraction_band', subject: 'band:fragile', num: 20, priority: 'T2' },
    { detector: 'page_check_failure', subject: 'fact_attribution', num: 18, priority: 'T2' },
    { detector: 'page_check_failure', subject: 'qualifier_preservation', num: 8, priority: 'T3' },
  ] as const;

  it('each is reviewable intelligence but does not meet Scout evidence requirements', () => {
    for (const c of cases) {
      const p = packet(c.detector, c.subject);
      expect(p.reviewEligibility.entry, c.subject).toBe('ELIGIBLE_FOR_REVIEW');
      expect(p.presentationMode, c.subject).toBe('STATEMENT_ONLY');
      expect(p.demonstration.status, c.subject).toBe('NOT_DEMONSTRABLE');
      expect(p.demonstration.reproductionMethod, c.subject).toBe('none_available');
      expect(p.demonstration.showableRefs, c.subject).toHaveLength(0);
      expect(p.meetsScoutEvidenceRequirements, c.subject).toBe(false);
      expect(p.technicalPriority, c.subject).toBe(c.priority);
    }
  });

  it('claims keep the analyzed-sample denominator and never widen it', () => {
    for (const c of cases) {
      const p = packet(c.detector, c.subject);
      expect(p.populations).toEqual([{ label: 'analyzed_pages', numerator: c.num, denominator: 25 }]);
      const direct = p.claimCandidates.find(x => x.epistemicClass === 'DIRECT_OBSERVATION')!;
      expect(direct.prose).toContain(`${c.num} of the 25 analyzed pages`);
      expect(direct.prose).not.toMatch(/website|entire site|all pages|%|percent/i);
    }
  });

  it('their HYPOTHESIS claims are INTERNAL_ONLY and never presentable', () => {
    for (const c of cases) {
      const p = packet(c.detector, c.subject);
      const hyps = p.claimCandidates.filter(x => x.epistemicClass === 'HYPOTHESIS');
      expect(hyps.length, c.subject).toBeGreaterThanOrEqual(1);
      for (const h of hyps) {
        expect(h.presentationPermission).toBe('INTERNAL_ONLY');
        expect(h.externallyPresentable).toBe(false);
      }
    }
  });

  it('presentation_evidence_absent is surfaced as an uncertainty', () => {
    for (const c of cases) {
      expect(packet(c.detector, c.subject).uncertainties, c.subject).toContain('presentation_evidence_absent');
    }
  });
});

describe('Michael calibration — the six refused', () => {
  const refusals = [
    { detector: 'page_check_undeterminable', subject: 'entity_consistency' },
    { detector: 'page_check_undeterminable', subject: 'visual_fact_reachability' },
    { detector: 'structured_data_presence', subject: 'structured_data' },
    { detector: 'extraction_band', subject: 'band:mostly_resilient' },
    { detector: 'extraction_band', subject: 'band:resilient' },
    { detector: 'content_delivery_condition', subject: 'delivery:client_side_rendered' },
  ] as const;

  it('all six are refused entry with recorded reasons', () => {
    expect(review.refused).toHaveLength(6);
    for (const r of refusals) {
      const hit = refusedFor(r.detector, r.subject);
      expect(hit.eligibility.entry, r.subject).toBe('NOT_ELIGIBLE_FOR_REVIEW');
      expect(hit.eligibility.blockingReasons.length, r.subject).toBeGreaterThan(0);
    }
  });

  it('undeterminable checks are refused for being not qualified, not for being adverse', () => {
    for (const s of ['entity_consistency', 'visual_fact_reachability']) {
      const hit = refusedFor('page_check_undeterminable', s);
      expect(hit.eligibility.blockingReasons.join(' ')).toContain('NOT_QUALIFIED');
      expect(hit.eligibility.blockingReasons.join(' ')).toContain('G3');
    }
  });

  it('healthy structured data is refused, citing its healthy polarity', () => {
    const hit = refusedFor('structured_data_presence', 'structured_data');
    expect(hit.eligibility.blockingReasons.join(' ')).toContain('healthy');
  });

  it('both healthy extraction bands are refused, citing G9 after the catalog repair', () => {
    for (const s of ['band:mostly_resilient', 'band:resilient']) {
      const hit = refusedFor('extraction_band', s);
      const reasons = hit.eligibility.blockingReasons.join(' ');
      expect(reasons, s).toContain('G9');
      expect(reasons, s).toContain('healthy');
      expect(reasons, s).not.toContain('G8');
    }
  });

  it('client_side_rendered is refused for qualification NOT_ELIGIBLE', () => {
    const hit = refusedFor('content_delivery_condition', 'delivery:client_side_rendered');
    expect(hit.eligibility.blockingReasons.join(' ')).toContain('NOT_ELIGIBLE');
  });

  it('no refused opportunity produced a packet', () => {
    for (const r of refusals) {
      expect(review.packets.find(p => p.detector === r.detector && p.subject === r.subject)).toBeUndefined();
    }
  });
});

describe('Michael calibration — packet hygiene', () => {
  it('every packet is atomic: one key, one fingerprint, one claim hash', () => {
    const keys = review.packets.map(p => p.opportunityKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const p of review.packets) {
      expect(p.opportunityKey).toMatch(/^[0-9a-f]{32}$/);
      expect(p.evidenceFingerprint).toMatch(/^[0-9a-f]{32}$/);
      expect(p.claimHash).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it('no packet claims site scope and every one flags the unknown site total', () => {
    for (const p of review.packets) {
      expect(p.scopeLevel).not.toBe('site');
      expect(p.coverage.siteTotalKnown).toBe(false);
      expect(p.uncertainties).toContain('site_total_unknown');
      expect(p.uncertainties).toContain('sampled_population_only');
    }
  });

  it('no raw HTML, page prose or markup enters any packet', () => {
    const json = JSON.stringify(review);
    for (const tag of ['<html', '<body', '<div', '<script', '<p>', '<h1']) expect(json).not.toContain(tag);
  });

  it('no outreach or approval state is reachable', () => {
    const json = JSON.stringify(review);
    for (const s of ['APPROVED_FOR_OUTREACH', 'EMAIL_READY', 'SEND_READY', 'CONTACT_READY', 'CRM_READY', 'APPROVED_FOR_PRESENTATION']) {
      expect(json).not.toContain(s);
    }
  });

  it('the review contract version is stamped and qualification is untouched', () => {
    expect(review.reviewContractVersion).toBe('or-0.1');
    expect(review.qualificationVersion).toBe('oq-0.1.1');
    for (const p of review.packets) {
      expect(p.reviewContractVersion).toBe('or-0.1');
      expect(p.qualificationVersion).toBe('oq-0.1.1');
    }
  });
});
