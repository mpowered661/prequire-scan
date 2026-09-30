// Opportunity Qualification v0.1 — Michael calibration.
//
// Calibration only. There is no Michael-specific rule anywhere in the engine:
// the fixture is durable evidence from the accepted 2026-09-30 pilot and every
// expectation below is produced by the generic contract.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { qualify } from './qualify';
import type { OpportunityResult, QualificationInput } from './types';

const input = JSON.parse(
  readFileSync(new URL('./__fixtures__/michael-pilot.json', import.meta.url), 'utf8'),
) as QualificationInput;

const result = qualify(input);

function find(detector: string, subject: string): OpportunityResult {
  const hit = result.opportunities.find(o => o.detector === detector && o.subject === subject);
  if (!hit) throw new Error(`no opportunity for ${detector}:${subject}`);
  return hit;
}

const BROKEN = [
  'https://michaelhingson.com/about/',
  'https://michaelhingson.com/accessibility-statement/',
  'https://michaelhingson.com/privacy-policy/',
  'https://michaelhingson.com/author/',
];

describe('Michael calibration — coverage context', () => {
  it('carries the pilot denominators and does not know the site total', () => {
    expect(result.coverage).toMatchObject({
      discovered: 1138, selected: 25, fetched: 25, analysisComplete: 25,
      uniqueInternalTargets: 305, targetsChecked: 40, targetsUnchecked: 265,
      siteTotalKnown: false,
    });
  });

  it('makes zero network requests', () => {
    expect(result.networkRequestsMade).toBe(0);
  });
});

describe('Candidate A — repeated broken internal destinations', () => {
  it('produces ONE opportunity per destination, not one per relationship', () => {
    const brokenOpps = result.opportunities.filter(o => o.detector === 'broken_internal_target');
    expect(brokenOpps).toHaveLength(4);
    expect(brokenOpps.map(o => o.subject).sort()).toEqual([...BROKEN].sort());
    // 25 source relationships collapse into one cluster carrying the count.
    const about = find('broken_internal_target', 'https://michaelhingson.com/about/');
    expect(about.sourceLinkCount).toBe(25);
    expect(about.numerator).toBe(1);
    expect(about.denominator).toBe(40);
  });

  it('QUALIFIED, T1, verified, ELIGIBLE_FOR_HUMAN_REVIEW, demonstrable', () => {
    for (const subject of BROKEN) {
      const o = find('broken_internal_target', subject);
      expect(o.status, subject).toBe('QUALIFIED');
      expect(o.firstFailedGate, subject).toBeNull();
      expect(o.technicalPriority, subject).toBe('T1');
      expect(o.confidence, subject).toBe('verified');
      expect(o.outreachSuitability, subject).toBe('ELIGIBLE_FOR_HUMAN_REVIEW');
      expect(o.presentationEvidenceAvailable, subject).toBe(true);
    }
  });

  it('permits the observation and prohibits the impact claims', () => {
    const o = find('broken_internal_target', 'https://michaelhingson.com/about/');
    const direct = o.allowedClaims.find(c => c.claimClass === 'DIRECT_OBSERVATION')!;
    expect(direct.text).toContain('25 of the 25 analyzed pages');
    expect(direct.text).toContain('HTTP 404');
    expect(direct.evidenceRefs.length).toBeGreaterThan(0);
    const bounded = o.allowedClaims.find(c => c.claimClass === 'BOUNDED_INTERPRETATION')!;
    expect(bounded.externallyPresentable).toBe(true);
    // No externally presentable claim asserts an outcome.
    for (const c of o.allowedClaims.filter(x => x.externallyPresentable)) {
      expect(c.text).not.toMatch(/costing|customers|ranking|rankings|revenue|AI visibility|accessibility law|cannot find/i);
    }
    for (const forbidden of ['revenue_impact', 'search_ranking_impact', 'accessibility_compliance_failure', 'customer_loss']) {
      expect(o.prohibitedClaimClasses).toContain(forbidden);
    }
  });

  it('carries a remediation class and a verification path, neither performed', () => {
    const o = find('broken_internal_target', 'https://michaelhingson.com/about/');
    expect(o.remediation).toMatchObject({
      remediationClass: 'link_destination_repair', authorizationRequired: true, performed: false,
    });
    expect(o.verification).toMatchObject({
      method: 're_check_target_and_compare_classification', performed: false, baselineCaptured: false,
    });
  });
});

describe('Candidate B — extraction resilience band', () => {
  it('QUALIFIED, T2, NEEDS_HUMAN_REVIEW, wording preserves 20 of 25 analyzed', () => {
    const o = find('extraction_band', 'band:fragile');
    expect(o.numerator).toBe(20);
    expect(o.denominator).toBe(25);
    expect(o.scopeLevel).toBe('analyzed_sample');
    expect(o.status).toBe('QUALIFIED');
    expect(o.technicalPriority).toBe('T2');
    expect(o.outreachSuitability).toBe('NEEDS_HUMAN_REVIEW');
    const direct = o.allowedClaims.find(c => c.claimClass === 'DIRECT_OBSERVATION')!;
    expect(direct.text).toContain('20 of the 25 analyzed pages');
    expect(direct.text).not.toMatch(/80%|percent|most of the website|most of the site/i);
  });
});

describe('Candidate C — fact_attribution failures', () => {
  it('QUALIFIED, T2, NEEDS_HUMAN_REVIEW, no showable example', () => {
    const o = find('page_check_failure', 'fact_attribution');
    expect(o.numerator).toBe(18);
    expect(o.denominator).toBe(25);
    expect(o.status).toBe('QUALIFIED');
    expect(o.technicalPriority).toBe('T2');
    expect(o.outreachSuitability).toBe('NEEDS_HUMAN_REVIEW');
    expect(o.presentationEvidenceAvailable).toBe(false);
    expect(o.presentationEvidenceReason).toContain('Tranche D2');
    const direct = o.allowedClaims.find(c => c.claimClass === 'DIRECT_OBSERVATION')!;
    expect(direct.text).toContain('18 of the 25 analyzed pages');
  });
});

describe('Candidate D — qualifier_preservation failures', () => {
  it('QUALIFIED, T3, NEEDS_HUMAN_REVIEW, no showable example', () => {
    const o = find('page_check_failure', 'qualifier_preservation');
    expect(o.numerator).toBe(8);
    expect(o.denominator).toBe(25);
    expect(o.status).toBe('QUALIFIED');
    // 8 of 25 is not a majority, so it is T3 and not T2.
    expect(o.technicalPriority).toBe('T3');
    expect(o.outreachSuitability).toBe('NEEDS_HUMAN_REVIEW');
    expect(o.presentationEvidenceAvailable).toBe(false);
  });
});

describe('Candidate E — entity_consistency undeterminable', () => {
  it('NOT QUALIFIED: undeterminable is not a failure', () => {
    const o = find('page_check_undeterminable', 'entity_consistency');
    expect(o.numerator).toBe(14);
    expect(o.denominator).toBe(25);
    expect(o.status).toBe('NOT_QUALIFIED');
    expect(o.firstFailedGate).toBe('G3');
    const g3 = o.gateResults.find(g => g.gate === 'G3')!;
    expect(g3.passed).toBe(false);
    expect(g3.reason).toContain('undeterminable is not a failure');
    // G12 also rejects it as absence of evidence.
    expect(o.gateResults.find(g => g.gate === 'G12')!.passed).toBe(false);
    expect(o.outreachSuitability).toBe('NOT_ELIGIBLE');
    expect(o.confidence).toBe('undeterminable');
    // Nothing about it may be presented externally.
    expect(o.allowedClaims.every(c => !c.externallyPresentable)).toBe(true);
  });

  it('never appears as a fact_attribution-style failure', () => {
    const failures = result.opportunities.filter(o => o.detector === 'page_check_failure');
    expect(failures.map(o => o.subject)).not.toContain('entity_consistency');
  });
});

describe('Candidate F — client_side_rendered', () => {
  it('technically QUALIFIED at T3 but NOT_ELIGIBLE for outreach', () => {
    const o = find('content_delivery_condition', 'delivery:client_side_rendered');
    expect(o.numerator).toBe(10);
    expect(o.denominator).toBe(25);
    expect(o.status).toBe('QUALIFIED');
    expect(o.technicalPriority).toBe('T3');
    expect(o.outreachSuitability).toBe('NOT_ELIGIBLE');
    // It fails specifically because the statement needs an unsupported impact.
    const o9 = o.outreachGateResults.find(g => g.gate === 'O9')!;
    expect(o9.verdict).toBe('fail');
    expect(o9.reason).toContain('unsupported impact');
    const direct = o.allowedClaims.find(c => c.claimClass === 'DIRECT_OBSERVATION')!;
    expect(direct.text).toContain('10 of the 25 analyzed pages');
    // The nuance is carried, not omitted.
    expect(direct.text).toContain('rendered content');
    expect(direct.text).not.toMatch(/SEO|penalt|Google|index/i);
  });
});

describe('Candidate G — structured data present on every analyzed page', () => {
  it('NOT QUALIFIED: a healthy state is not an adverse opportunity', () => {
    const o = find('structured_data_presence', 'structured_data');
    expect(o.condition).toBe('structured_data_present');
    expect(o.numerator).toBe(25);
    expect(o.denominator).toBe(25);
    expect(o.polarity).toBe('healthy');
    expect(o.status).toBe('NOT_QUALIFIED');
    expect(o.firstFailedGate).toBe('G9');
    expect(o.technicalPriority).toBe('T_NONE');
    expect(o.outreachSuitability).toBe('NOT_ELIGIBLE');
    expect(o.remediation).toBeNull();
    expect(o.verification).toBeNull();
  });

  it('produces no structured-data-absent or malformed opportunity', () => {
    const conditions = result.opportunities
      .filter(o => o.detector === 'structured_data_presence')
      .map(o => o.condition);
    expect(conditions).not.toContain('structured_data_absent');
    expect(conditions).not.toContain('structured_data_malformed');
  });
});

describe('Michael calibration — population summary', () => {
  it('qualifies some and rejects others, and reaches exactly one eligible', () => {
    const qualified = result.opportunities.filter(o => o.status === 'QUALIFIED');
    const notQualified = result.opportunities.filter(o => o.status === 'NOT_QUALIFIED');
    expect(qualified.length).toBeGreaterThan(0);
    expect(notQualified.length).toBeGreaterThan(0);
    // Only the broken destinations are outreach-eligible for human review.
    const eligible = result.opportunities.filter(o => o.outreachSuitability === 'ELIGIBLE_FOR_HUMAN_REVIEW');
    expect(eligible.every(o => o.detector === 'broken_internal_target')).toBe(true);
    expect(eligible).toHaveLength(4);
    // No result carries an approval state — that concept does not exist in v0.1.
    for (const o of result.opportunities) {
      expect(JSON.stringify(o)).not.toContain('APPROVED_FOR_OUTREACH');
    }
  });

  it('no opportunity claims site scope', () => {
    for (const o of result.opportunities) expect(o.scopeLevel).not.toBe('site');
  });

  it('no durable page prose or raw HTML enters the result', () => {
    const json = JSON.stringify(result.opportunities);
    for (const tag of ['<html', '<body', '<div', '<p>', '<h1']) expect(json).not.toContain(tag);
  });
});
