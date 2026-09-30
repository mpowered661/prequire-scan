// Qualification healthy extraction-band catalog repair — regression tests.
//
// The repair corrects only the human-visible gate REASON for two known healthy
// extraction-resilience bands. Every qualification OUTCOME must be unchanged,
// and every identity hash must be unchanged.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CATALOG, catalogFor, isKnownType, remediationDescriptor, verificationDescriptor } from './catalog';
import { qualify } from './qualify';
import type { OpportunityResult, QualificationInput } from './types';
import { QUALIFICATION_VERSION } from './versions';

const input = JSON.parse(
  readFileSync(new URL('./__fixtures__/michael-pilot.json', import.meta.url), 'utf8'),
) as QualificationInput;

const result = qualify(input);

function find(detector: string, subject: string): OpportunityResult {
  const hit = result.opportunities.find(o => o.detector === detector && o.subject === subject);
  if (!hit) throw new Error(`no opportunity for ${detector}:${subject}`);
  return hit;
}

const HEALTHY_BANDS = ['band:mostly_resilient', 'band:resilient'] as const;

// Frozen vector captured from oq-0.1 BEFORE the repair. Locks outcomes AND identity.
const FROZEN_BEFORE = [
  { detector: 'broken_internal_target', subject: 'https://michaelhingson.com/about/', status: 'QUALIFIED', priority: 'T1', confidence: 'verified', outreach: 'ELIGIBLE_FOR_HUMAN_REVIEW', demo: true, num: 1, den: 40, key: 'ad5067cc2bac244ed2f45182f6c73cd7', fingerprint: '7aba0c021ec37c3724b770a2aa580c9c' },
  { detector: 'broken_internal_target', subject: 'https://michaelhingson.com/accessibility-statement/', status: 'QUALIFIED', priority: 'T1', confidence: 'verified', outreach: 'ELIGIBLE_FOR_HUMAN_REVIEW', demo: true, num: 1, den: 40, key: '582f3f758fe30f0b0a1afe1a54bb5537', fingerprint: 'c56c8bbd9081fd6bc170146c56ebfa4d' },
  { detector: 'broken_internal_target', subject: 'https://michaelhingson.com/author/', status: 'QUALIFIED', priority: 'T1', confidence: 'verified', outreach: 'ELIGIBLE_FOR_HUMAN_REVIEW', demo: true, num: 1, den: 40, key: '05b190ebe78a1823ad1317ec6d8c9946', fingerprint: '2faedc74501abda69bdfc23f7d5e9cf9' },
  { detector: 'broken_internal_target', subject: 'https://michaelhingson.com/privacy-policy/', status: 'QUALIFIED', priority: 'T1', confidence: 'verified', outreach: 'ELIGIBLE_FOR_HUMAN_REVIEW', demo: true, num: 1, den: 40, key: '4fd65f3a2a885370dcbf870123c3eb3e', fingerprint: 'e24fddab13c32edab400eff4e593beea' },
  { detector: 'content_delivery_condition', subject: 'delivery:client_side_rendered', status: 'QUALIFIED', priority: 'T3', confidence: 'extracted', outreach: 'NOT_ELIGIBLE', demo: true, num: 10, den: 25, key: '48c7ccec12da3131bc2e950b51e22f1b', fingerprint: 'd0d01e77a4808813cb56f8b7b40f7400' },
  { detector: 'extraction_band', subject: 'band:fragile', status: 'QUALIFIED', priority: 'T2', confidence: 'extracted', outreach: 'NEEDS_HUMAN_REVIEW', demo: false, num: 20, den: 25, key: 'b93007c97686e4040a60138aa6f99202', fingerprint: '50c31f6c6aad1396f1745bae600178e8' },
  { detector: 'extraction_band', subject: 'band:mostly_resilient', status: 'NOT_QUALIFIED', priority: 'T_NONE', confidence: 'extracted', outreach: 'NOT_ELIGIBLE', demo: false, num: 4, den: 25, key: '7edef847b05941d02bf9a4f27cf3b719', fingerprint: '32531b7758e7d01bbaa6bf68d941aaf1' },
  { detector: 'extraction_band', subject: 'band:resilient', status: 'NOT_QUALIFIED', priority: 'T_NONE', confidence: 'extracted', outreach: 'NOT_ELIGIBLE', demo: false, num: 1, den: 25, key: '9aceccbf803d9a9bb15c9a5733fe8665', fingerprint: 'cdb417c8c48aa4d6b660a6c05fce92fc' },
  { detector: 'page_check_failure', subject: 'fact_attribution', status: 'QUALIFIED', priority: 'T2', confidence: 'extracted', outreach: 'NEEDS_HUMAN_REVIEW', demo: false, num: 18, den: 25, key: 'fcbab37f49e25e2045e420f687735456', fingerprint: '4428fcde35a3f92b8ea2c2a19fce64aa' },
  { detector: 'page_check_failure', subject: 'qualifier_preservation', status: 'QUALIFIED', priority: 'T3', confidence: 'extracted', outreach: 'NEEDS_HUMAN_REVIEW', demo: false, num: 8, den: 25, key: '9aeb277375720b7f846d1e5e49b3857e', fingerprint: 'c3092117f82cd401cece86b6c2dc8ea8' },
  { detector: 'page_check_undeterminable', subject: 'entity_consistency', status: 'NOT_QUALIFIED', priority: 'T_NONE', confidence: 'undeterminable', outreach: 'NOT_ELIGIBLE', demo: false, num: 14, den: 25, key: '97f2e0c4bdad028225258e560a5ffe24', fingerprint: 'f570b4eb6d239953448cd5b61f6a0715' },
  { detector: 'page_check_undeterminable', subject: 'visual_fact_reachability', status: 'NOT_QUALIFIED', priority: 'T_NONE', confidence: 'undeterminable', outreach: 'NOT_ELIGIBLE', demo: false, num: 2, den: 25, key: 'b38be87e939f559c857a1d335b932207', fingerprint: '43400d6bdc41b1dfab1d7e4ff637d2d5' },
  { detector: 'structured_data_presence', subject: 'structured_data', status: 'NOT_QUALIFIED', priority: 'T_NONE', confidence: 'extracted', outreach: 'NOT_ELIGIBLE', demo: true, num: 25, den: 25, key: '1f9dfe25c8d314943867fd1366e916bb', fingerprint: 'c6d818f88b37350f04beafe2dc46b74d' },
] as const;

describe('repair — the two healthy extraction bands', () => {
  it('1/6 both remain NOT_QUALIFIED', () => {
    for (const subject of HEALTHY_BANDS) {
      expect(find('extraction_band', subject).status, subject).toBe('NOT_QUALIFIED');
    }
  });

  it('2/7 both now first fail G9 (nothing to remediate)', () => {
    for (const subject of HEALTHY_BANDS) {
      const o = find('extraction_band', subject);
      expect(o.firstFailedGate, subject).toBe('G9');
      const g9 = o.gateResults.find(g => g.gate === 'G9')!;
      expect(g9.passed).toBe(false);
      expect(g9.reason).toContain('nothing to remediate');
    }
  });

  it('3/8 neither fails G8 any more — the band type is now known', () => {
    for (const subject of HEALTHY_BANDS) {
      const o = find('extraction_band', subject);
      expect(o.firstFailedGate, subject).not.toBe('G8');
      expect(o.gateResults.find(g => g.gate === 'G8')!.passed, subject).toBe(true);
      expect(isKnownType(o), subject).toBe(true);
    }
  });

  it('4/9 remediationClass is null and no descriptor is produced', () => {
    for (const subject of HEALTHY_BANDS) {
      const o = find('extraction_band', subject);
      expect(o.remediation, subject).toBeNull();
      expect(o.verification, subject).toBeNull();
      const entry = catalogFor(o);
      expect(entry.remediationClass).toBeNull();
      expect(entry.verificationMethod).toBeNull();
      expect(remediationDescriptor(entry)).toBeNull();
      expect(verificationDescriptor(entry)).toBeNull();
    }
  });

  it('5/10 neither can generate a remediation or presentable claim', () => {
    for (const subject of HEALTHY_BANDS) {
      const o = find('extraction_band', subject);
      expect(o.allowedClaims.filter(c => c.externallyPresentable), subject).toHaveLength(0);
      for (const c of o.allowedClaims) {
        expect(c.text).not.toMatch(/fix|repair|remediat|improve|should|recommend/i);
      }
    }
  });

  it('G12 remains consistent: a healthy state is not an adverse condition', () => {
    for (const subject of HEALTHY_BANDS) {
      const o = find('extraction_band', subject);
      expect(o.polarity, subject).toBe('healthy');
      const g12 = o.gateResults.find(g => g.gate === 'G12')!;
      expect(g12.passed).toBe(false);
      expect(g12.reason).toContain('healthy observed state');
    }
  });

  it('the honest reason replaced unknown_opportunity_type', () => {
    for (const subject of HEALTHY_BANDS) {
      const o = find('extraction_band', subject);
      expect(o.presentationEvidenceReason, subject).not.toContain('unknown_opportunity_type');
      expect(o.presentationEvidenceReason, subject).toContain('healthy state');
    }
  });

  it('27 no healthy band becomes a claimable problem', () => {
    for (const subject of HEALTHY_BANDS) {
      const o = find('extraction_band', subject);
      expect(o.technicalPriority, subject).toBe('T_NONE');
      expect(o.outreachSuitability, subject).toBe('NOT_ELIGIBLE');
      expect(o.presentationEvidenceAvailable, subject).toBe(false);
    }
  });

  it('28 no business-impact language appears in any claim text', () => {
    // Scoped to claim TEXT: `prohibitedClaimClasses` legitimately contains
    // tokens like "revenue_impact", which is the prohibition, not a claim.
    const texts = result.opportunities.flatMap(o => o.allowedClaims.map(c => c.text));
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) {
      expect(text).not.toMatch(/revenue|ranking|SEO|penalt|costing|losing|customers|traffic|conversion|AI visibility|citation|compliance/i);
    }
  });
});

describe('binding outcome invariant — nothing else changed', () => {
  it('11/12/13 the full 13-row outcome and identity vector is unchanged', () => {
    expect(result.opportunities).toHaveLength(13);
    expect(result.opportunities.filter(o => o.status === 'QUALIFIED')).toHaveLength(8);
    expect(result.opportunities.filter(o => o.status === 'NOT_QUALIFIED')).toHaveLength(5);
    for (const want of FROZEN_BEFORE) {
      const o = find(want.detector, want.subject);
      expect(o.status, want.subject).toBe(want.status);
      expect(o.technicalPriority, want.subject).toBe(want.priority);
      expect(o.confidence, want.subject).toBe(want.confidence);
      expect(o.outreachSuitability, want.subject).toBe(want.outreach);
      expect(o.presentationEvidenceAvailable, want.subject).toBe(want.demo);
      expect(o.numerator, want.subject).toBe(want.num);
      expect(o.denominator, want.subject).toBe(want.den);
    }
  });

  it('22 opportunity_key is unchanged for every row — the version bump does not touch identity', () => {
    for (const want of FROZEN_BEFORE) {
      expect(find(want.detector, want.subject).opportunityKey, want.subject).toBe(want.key);
    }
  });

  it('23 evidence_fingerprint is unchanged for every row', () => {
    for (const want of FROZEN_BEFORE) {
      expect(find(want.detector, want.subject).evidenceFingerprint, want.subject).toBe(want.fingerprint);
    }
  });

  it('14 the four broken destinations remain qualified at T1/verified', () => {
    const broken = result.opportunities.filter(o => o.detector === 'broken_internal_target');
    expect(broken).toHaveLength(4);
    for (const o of broken) {
      expect(o.status).toBe('QUALIFIED');
      expect(o.technicalPriority).toBe('T1');
      expect(o.confidence).toBe('verified');
      expect(o.outreachSuitability).toBe('ELIGIBLE_FOR_HUMAN_REVIEW');
    }
  });

  it('15 fragile extraction remains qualified at T2', () => {
    const o = find('extraction_band', 'band:fragile');
    expect(o.status).toBe('QUALIFIED');
    expect(o.technicalPriority).toBe('T2');
    expect(o.polarity).toBe('adverse');
    expect(o.remediation!.remediationClass).toBe('content_entity_clarification');
  });

  it('16/17 fact attribution and qualifier preservation remain qualified', () => {
    expect(find('page_check_failure', 'fact_attribution').status).toBe('QUALIFIED');
    expect(find('page_check_failure', 'fact_attribution').technicalPriority).toBe('T2');
    expect(find('page_check_failure', 'qualifier_preservation').status).toBe('QUALIFIED');
    expect(find('page_check_failure', 'qualifier_preservation').technicalPriority).toBe('T3');
  });

  it('18/19 undeterminable checks remain not qualified at G3', () => {
    for (const s of ['entity_consistency', 'visual_fact_reachability']) {
      const o = find('page_check_undeterminable', s);
      expect(o.status, s).toBe('NOT_QUALIFIED');
      expect(o.firstFailedGate, s).toBe('G3');
    }
  });

  it('20 structured-data healthy remains not qualified at G9', () => {
    const o = find('structured_data_presence', 'structured_data');
    expect(o.status).toBe('NOT_QUALIFIED');
    expect(o.firstFailedGate).toBe('G9');
    expect(o.condition).toBe('structured_data_present');
  });

  it('21 client_side_rendered retains its accepted outcome', () => {
    const o = find('content_delivery_condition', 'delivery:client_side_rendered');
    expect(o.status).toBe('QUALIFIED');
    expect(o.technicalPriority).toBe('T3');
    expect(o.outreachSuitability).toBe('NOT_ELIGIBLE');
  });

  it('review calibration split is preserved: 4 demonstrable / 3 statement-only / 6 refused', () => {
    const eligible = result.opportunities.filter(
      o => o.status === 'QUALIFIED' && o.outreachSuitability !== 'NOT_ELIGIBLE');
    expect(eligible).toHaveLength(7);
    expect(eligible.filter(o => o.presentationEvidenceAvailable)).toHaveLength(4);
    expect(eligible.filter(o => !o.presentationEvidenceAvailable)).toHaveLength(3);
    expect(result.opportunities.length - eligible.length).toBe(6);
  });
});

describe('scope and safety of the repair', () => {
  it('the version is the accepted patch level', () => {
    expect(QUALIFICATION_VERSION).toBe('oq-0.1.1');
    expect(result.qualificationVersion).toBe('oq-0.1.1');
  });

  it('26 insufficient_evidence was deliberately NOT catalogued', () => {
    expect(Object.keys(CATALOG)).not.toContain('extraction_band:insufficient_evidence');
    // and it would still fail closed if it ever appeared
    expect(isKnownType({ detector: 'extraction_band', condition: 'insufficient_evidence' })).toBe(false);
  });

  it('25 an UNKNOWN condition still fails safely', () => {
    const unknown = { detector: 'extraction_band', condition: 'some_future_band' };
    expect(isKnownType(unknown)).toBe(false);
    const entry = catalogFor(unknown);
    expect(entry.remediationClass).toBeNull();
    expect(entry.presentationReason).toBe('unknown_opportunity_type');
    expect(entry.requiresImpactInference).toBe(true);
  });

  it('only the two intended catalog keys were added', () => {
    const bandKeys = Object.keys(CATALOG).filter(k => k.startsWith('extraction_band:')).sort();
    expect(bandKeys).toEqual([
      'extraction_band:fragile',
      'extraction_band:mostly_resilient',
      'extraction_band:resilient',
    ]);
  });

  it('24 array-order determinism is intact', () => {
    const shuffled: QualificationInput = {
      ...input,
      pageObservations: [...input.pageObservations].reverse(),
      linkTargets: [...input.linkTargets].reverse(),
      linkRelationships: [...input.linkRelationships].reverse(),
      scanUrls: [...input.scanUrls].reverse(),
    };
    expect(JSON.stringify(qualify(shuffled))).toBe(JSON.stringify(qualify(input)));
  });

  it('qualification remains derive-only: zero network requests', () => {
    expect(result.networkRequestsMade).toBe(0);
  });
});
