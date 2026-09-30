// Opportunity Qualification v0.1 — the 46 frozen adversarial contract tests,
// plus property/invariant tests. Each test names the attack it defends.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { buildClaims } from './claims';
import { CrossScanClusterError, buildClusters, evidenceFingerprintOf, opportunityKeyOf } from './clusters';
import { canSatisfyGate, weakestLink } from './confidence';
import { evaluateGates } from './gates';
import { technicalPriority } from './priority';
import { deriveSignals } from './signals';
import { qualify } from './qualify';
import type {
  CoverageContext,
  DurablePageObservation,
  EvidenceCluster,
  QualificationInput,
  Signal,
} from './types';

const MICHAEL = JSON.parse(
  readFileSync(new URL('./__fixtures__/michael-pilot.json', import.meta.url), 'utf8'),
) as QualificationInput;

const SHA_A = createHash('sha256').update('a').digest('hex');
const SHA_B = createHash('sha256').update('b').digest('hex');

const COVERAGE: CoverageContext = {
  discovered: 100, selected: 10, fetched: 10, analysisComplete: 10,
  uniqueInternalTargets: 20, targetsChecked: 5, targetsUnchecked: 15,
  siteTotalKnown: false,
};

function erObservation(url: string, checks: { id: string; status: string }[], band = 'fragile', sha = SHA_A): DurablePageObservation {
  return {
    scanId: 's1', requestedUrl: url, finalUrl: url,
    engine: 'extraction_resilience', engineVersion: '2026-08-inc2',
    contentSha256: sha, status: 'ok', errorReason: null,
    observedAt: '2026-09-30T00:00:00.000Z', scope: 'page',
    observation: { band, bandRule: 'r', checks: checks.map(c => ({ ...c, evidenceCount: 0 })) },
  };
}

function baseInput(over: Partial<QualificationInput> = {}): QualificationInput {
  const urls = Array.from({ length: 10 }, (_, i) => `https://example.org/p${i}`);
  return {
    scanId: 's1', scanMode: 'prospect_observation', domain: 'example.org',
    coverage: COVERAGE,
    scanUrls: urls.map(u => ({
      urlNormalized: u, httpStatus: 200, contentSha256: SHA_A,
      fetchState: 'fetched', analysisState: 'complete' as const, analyzed: true,
    })),
    pageObservations: urls.map(u => erObservation(u, [{ id: 'fact_attribution', status: 'fail' }])),
    linkTargets: [],
    linkRelationships: [],
    ...over,
  };
}

function brokenTargetInput(over: Partial<QualificationInput> = {}): QualificationInput {
  const base = baseInput();
  return {
    ...base,
    linkTargets: [{
      targetUrlNormalized: 'https://example.org/about/', checkState: 'checked', uncheckedReason: null,
      classification: 'broken_4xx', httpStatus: 404, redirectTargetUrl: null, redirectLeftOrigin: null,
      redirectHops: 0, methodUsed: 'HEAD', sourceLinkCount: 10, checkedAt: '2026-09-30T00:00:00.000Z',
    }],
    linkRelationships: base.scanUrls.map(r => ({
      sourceUrl: r.urlNormalized!, targetUrlNormalized: 'https://example.org/about/',
      anchorText: null, placement: 'footer' as const, internal: true,
    })),
    ...over,
  };
}

function cluster(over: Partial<EvidenceCluster> = {}): EvidenceCluster {
  return {
    clusterKey: 'ck', opportunityKey: 'ok', evidenceFingerprint: 'ef', scanId: 's1',
    detector: 'page_check_failure', detectorVersion: 'det-page-check-0.1',
    subject: 'fact_attribution', condition: 'check_failed', polarity: 'adverse',
    scopeLevel: 'analyzed_sample', numerator: 6, denominator: 10,
    affectedPageCount: 6, sourceLinkCount: 0, determinable: true, undeterminableCount: 0,
    signalKeys: ['k'], provenance: 'extracted', facts: {},
    evidenceRefs: [{
      kind: 'page_observation', scanId: 's1', subjectUrl: 'https://example.org/p0',
      engine: 'extraction_resilience', engineVersion: '2026-08-inc2', contentSha256: SHA_A,
      scope: 'page', observedAt: '2026-09-30T00:00:00.000Z',
    }],
    ...over,
  };
}

const ctx = { coverage: COVERAGE, completeAnalysisUrls: new Set(['https://example.org/p0']) };

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    Object.freeze(v);
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

// ═══════════════════════════════════════════════════════════════
describe('adversarial 1-10', () => {
  it('1 a negative observation alone does not become an opportunity', () => {
    // Undeterminable-only page evidence: negative-sounding, must not qualify.
    const input = baseInput({
      pageObservations: baseInput().scanUrls.map(r =>
        erObservation(r.urlNormalized!, [{ id: 'entity_consistency', status: 'undeterminable' }], 'resilient')),
    });
    const r = qualify(input);
    expect(r.opportunities.length).toBeGreaterThan(0);
    expect(r.opportunities.every(o => o.status === 'NOT_QUALIFIED')).toBe(true);
    for (const o of r.opportunities) expect(o.firstFailedGate).not.toBeNull();
  });

  it('2 sampled prevalence cannot be relabelled as whole-site', () => {
    const r = qualify(baseInput());
    for (const o of r.opportunities) {
      expect(o.scopeLevel).toBe('analyzed_sample');
      expect(o.denominator).toBe(COVERAGE.analysisComplete);
      expect(o.denominator).not.toBe(COVERAGE.discovered);
    }
  });

  it('3 no claim renders a count as a percentage or "most of the website"', () => {
    const r = qualify(MICHAEL);
    for (const o of r.opportunities) {
      for (const c of o.allowedClaims) {
        expect(c.text).not.toMatch(/%|\bpercent\b|most of the website|most of the site|\b80\s*%/i);
      }
    }
  });

  it('4 undeterminable is never counted as a failure', () => {
    const input = baseInput({
      pageObservations: baseInput().scanUrls.map(r =>
        erObservation(r.urlNormalized!, [{ id: 'entity_consistency', status: 'undeterminable' }])),
    });
    const signals = deriveSignals(input);
    expect(signals.some(s => s.detector === 'page_check_failure')).toBe(false);
    const undet = signals.find(s => s.detector === 'page_check_undeterminable')!;
    expect(undet.determinable).toBe(false);
    expect(undet.polarity).toBe('indeterminate');
  });

  it('5 missing evidence is not negative evidence', () => {
    const g = evaluateGates(cluster({ numerator: 0, affectedPageCount: 0, evidenceRefs: [] }), ctx);
    expect(g.firstFailedGate).toBe('G1');
  });

  it('6 a broken link cannot produce a revenue-loss claim', () => {
    const r = qualify(brokenTargetInput());
    const o = r.opportunities.find(x => x.detector === 'broken_internal_target')!;
    for (const c of o.allowedClaims) expect(c.text).not.toMatch(/revenue|costing|losing|customers|money|sales/i);
    expect(o.prohibitedClaimClasses).toContain('revenue_impact');
    expect(o.prohibitedClaimClasses).toContain('customer_loss');
  });

  it('7 client_side_rendered cannot produce an SEO-penalty claim', () => {
    const r = qualify(MICHAEL);
    const o = r.opportunities.find(x => x.detector === 'content_delivery_condition')!;
    for (const c of o.allowedClaims) expect(c.text).not.toMatch(/SEO|penalt|Google|rank|index/i);
    expect(o.prohibitedClaimClasses).toContain('seo_penalty');
    expect(o.outreachSuitability).toBe('NOT_ELIGIBLE');
  });

  it('8 a fragile band cannot produce an AI-visibility-loss claim externally', () => {
    const r = qualify(MICHAEL);
    const o = r.opportunities.find(x => x.detector === 'extraction_band')!;
    const external = o.allowedClaims.filter(c => c.externallyPresentable);
    for (const c of external) expect(c.text).not.toMatch(/AI visibility|citation|cited|discoverab/i);
    expect(o.prohibitedClaimClasses).toContain('ai_citation_impact');
  });

  it('9 structured-data absence cannot produce a ranking-loss claim', () => {
    const input = baseInput({
      pageObservations: baseInput().scanUrls.map(r => ({
        ...erObservation(r.urlNormalized!, []),
        engine: 'structured_data', engineVersion: '2026-08',
        observation: { hasSchema: false, hasMalformed: false, blockCount: 0, types: [] },
      })),
    });
    const r = qualify(input);
    const o = r.opportunities.find(x => x.condition === 'structured_data_absent')!;
    expect(o.status).toBe('QUALIFIED');
    for (const c of o.allowedClaims) expect(c.text).not.toMatch(/rank|SEO|traffic|visibility/i);
    expect(o.prohibitedClaimClasses).toContain('search_ranking_impact');
  });

  it('10 repeated source relationships produce ONE opportunity', () => {
    const r = qualify(brokenTargetInput());
    const broken = r.opportunities.filter(o => o.detector === 'broken_internal_target');
    expect(broken).toHaveLength(1);
    expect(broken[0].sourceLinkCount).toBe(10);
  });
});

describe('adversarial 11-20', () => {
  it('11 a duplicate scan does not create a second active opportunity for the same proposition', () => {
    const a = qualify(brokenTargetInput());
    const b = qualify(brokenTargetInput());
    expect(a.opportunities.map(o => o.opportunityKey)).toEqual(b.opportunities.map(o => o.opportunityKey));
    // Same proposition ⇒ same key AND same fingerprint when evidence is identical.
    expect(a.opportunities[0].evidenceFingerprint).toBe(b.opportunities[0].evidenceFingerprint);
  });

  it('12 qualification never mutates the evidence it was given', () => {
    const input = deepFreeze(brokenTargetInput());
    expect(() => qualify(input)).not.toThrow();
    const snapshot = JSON.stringify(input);
    qualify(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('13 a condition absent from the evidence produces no active opportunity', () => {
    const healthy = brokenTargetInput({
      linkTargets: [{
        targetUrlNormalized: 'https://example.org/about/', checkState: 'checked', uncheckedReason: null,
        classification: 'healthy', httpStatus: 200, redirectTargetUrl: null, redirectLeftOrigin: false,
        redirectHops: 0, methodUsed: 'HEAD', sourceLinkCount: 10, checkedAt: '2026-09-30T00:00:00.000Z',
      }],
    });
    const r = qualify(healthy);
    expect(r.opportunities.some(o => o.detector === 'broken_internal_target')).toBe(false);
  });

  it('14 an opportunity cannot reference evidence without provenance', () => {
    const g = evaluateGates(cluster({
      evidenceRefs: [{
        kind: 'page_observation', scanId: 's1', subjectUrl: 'https://example.org/p0',
        engine: null, engineVersion: null, contentSha256: null, scope: 'page', observedAt: null,
      }],
    }), ctx);
    expect(g.firstFailedGate).toBe('G2');
  });

  it('15 observations with different content hashes for one URL are rejected', () => {
    const g = evaluateGates(cluster({
      evidenceRefs: [
        { kind: 'page_observation', scanId: 's1', subjectUrl: 'https://example.org/p0', engine: 'e', engineVersion: 'v1', contentSha256: SHA_A, scope: 'page', observedAt: 't' },
        { kind: 'page_observation', scanId: 's1', subjectUrl: 'https://example.org/p0', engine: 'e', engineVersion: 'v1', contentSha256: SHA_B, scope: 'page', observedAt: 't' },
      ],
    }), ctx);
    expect(g.firstFailedGate).toBe('G2');
    expect(g.results.find(x => x.gate === 'G2')!.reason).toContain('content hash mismatch');
  });

  it('16 an engine contributing two versions is rejected', () => {
    const g = evaluateGates(cluster({
      evidenceRefs: [
        { kind: 'page_observation', scanId: 's1', subjectUrl: 'https://example.org/p0', engine: 'e', engineVersion: 'v1', contentSha256: SHA_A, scope: 'page', observedAt: 't' },
        { kind: 'page_observation', scanId: 's1', subjectUrl: 'https://example.org/p1', engine: 'e', engineVersion: 'v2', contentSha256: SHA_A, scope: 'page', observedAt: 't' },
      ],
    }), { coverage: COVERAGE, completeAnalysisUrls: new Set(['https://example.org/p0', 'https://example.org/p1']) });
    expect(g.results.find(x => x.gate === 'G2')!.passed).toBe(false);
  });

  it('17 page-level evidence is not promoted to a site-level claim', () => {
    const r = qualify(MICHAEL);
    for (const o of r.opportunities) {
      expect(o.scopeLevel).not.toBe('site');
      for (const c of o.allowedClaims) expect(c.text).not.toMatch(/\bthe (whole|entire) (site|website)\b/i);
    }
  });

  it('18 an unchecked target is never treated as broken', () => {
    const input = brokenTargetInput({
      linkTargets: [{
        targetUrlNormalized: 'https://example.org/about/', checkState: 'unchecked',
        uncheckedReason: 'target_budget_exhausted', classification: null, httpStatus: null,
        redirectTargetUrl: null, redirectLeftOrigin: null, redirectHops: 0, methodUsed: null,
        sourceLinkCount: 10, checkedAt: null,
      }],
    });
    expect(deriveSignals(input).some(s => s.detector === 'broken_internal_target')).toBe(false);
    // Michael's 265 unchecked targets likewise produce nothing.
    const r = qualify(MICHAEL);
    expect(r.opportunities.filter(o => o.detector === 'broken_internal_target')).toHaveLength(4);
  });

  it('19 an off-origin target is never treated as internally verified', () => {
    const input = brokenTargetInput({
      linkTargets: [{
        targetUrlNormalized: 'https://not-example.test/about/', checkState: 'checked', uncheckedReason: null,
        classification: 'broken_4xx', httpStatus: 404, redirectTargetUrl: null, redirectLeftOrigin: null,
        redirectHops: 0, methodUsed: 'HEAD', sourceLinkCount: 10, checkedAt: 't',
      }],
    });
    expect(deriveSignals(input).some(s => s.detector === 'broken_internal_target')).toBe(false);
  });

  it('20 a redirect is not treated as a failure', () => {
    const input = brokenTargetInput({
      linkTargets: [{
        targetUrlNormalized: 'https://example.org/about/', checkState: 'checked', uncheckedReason: null,
        classification: 'redirected', httpStatus: 200, redirectTargetUrl: 'https://example.org/about-us/',
        redirectLeftOrigin: false, redirectHops: 1, methodUsed: 'HEAD', sourceLinkCount: 10, checkedAt: 't',
      }],
    });
    expect(deriveSignals(input).some(s => s.detector === 'broken_internal_target')).toBe(false);
    // Michael's three redirected targets produce no broken opportunity either.
    const r = qualify(MICHAEL);
    expect(r.opportunities.filter(o => o.detector === 'broken_internal_target').map(o => o.condition))
      .toEqual(['broken_4xx', 'broken_4xx', 'broken_4xx', 'broken_4xx']);
  });
});

describe('adversarial 21-30', () => {
  it('21 POSITIVE CONTROL: a 404 qualifies as an observed failure with no impact claim', () => {
    const r = qualify(brokenTargetInput());
    const o = r.opportunities.find(x => x.detector === 'broken_internal_target')!;
    expect(o.status).toBe('QUALIFIED');
    expect(o.technicalPriority).toBe('T1');
    expect(o.confidence).toBe('verified');
    expect(o.outreachSuitability).toBe('ELIGIBLE_FOR_HUMAN_REVIEW');
    const direct = o.allowedClaims.find(c => c.claimClass === 'DIRECT_OBSERVATION')!;
    expect(direct.text).toContain('HTTP 404');
    expect(direct.externallyPresentable).toBe(true);
  });

  it('22 an engine failure is not an adverse observation about the prospect', () => {
    const input = baseInput({
      pageObservations: baseInput().scanUrls.map(r => ({
        ...erObservation(r.urlNormalized!, []),
        status: 'failed' as const, errorReason: 'analysis_input_too_large', observation: null,
      })),
    });
    expect(deriveSignals(input)).toHaveLength(0);
    expect(qualify(input).opportunities).toHaveLength(0);
  });

  it('23 partial analysis is not treated as complete', () => {
    const base = baseInput();
    const input = baseInput({
      scanUrls: base.scanUrls.map((r, i) => ({ ...r, analysisState: i < 5 ? 'complete' as const : 'partial' as const, analyzed: i < 5 })),
    });
    const s = deriveSignals(input).find(x => x.detector === 'page_check_failure')!;
    // Only the five complete pages contribute.
    expect(s.numerator).toBe(5);
    const g = evaluateGates(cluster({
      evidenceRefs: [{ kind: 'page_observation', scanId: 's1', subjectUrl: 'https://example.org/partial', engine: 'e', engineVersion: 'v', contentSha256: SHA_A, scope: 'page', observedAt: 't' }],
    }), ctx);
    expect(g.results.find(x => x.gate === 'G4')!.passed).toBe(false);
  });

  it('24 an unknown site total keeps every claim scoped', () => {
    const r = qualify(MICHAEL);
    expect(r.coverage.siteTotalKnown).toBe(false);
    for (const o of r.opportunities) {
      for (const c of o.allowedClaims.filter(x => x.externallyPresentable)) {
        if (/\d/.test(c.text)) expect(c.text).toMatch(/analyzed|checked|discovered/);
      }
    }
  });

  it('25 a prohibited claim is never externally presentable', () => {
    const c = buildClaims(cluster({ detector: 'unknown_detector', condition: 'whatever' }), COVERAGE);
    expect(c[0].claimClass).toBe('PROHIBITED');
    expect(c[0].externallyPresentable).toBe(false);
  });

  it('26 no approval state is reachable from software alone', () => {
    const r = qualify(MICHAEL);
    const states = new Set(r.opportunities.map(o => o.outreachSuitability));
    for (const s of states) {
      expect(['ELIGIBLE_FOR_HUMAN_REVIEW', 'NEEDS_HUMAN_REVIEW', 'NOT_ELIGIBLE']).toContain(s);
    }
    // The outreach state field can never hold an approval value. (Gate NAMES
    // legitimately contain the word "approved", so assert on the field.)
    for (const o of r.opportunities) {
      expect(o.outreachSuitability).not.toMatch(/^APPROVED/);
      expect(Object.keys(o)).not.toContain('approval');
      expect(Object.keys(o)).not.toContain('approvedAt');
      expect(Object.keys(o)).not.toContain('approvedBy');
    }
  });

  it('27 a HYPOTHESIS is never externally presentable', () => {
    const r = qualify(MICHAEL);
    const hyps = r.opportunities.flatMap(o => o.allowedClaims).filter(c => c.claimClass === 'HYPOTHESIS');
    expect(hyps.length).toBeGreaterThan(0);
    for (const h of hyps) expect(h.externallyPresentable).toBe(false);
  });

  it('28 severity does not change confidence', () => {
    const low = cluster({ numerator: 1, denominator: 10, affectedPageCount: 1 });
    const high = cluster({ numerator: 10, denominator: 10, affectedPageCount: 10 });
    expect(low.provenance).toBe(high.provenance);
    expect(technicalPriority(low).priority).not.toBe(technicalPriority(high).priority);
  });

  it('29 confidence does not change severity', () => {
    const a = technicalPriority(cluster({ provenance: 'extracted' }));
    const b = technicalPriority(cluster({ provenance: 'verified' }));
    const c = technicalPriority(cluster({ provenance: 'unverified' }));
    expect(a.priority).toBe(b.priority);
    expect(b.priority).toBe(c.priority);
  });

  it('30 a remediation-class mapping creates no technical conclusion', () => {
    const r = qualify(brokenTargetInput());
    const o = r.opportunities.find(x => x.detector === 'broken_internal_target')!;
    expect(o.remediation!.performed).toBe(false);
    for (const c of o.allowedClaims) expect(c.text).not.toMatch(/we (can|will) fix|Prequire offers|our service/i);
  });
});

describe('adversarial 31-46', () => {
  it('31 remediation completion never auto-marks verified', () => {
    const r = qualify(brokenTargetInput());
    for (const o of r.opportunities) {
      if (o.verification) {
        expect(o.verification.performed).toBe(false);
        expect(o.verification.possibleOutcomes).toContain('unknown');
      }
    }
  });

  it('32 no baseline is claimed, so no before/after claim can be produced', () => {
    const r = qualify(MICHAEL);
    for (const o of r.opportunities) {
      if (o.verification) expect(o.verification.baselineCaptured).toBe(false);
      for (const c of o.allowedClaims) expect(c.text).not.toMatch(/before|after|improved|was previously/i);
    }
  });

  it('33 weakened evidence changes the current decision', () => {
    const strong = qualify(brokenTargetInput());
    const weak = qualify(brokenTargetInput({
      linkTargets: [{
        targetUrlNormalized: 'https://example.org/about/', checkState: 'unchecked',
        uncheckedReason: 'target_budget_exhausted', classification: null, httpStatus: null,
        redirectTargetUrl: null, redirectLeftOrigin: null, redirectHops: 0, methodUsed: null,
        sourceLinkCount: 10, checkedAt: null,
      }],
    }));
    expect(strong.opportunities.some(o => o.detector === 'broken_internal_target')).toBe(true);
    expect(weak.opportunities.some(o => o.detector === 'broken_internal_target')).toBe(false);
  });

  it('34 strengthened evidence keeps the opportunity key and changes the fingerprint', () => {
    const before = qualify(baseInput());
    const base = baseInput();
    const after = qualify(baseInput({
      // one more page now exhibits the condition is impossible at 10/10, so
      // instead change the evidence realization via a new content hash.
      pageObservations: base.scanUrls.map(r => erObservation(r.urlNormalized!, [{ id: 'fact_attribution', status: 'fail' }], 'fragile', SHA_B)),
    }));
    const a = before.opportunities.find(o => o.detector === 'page_check_failure')!;
    const b = after.opportunities.find(o => o.detector === 'page_check_failure')!;
    expect(b.opportunityKey).toBe(a.opportunityKey);
    expect(b.evidenceFingerprint).not.toBe(a.evidenceFingerprint);
  });

  it('35 unrelated conditions never merge into one cluster', () => {
    const base = baseInput();
    const input = baseInput({
      pageObservations: base.scanUrls.map(r =>
        erObservation(r.urlNormalized!, [
          { id: 'fact_attribution', status: 'fail' },
          { id: 'qualifier_preservation', status: 'fail' },
        ])),
    });
    const clusters = buildClusters(deriveSignals(input));
    const subjects = clusters.filter(c => c.detector === 'page_check_failure').map(c => c.subject).sort();
    expect(subjects).toEqual(['fact_attribution', 'qualifier_preservation']);
  });

  it('36 one condition across pages does not become many opportunities', () => {
    const r = qualify(baseInput());
    const checks = r.opportunities.filter(o => o.detector === 'page_check_failure');
    expect(checks).toHaveLength(1);
    expect(checks[0].affectedPageCount).toBe(10);
  });

  it('37 an opportunity with no verification path cannot qualify', () => {
    const g = evaluateGates(cluster({ detector: 'page_check_undeterminable', condition: 'check_undeterminable', polarity: 'adverse', determinable: true }), ctx);
    expect(g.results.find(x => x.gate === 'G10')!.passed).toBe(false);
    expect(g.firstFailedGate).not.toBeNull();
  });

  it('38 prospect observation confers no privileged authority', () => {
    const r = qualify(MICHAEL);
    expect(r.scanMode).toBe('prospect_observation');
    for (const o of r.opportunities) {
      if (o.remediation) expect(o.remediation.authorizationRequired).toBe(true);
      if (o.remediation) expect(o.remediation.performed).toBe(false);
    }
  });

  it('39 qualification performs ZERO network requests (causally proven)', () => {
    const spy = vi.fn(() => { throw new Error('qualification attempted a network request'); });
    const original = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    let r;
    try {
      r = qualify(MICHAEL);
      qualify(brokenTargetInput());
    } finally {
      globalThis.fetch = original;
    }
    expect(spy).not.toHaveBeenCalled();
    expect(r!.networkRequestsMade).toBe(0);
  });

  it('40 no raw HTML or page prose enters the result, and none is required', () => {
    // The input type has no HTML field at all; the fixture carries none.
    expect(JSON.stringify(MICHAEL)).not.toContain('<html');
    const r = qualify(MICHAEL);
    const json = JSON.stringify(r.opportunities);
    for (const tag of ['<html', '<body', '<div', '<script', '<p>', '<h1']) expect(json).not.toContain(tag);
  });

  it('41 a healthy state is never converted into an adverse opportunity', () => {
    const input = baseInput({
      pageObservations: baseInput().scanUrls.map(r => ({
        ...erObservation(r.urlNormalized!, []),
        engine: 'structured_data', engineVersion: '2026-08',
        observation: { hasSchema: true, hasMalformed: false, blockCount: 1, types: ['Organization'] },
      })),
    });
    const r = qualify(input);
    const o = r.opportunities.find(x => x.condition === 'structured_data_present')!;
    expect(o.polarity).toBe('healthy');
    expect(o.status).toBe('NOT_QUALIFIED');
    expect(o.technicalPriority).toBe('T_NONE');
  });

  it('42 an evidence change invalidates a fingerprint-bound approval', () => {
    const key = opportunityKeyOf('d', 's', 'analyzed_sample', 'c');
    const refs = cluster().evidenceRefs;
    const f1 = evidenceFingerprintOf('s1', 'v1', 6, 10, refs);
    const f2 = evidenceFingerprintOf('s1', 'v1', 7, 10, refs);
    const f3 = evidenceFingerprintOf('s2', 'v1', 6, 10, refs);
    expect(opportunityKeyOf('d', 's', 'analyzed_sample', 'c')).toBe(key);
    expect(f2).not.toBe(f1);
    expect(f3).not.toBe(f1);
  });

  it('43 site scope is unreachable while the site total is unknown', () => {
    const g = evaluateGates(cluster({ scopeLevel: 'site' }), ctx);
    expect(g.results.find(x => x.gate === 'G5')!.passed).toBe(false);
    expect(g.results.find(x => x.gate === 'G5')!.reason).toContain('site total is unknown');
  });

  it('44 a substituted denominator is rejected', () => {
    // analyzed_sample must carry the analyzed population, not the discovered one.
    const g = evaluateGates(cluster({ denominator: COVERAGE.discovered }), ctx);
    expect(g.results.find(x => x.gate === 'G5')!.passed).toBe(false);
    expect(g.results.find(x => x.gate === 'G5')!.reason).toContain('does not match');
  });

  it('45 a cluster may not span two scans', () => {
    const s = deriveSignals(baseInput());
    const foreign: Signal = {
      ...s[0],
      evidenceRefs: s[0].evidenceRefs.map(r => ({ ...r, scanId: 'OTHER_SCAN' })),
    };
    expect(() => buildClusters([...s, foreign])).toThrow(CrossScanClusterError);
  });

  it('46 coverage is never omitted from an externally presentable count', () => {
    const r = qualify(MICHAEL);
    for (const o of r.opportunities) {
      for (const c of o.allowedClaims.filter(x => x.externallyPresentable && /\d/.test(x.text))) {
        expect(c.text).toMatch(new RegExp(String(o.denominator)));
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════
describe('self-review attacks discovered during implementation', () => {
  it('47 a NOT_QUALIFIED candidate has nothing externally presentable', () => {
    const r = qualify(MICHAEL);
    const rejected = r.opportunities.filter(o => o.status === 'NOT_QUALIFIED');
    expect(rejected.length).toBeGreaterThan(0);
    for (const o of rejected) {
      for (const c of o.allowedClaims) expect(c.externallyPresentable, o.subject).toBe(false);
      expect(o.outreachSuitability).toBe('NOT_ELIGIBLE');
    }
  });

  it('48 no detector can emit site scope', () => {
    for (const input of [MICHAEL, baseInput(), brokenTargetInput()]) {
      for (const s of deriveSignals(input)) expect(s.scopeLevel).not.toBe('site');
    }
  });

  it('49 a cluster never mixes two engines', () => {
    for (const c of buildClusters(deriveSignals(MICHAEL))) {
      const engines = new Set(c.evidenceRefs.map(r => r.engine).filter(Boolean));
      expect(engines.size, c.subject).toBeLessThanOrEqual(1);
    }
  });

  it('50 a signal carries no severity, priority or outreach field', () => {
    for (const s of deriveSignals(MICHAEL)) {
      const keys = Object.keys(s);
      for (const forbidden of ['technicalPriority', 'priority', 'severity', 'outreachSuitability', 'status']) {
        expect(keys, s.signalKey).not.toContain(forbidden);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════
describe('property and invariant tests', () => {
  it('qualification is deterministic', () => {
    const a = JSON.stringify(qualify(MICHAEL));
    const b = JSON.stringify(qualify(MICHAEL));
    expect(a).toBe(b);
  });

  it('input ordering does not change the result', () => {
    const shuffled: QualificationInput = {
      ...MICHAEL,
      pageObservations: [...MICHAEL.pageObservations].reverse(),
      linkTargets: [...MICHAEL.linkTargets].reverse(),
      linkRelationships: [...MICHAEL.linkRelationships].reverse(),
      scanUrls: [...MICHAEL.scanUrls].reverse(),
    };
    expect(JSON.stringify(qualify(shuffled))).toBe(JSON.stringify(qualify(MICHAEL)));
  });

  it('duplicate evidence does not inflate counts', () => {
    const doubled: QualificationInput = {
      ...MICHAEL,
      pageObservations: [...MICHAEL.pageObservations, ...MICHAEL.pageObservations],
      linkRelationships: [...MICHAEL.linkRelationships, ...MICHAEL.linkRelationships],
    };
    const a = qualify(MICHAEL);
    const b = qualify(doubled);
    for (const o of a.opportunities) {
      const match = b.opportunities.find(x => x.opportunityKey === o.opportunityKey)!;
      expect(match.numerator, o.subject).toBe(o.numerator);
      expect(match.affectedPageCount, o.subject).toBe(o.affectedPageCount);
      expect(match.sourceLinkCount, o.subject).toBe(o.sourceLinkCount);
    }
  });

  it('cluster ordering does not affect decisions', () => {
    const signals = deriveSignals(MICHAEL);
    const a = buildClusters(signals);
    const b = buildClusters([...signals].reverse());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('the same evidence yields the same opportunity key', () => {
    expect(qualify(MICHAEL).opportunities.map(o => o.opportunityKey))
      .toEqual(qualify(MICHAEL).opportunities.map(o => o.opportunityKey));
  });

  it('an unknown detector fails closed', () => {
    const g = evaluateGates(cluster({ detector: 'made_up_detector' }), ctx);
    expect(g.results.find(x => x.gate === 'G6')!.passed).toBe(false);
    expect(g.results.find(x => x.gate === 'G8')!.passed).toBe(false);
  });

  it('an unknown scope fails closed', () => {
    const g = evaluateGates(cluster({ scopeLevel: 'galaxy' as never }), ctx);
    expect(g.results.find(x => x.gate === 'G5')!.passed).toBe(false);
  });

  it('an unknown provenance class fails closed to undeterminable', () => {
    expect(weakestLink(['verified', 'nonsense' as never])).toBe('undeterminable');
    expect(canSatisfyGate('inferred')).toBe(false);
    expect(canSatisfyGate('unverified')).toBe(false);
    expect(canSatisfyGate('undeterminable')).toBe(false);
  });

  it('empty evidence cannot qualify', () => {
    const empty = qualify(baseInput({ pageObservations: [], linkTargets: [], linkRelationships: [] }));
    expect(empty.opportunities).toHaveLength(0);
    expect(empty.signals).toHaveLength(0);
  });

  it('an undeterminable-only cluster cannot qualify', () => {
    const g = evaluateGates(cluster({ determinable: false, polarity: 'indeterminate' }), ctx);
    expect(g.firstFailedGate).toBe('G3');
  });

  it('a healthy-only cluster cannot qualify as adverse', () => {
    const g = evaluateGates(cluster({ polarity: 'healthy' }), ctx);
    expect(g.results.find(x => x.gate === 'G9')!.passed).toBe(false);
    expect(g.results.find(x => x.gate === 'G12')!.passed).toBe(false);
  });

  it('every gate is evaluated and reported for every cluster', () => {
    for (const o of qualify(MICHAEL).opportunities) {
      expect(o.gateResults.map(g => g.gate))
        .toEqual(['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10', 'G11', 'G12']);
      for (const g of o.gateResults) expect(g.reason.length).toBeGreaterThan(0);
    }
  });

  it('QUALIFIED iff no gate failed', () => {
    for (const o of qualify(MICHAEL).opportunities) {
      expect(o.status === 'QUALIFIED').toBe(o.gateResults.every(g => g.passed));
    }
  });
});
