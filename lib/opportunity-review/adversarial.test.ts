// Opportunity Review v0.1 — the 58 frozen adversarial cases plus
// implementation-level cases and positive controls. Each test names its attack.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { qualify } from '../opportunity-qualification/qualify';
import type { QualificationInput } from '../opportunity-qualification/types';
import {
  buildCanonicalClaim,
  canonicalJson,
  claimHashOf,
  claimTypeOf,
  evidenceRefsHashOf,
  normalizeRefs,
  populationsOf,
  proseHashOf,
  subjectMentionOf,
} from './canonical-claim';
import { validateClaimSubmission, type ClaimBaseline } from './claim-validator';
import { demonstrabilityOf, meetsScoutEvidenceRequirements, presentationModeOf, reproductionMethodOf } from './demonstrability';
import { reviewEligibilityOf, uncertaintiesOf } from './eligibility';
import { FORBIDDEN_REVIEWER_IDENTITIES, IMMUTABLE_CLAIM_FIELDS, UNREPRESENTABLE_STATES } from './future-contract';
import { carriesRequiredContext, isExternallyPresentable, presentationPermissionOf } from './permissions';
import { deriveReview, type QualificationOpportunityView, type QualificationResultView } from './review-packet';
import type { CanonicalClaim, ClaimSubmission, EvidenceRefView, ReviewPacket } from './types';
import { MAX_PROSE_CHARS } from './versions';

const input = JSON.parse(
  readFileSync(new URL('../opportunity-qualification/__fixtures__/michael-pilot.json', import.meta.url), 'utf8'),
) as QualificationInput;
const qualification = qualify(input) as unknown as QualificationResultView;
const review = deriveReview(qualification);

function packet(subject: string): ReviewPacket {
  const hit = review.packets.find(p => p.subject === subject);
  if (!hit) throw new Error(`no packet for ${subject}`);
  return hit;
}
const ABOUT = 'https://michaelhingson.com/about/';

function baselineFor(p: ReviewPacket): ClaimBaseline {
  return {
    canonicalClaim: p.canonicalClaim,
    claimHash: p.claimHash,
    presentationMode: p.presentationMode,
    demonstrabilityStatus: p.demonstration.status,
  };
}
function submissionFor(p: ReviewPacket, prose?: string): ClaimSubmission {
  const direct = p.claimCandidates.find(c => c.epistemicClass === 'DIRECT_OBSERVATION' && c.externallyPresentable)!;
  return {
    canonicalClaim: p.canonicalClaim,
    prose: prose ?? direct.prose,
    presentationMode: p.presentationMode,
    demonstrabilityStatus: p.demonstration.status,
  };
}
function mutate(c: CanonicalClaim, patch: Partial<CanonicalClaim>): CanonicalClaim {
  return { ...c, ...patch };
}

const REF: EvidenceRefView = {
  kind: 'page_observation', scanId: 's1', subjectUrl: 'https://example.org/p',
  engine: 'e', engineVersion: 'v1', contentSha256: 'a'.repeat(64), scope: 'page', observedAt: 't',
};

// ═══════════════════════════════════════════════════════════════
describe('adversarial 1-12 — evidence and scope honesty', () => {
  it('1 healthy state cannot enter review', () => {
    for (const s of ['structured_data', 'band:mostly_resilient', 'band:resilient']) {
      expect(review.packets.find(p => p.subject === s), s).toBeUndefined();
    }
    const e = reviewEligibilityOf({ qualificationStatus: 'QUALIFIED', outreachSuitability: 'NEEDS_HUMAN_REVIEW', claimPermissions: ['PRESENTABLE'], polarity: 'healthy', firstFailedGate: null });
    expect(e.entry).toBe('NOT_ELIGIBLE_FOR_REVIEW');
  });

  it('2 undeterminable cannot become an adverse claim', () => {
    expect(review.packets.find(p => p.subject === 'entity_consistency')).toBeUndefined();
    const e = reviewEligibilityOf({ qualificationStatus: 'NOT_QUALIFIED', outreachSuitability: 'NOT_ELIGIBLE', claimPermissions: [], polarity: 'indeterminate', firstFailedGate: 'G3' });
    expect(e.entry).toBe('NOT_ELIGIBLE_FOR_REVIEW');
  });

  it('3 unknown site total cannot become a whole-site claim', () => {
    const p = packet(ABOUT);
    const r = validateClaimSubmission(
      submissionFor(p, 'Links across the website reached https://michaelhingson.com/about/ on 25 of the 25 analyzed pages; 1 of 40 checked destinations returned HTTP 404.'),
      baselineFor(p));
    expect(r.valid).toBe(false);
    expect(r.failures.map(f => f.code)).toContain('forbidden_scope_word');
  });

  it('4 25 analyzed pages cannot become the website denominator', () => {
    const p = packet('band:fragile');
    expect(p.populations[0].denominator).toBe(25);
    expect(p.populations[0].denominator).not.toBe(p.coverage.discovered);
    expect(p.coverage.discovered).toBe(1138);
  });

  it('5 1/40 checked targets cannot be restated as 25/25 destinations', () => {
    const p = packet(ABOUT);
    const bad = mutate(p.canonicalClaim, {
      populations: [{ label: 'checked_link_destinations', numerator: 25, denominator: 25 }],
    });
    const r = validateClaimSubmission({ ...submissionFor(p), canonicalClaim: bad }, baselineFor(p));
    expect(r.valid).toBe(false);
    expect(r.failures.map(f => f.code)).toContain('claim_hash_mismatch');
  });

  it('6 source pages and checked destinations remain distinct populations', () => {
    const p = packet(ABOUT);
    const labels = p.populations.map(x => x.label).sort();
    expect(labels).toEqual(['analyzed_pages', 'checked_link_destinations']);
    const dens = new Set(p.populations.map(x => x.denominator));
    expect(dens).toEqual(new Set([25, 40]));
  });

  it('7 inferred evidence cannot become a direct observation', () => {
    const p = packet('band:fragile');
    const bad = mutate(p.canonicalClaim, { epistemicClass: 'DIRECT_OBSERVATION' });
    // fragile's primary IS direct observation, so flip a hypothesis instead
    const hyp = p.claimCandidates.find(c => c.epistemicClass === 'HYPOTHESIS')!;
    expect(hyp.presentationPermission).toBe('INTERNAL_ONLY');
    expect(isExternallyPresentable(hyp.presentationPermission)).toBe(false);
    expect(bad.epistemicClass).toBe('DIRECT_OBSERVATION'); // constructed, but…
    const r = validateClaimSubmission(
      { ...submissionFor(p), canonicalClaim: mutate(p.canonicalClaim, { epistemicClass: 'BOUNDED_INTERPRETATION' }) },
      baselineFor(p));
    expect(r.valid).toBe(false);
    expect(r.failures.map(f => f.code)).toContain('epistemic_class_changed');
  });

  it('8 a changed evidence fingerprint changes what the packet is bound to', () => {
    const p = packet(ABOUT);
    expect(p.evidenceFingerprint).toBeTruthy();
    const other = packet('https://michaelhingson.com/author/');
    expect(other.evidenceFingerprint).not.toBe(p.evidenceFingerprint);
    expect(other.opportunityKey).not.toBe(p.opportunityKey);
  });

  it('9 same opportunity key does not override changed evidence', () => {
    const p = packet(ABOUT);
    const changed = mutate(p.canonicalClaim, { evidenceRefsHash: 'deadbeef'.repeat(4) });
    const r = validateClaimSubmission({ ...submissionFor(p), canonicalClaim: changed }, baselineFor(p));
    expect(r.valid).toBe(false);
    expect(r.failures.some(f => f.detail.includes('evidence references changed'))).toBe(true);
  });

  it('10/11/12 no reviewer identity of any kind appears in the derivation', () => {
    const json = JSON.stringify(review).toLowerCase();
    expect(json).not.toContain('reviewerid');
    expect(json).not.toContain('decidedat');
    for (const forbidden of FORBIDDEN_REVIEWER_IDENTITIES.filter(x => x.length > 0)) {
      expect(json).not.toContain(`"${forbidden}"`);
    }
    // a prospect/scan identifier is never repurposed as a reviewer
    expect(json).not.toContain('"reviewer"');
  });
});

describe('adversarial 13-22 — Scout, approval and aggregation', () => {
  it('13 STATEMENT_ONLY cannot meet Scout evidence requirements', () => {
    for (const p of review.packets.filter(x => x.presentationMode === 'STATEMENT_ONLY')) {
      expect(p.meetsScoutEvidenceRequirements, p.subject).toBe(false);
    }
    expect(meetsScoutEvidenceRequirements('STATEMENT_ONLY')).toBe(false);
  });

  it('14 STATEMENT_ONLY remains reviewable and is not discarded', () => {
    const only = review.packets.filter(p => p.presentationMode === 'STATEMENT_ONLY');
    expect(only).toHaveLength(3);
    for (const p of only) {
      expect(p.reviewEligibility.entry).toBe('ELIGIBLE_FOR_REVIEW');
      expect(p.claimCandidates.some(c => c.externallyPresentable)).toBe(true);
    }
  });

  it('15 STATEMENT_WITH_DEMONSTRATION does not imply approval', () => {
    for (const p of review.packets.filter(x => x.meetsScoutEvidenceRequirements)) {
      expect(p.humanApprovalState).toBe('UNREPRESENTABLE_IN_V0_1');
      expect(Object.keys(p)).not.toContain('approved');
      expect(Object.keys(p)).not.toContain('approval');
    }
  });

  it('16 packets cannot silently merge', () => {
    const keys = review.packets.map(p => p.opportunityKey);
    expect(new Set(keys).size).toBe(keys.length);
    const brokenPackets = review.packets.filter(p => p.detector === 'broken_internal_target');
    expect(brokenPackets).toHaveLength(4);
    for (const p of brokenPackets) expect(p.claimCandidates.every(c => c.canonicalClaim.subject === p.subject)).toBe(true);
  });

  it('17 no aggregate claim appears', () => {
    for (const p of review.packets) {
      for (const c of p.claimCandidates) {
        expect(c.prose).not.toMatch(/three |several |multiple |footer links are broken|links are broken/i);
      }
    }
  });

  it('18/19 no business impact or causation appears in presentable prose', () => {
    for (const p of review.packets) {
      for (const c of p.claimCandidates.filter(x => x.externallyPresentable)) {
        expect(c.prose).not.toMatch(/revenue|customer|lead|conversion|ranking|traffic|because of this|causing/i);
      }
    }
  });

  it('20 verification cannot appear', () => {
    const json = JSON.stringify(review);
    for (const s of ['VERIFIED', 'verificationState', 'measured_change', 'baselineCaptured']) {
      expect(json).not.toContain(s);
    }
  });

  it('21 CURRENT_STATE cannot become BEFORE', () => {
    for (const p of review.packets) expect(p.canonicalClaim.temporalFrame).toBe('CURRENT_STATE');
    const p = packet(ABOUT);
    const r = validateClaimSubmission(
      { ...submissionFor(p), canonicalClaim: mutate(p.canonicalClaim, { temporalFrame: 'BEFORE' as never }) },
      baselineFor(p));
    expect(r.valid).toBe(false);
    expect(r.failures.map(f => f.code)).toContain('temporal_frame_changed');
  });

  it('22 no unrepresentable state string is reachable as a value', () => {
    const json = JSON.stringify(review);
    for (const s of UNREPRESENTABLE_STATES) expect(json).not.toContain(s);
  });
});

describe('adversarial 23-34 — claim hash sensitivity', () => {
  const p = () => packet(ABOUT);

  it('23 numerator change changes the hash', () => {
    const c = p().canonicalClaim;
    const changed = mutate(c, { populations: c.populations.map(x => x.label === 'analyzed_pages' ? { ...x, numerator: 24 } : x) });
    expect(claimHashOf(changed)).not.toBe(claimHashOf(c));
  });

  it('24 denominator change changes the hash', () => {
    const c = p().canonicalClaim;
    const changed = mutate(c, { populations: c.populations.map(x => x.label === 'analyzed_pages' ? { ...x, denominator: 1138 } : x) });
    expect(claimHashOf(changed)).not.toBe(claimHashOf(c));
  });

  it('25 scope change changes the hash', () => {
    const c = p().canonicalClaim;
    expect(claimHashOf(mutate(c, { scopeLevel: 'site' }))).not.toBe(claimHashOf(c));
  });

  it('26 subject change changes the hash', () => {
    const c = p().canonicalClaim;
    expect(claimHashOf(mutate(c, { subject: 'https://michaelhingson.com/other/' }))).not.toBe(claimHashOf(c));
  });

  it('27 metric change changes the hash', () => {
    const c = p().canonicalClaim;
    expect(claimHashOf(mutate(c, { metric: 'check_status' }))).not.toBe(claimHashOf(c));
  });

  it('28 observed value change changes the hash', () => {
    const c = p().canonicalClaim;
    expect(claimHashOf(mutate(c, { observedValue: '200' }))).not.toBe(claimHashOf(c));
  });

  it('29 population label change changes the hash', () => {
    const c = p().canonicalClaim;
    const changed = mutate(c, { populations: c.populations.map(x => x.label === 'analyzed_pages' ? { ...x, label: 'all_links' } : x) });
    expect(claimHashOf(changed)).not.toBe(claimHashOf(c));
  });

  it('30 qualifier change changes the hash', () => {
    const c = p().canonicalClaim;
    expect(claimHashOf(mutate(c, { qualifiers: ['requires_context'] }))).not.toBe(claimHashOf(c));
  });

  it('31 evidence reference change changes the hash', () => {
    const c = p().canonicalClaim;
    expect(claimHashOf(mutate(c, { evidenceRefsHash: '0'.repeat(32) }))).not.toBe(claimHashOf(c));
  });

  it('32 detector version change changes the hash', () => {
    const c = p().canonicalClaim;
    expect(claimHashOf(mutate(c, { detectorVersion: 'det-broken-target-9.9' }))).not.toBe(claimHashOf(c));
  });

  it('33 epistemic class and permission changes change the hash', () => {
    const c = p().canonicalClaim;
    expect(claimHashOf(mutate(c, { epistemicClass: 'HYPOTHESIS' }))).not.toBe(claimHashOf(c));
    expect(claimHashOf(mutate(c, { presentationPermission: 'INTERNAL_ONLY' }))).not.toBe(claimHashOf(c));
  });

  it('34 punctuation-only prose change does NOT change the hash', () => {
    const pk = p();
    const direct = pk.claimCandidates.find(c => c.epistemicClass === 'DIRECT_OBSERVATION')!;
    const restyled = direct.prose.replace(/\. /g, '; ').replace(/;$/, '.');
    expect(proseHashOf(restyled)).not.toBe(direct.proseHash);
    // identity is structural, so the claim hash is untouched
    expect(claimHashOf(pk.canonicalClaim)).toBe(pk.claimHash);
  });
});

describe('adversarial 35-46 — prose surface and validator', () => {
  const p = () => packet(ABOUT);

  it('35 qualifier removal fails validation', () => {
    const pk = p();
    const withQual: ClaimBaseline = {
      ...baselineFor(pk),
      canonicalClaim: mutate(pk.canonicalClaim, { qualifiers: ['requires_context'] }),
    };
    withQual.claimHash = claimHashOf(withQual.canonicalClaim);
    const r = validateClaimSubmission(submissionFor(pk), withQual);
    expect(r.valid).toBe(false);
    expect(r.failures.map(f => f.code)).toContain('claim_hash_mismatch');
  });

  it('36 "analyzed" cannot become "website"', () => {
    const pk = p();
    const r = validateClaimSubmission(
      submissionFor(pk, `Links to ${ABOUT} appear on 25 of the 25 website pages; 1 of the 40 checked link destinations returned HTTP 404.`),
      baselineFor(pk));
    expect(r.valid).toBe(false);
    expect(r.failures.map(f => f.code)).toContain('forbidden_scope_word');
  });

  it('37 "checked destinations" cannot be dropped to "links"', () => {
    const pk = p();
    const r = validateClaimSubmission(
      submissionFor(pk, `Links to ${ABOUT} appear on 25 of the 25 analyzed pages; 1 of the 40 links returned HTTP 404.`),
      baselineFor(pk));
    expect(r.valid).toBe(false);
    expect(r.failures.map(f => f.code)).toContain('scope_word_missing_from_prose');
  });

  it('38 raw HTML / markup injection is rejected', () => {
    const pk = p();
    for (const bad of [`<b>${ABOUT}</b> 25 of the 25 analyzed pages, 1 of 40 checked, HTTP 404`, `<script>x</script> ${ABOUT} 25 25 analyzed 40 checked 404`]) {
      const r = validateClaimSubmission(submissionFor(pk, bad), baselineFor(pk));
      expect(r.valid).toBe(false);
      expect(r.failures.map(f => f.code)).toContain('markup_present');
    }
  });

  it('39 control characters are rejected', () => {
    const pk = p();
    const direct = pk.claimCandidates.find(c => c.epistemicClass === 'DIRECT_OBSERVATION')!;
    const r = validateClaimSubmission(submissionFor(pk, `${direct.prose}`), baselineFor(pk));
    expect(r.valid).toBe(false);
    expect(r.failures.map(f => f.code)).toContain('control_characters_present');
  });

  it('40 oversized prose is rejected', () => {
    const pk = p();
    const direct = pk.claimCandidates.find(c => c.epistemicClass === 'DIRECT_OBSERVATION')!;
    const r = validateClaimSubmission(submissionFor(pk, direct.prose + ' x'.repeat(MAX_PROSE_CHARS)), baselineFor(pk));
    expect(r.valid).toBe(false);
    expect(r.failures.map(f => f.code)).toContain('prose_too_long');
  });

  it('41 a bare percentage is rejected', () => {
    const pk = packet('band:fragile');
    const r = validateClaimSubmission(
      submissionFor(pk, 'On 80% of pages the band was fragile.'),
      baselineFor(pk));
    expect(r.valid).toBe(false);
    expect(r.failures.map(f => f.code)).toContain('bare_magnitude');
  });

  it('42 business-impact lexicon is rejected', () => {
    const pk = p();
    const direct = pk.claimCandidates.find(c => c.epistemicClass === 'DIRECT_OBSERVATION')!;
    const r = validateClaimSubmission(submissionFor(pk, `${direct.prose} This is costing you customers.`), baselineFor(pk));
    expect(r.valid).toBe(false);
    expect(r.failures.map(f => f.code)).toContain('prohibited_lexicon');
  });

  it('43 an unlicensed number cannot be introduced', () => {
    const pk = p();
    const direct = pk.claimCandidates.find(c => c.epistemicClass === 'DIRECT_OBSERVATION')!;
    const r = validateClaimSubmission(submissionFor(pk, `${direct.prose.replace('HTTP 404', 'HTTP 404 across 1138 pages')}`), baselineFor(pk));
    expect(r.valid).toBe(false);
    expect(r.failures.map(f => f.code)).toContain('unexpected_number_in_prose');
  });

  it('44 dropping the subject is rejected', () => {
    const pk = p();
    const r = validateClaimSubmission(
      submissionFor(pk, 'That destination appeared on 25 of the 25 analyzed pages and was 1 of the 40 checked link destinations, returning HTTP 404.'),
      baselineFor(pk));
    expect(r.valid).toBe(false);
    expect(r.failures.map(f => f.code)).toContain('subject_missing_from_prose');
  });

  it('45 a reviewer-edited denominator cannot validate', () => {
    const pk = p();
    const edited = mutate(pk.canonicalClaim, {
      populations: pk.canonicalClaim.populations.map(x => x.label === 'checked_link_destinations' ? { ...x, denominator: 305 } : x),
    });
    const r = validateClaimSubmission({ ...submissionFor(pk), canonicalClaim: edited }, baselineFor(pk));
    expect(r.valid).toBe(false);
    expect(r.failures.some(f => f.detail.includes('denominator'))).toBe(true);
  });

  it('46 a reviewer-edited scope cannot validate', () => {
    const pk = p();
    const r = validateClaimSubmission(
      { ...submissionFor(pk), canonicalClaim: mutate(pk.canonicalClaim, { scopeLevel: 'discovered' }) },
      baselineFor(pk));
    expect(r.valid).toBe(false);
  });
});

describe('adversarial 47-58 — modes, entry and determinism', () => {
  it('47 NOT_DEMONSTRABLE cannot become STATEMENT_WITH_DEMONSTRATION', () => {
    expect(presentationModeOf('NOT_DEMONSTRABLE')).toBe('STATEMENT_ONLY');
    expect(presentationModeOf('LIMITED_DEMONSTRABILITY')).toBe('STATEMENT_ONLY');
    const pk = packet('fact_attribution');
    const r = validateClaimSubmission(
      { ...submissionFor(pk), presentationMode: 'STATEMENT_WITH_DEMONSTRATION' },
      baselineFor(pk));
    expect(r.valid).toBe(false);
    expect(r.failures.map(f => f.code)).toContain('presentation_mode_changed');
  });

  it('48 demonstrability cannot be upgraded in a submission', () => {
    const pk = packet('fact_attribution');
    const r = validateClaimSubmission({ ...submissionFor(pk), demonstrabilityStatus: 'DEMONSTRABLE' }, baselineFor(pk));
    expect(r.valid).toBe(false);
    expect(r.failures.map(f => f.code)).toContain('demonstrability_changed');
  });

  it('49 an adverse engine verdict is not demonstrable merely for being adverse', () => {
    const d = demonstrabilityOf({
      detector: 'extraction_band', presentationEvidenceAvailable: true,
      presentationEvidenceReason: 'anything', evidenceRefs: [REF],
    });
    expect(d.status).toBe('NOT_DEMONSTRABLE');
    expect(reproductionMethodOf('extraction_band')).toBe('none_available');
  });

  it('50 qualification is authoritative when it says no showable instance exists', () => {
    const d = demonstrabilityOf({
      detector: 'broken_internal_target', presentationEvidenceAvailable: false,
      presentationEvidenceReason: 'none retained', evidenceRefs: [REF],
    });
    expect(d.status).toBe('NOT_DEMONSTRABLE');
    expect(d.showableRefs).toHaveLength(0);
  });

  it('51 NOT_ELIGIBLE opportunity cannot enter review', () => {
    const e = reviewEligibilityOf({ qualificationStatus: 'QUALIFIED', outreachSuitability: 'NOT_ELIGIBLE', claimPermissions: ['PRESENTABLE'], polarity: 'adverse', firstFailedGate: null });
    expect(e.entry).toBe('NOT_ELIGIBLE_FOR_REVIEW');
  });

  it('52 NEEDS_HUMAN_REVIEW is not an approval', () => {
    const needs = review.packets.filter(p => p.outreachSuitability === 'NEEDS_HUMAN_REVIEW');
    expect(needs.length).toBeGreaterThan(0);
    for (const p of needs) expect(p.humanApprovalState).toBe('UNREPRESENTABLE_IN_V0_1');
  });

  it('53 an unknown epistemic class fails closed to NOT_PRESENTABLE', () => {
    const perm = presentationPermissionOf({
      epistemicClass: 'SOMETHING_NEW' as never, qualificationStatus: 'QUALIFIED',
      outreachSuitability: 'NEEDS_HUMAN_REVIEW', carriesRequiredContext: false,
    });
    expect(perm).toBe('NOT_PRESENTABLE');
  });

  it('54 an unknown detector yields no canonical claim', () => {
    expect(claimTypeOf('made_up_detector')).toBeNull();
    const c = buildCanonicalClaim(
      { detector: 'made_up_detector', detectorVersion: 'v', subject: 's', condition: 'c', scopeLevel: 'analyzed_sample', numerator: 1, denominator: 2, sourceLinkCount: 0, facts: {}, evidenceRefs: [] },
      { analysisComplete: 25, targetsChecked: 40 }, 'DIRECT_OBSERVATION', 'PRESENTABLE', []);
    expect(c).toBeNull();
  });

  it('55 array-order determinism: reordering opportunities changes nothing', () => {
    const reversed: QualificationResultView = {
      ...qualification,
      opportunities: [...qualification.opportunities].reverse() as QualificationOpportunityView[],
    };
    expect(JSON.stringify(deriveReview(reversed))).toBe(JSON.stringify(review));
  });

  it('56 duplicate evidence refs are deterministic and do not inflate', () => {
    const once = evidenceRefsHashOf([REF]);
    const twice = evidenceRefsHashOf([REF, { ...REF }]);
    expect(twice).toBe(once);
    expect(normalizeRefs([REF, { ...REF }])).toHaveLength(1);
  });

  it('57 reordered evidence refs produce the same hash', () => {
    const a: EvidenceRefView = { ...REF, subjectUrl: 'https://example.org/a' };
    const b: EvidenceRefView = { ...REF, subjectUrl: 'https://example.org/b' };
    expect(evidenceRefsHashOf([a, b])).toBe(evidenceRefsHashOf([b, a]));
    const c = packet(ABOUT).canonicalClaim;
    expect(canonicalJson({ ...c, populations: [...c.populations].reverse() })).toBe(canonicalJson(c));
  });

  it('58 the derivation performs ZERO network requests (causally proven)', () => {
    const spy = vi.fn(() => { throw new Error('review layer attempted a network request'); });
    const original = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    let r;
    try {
      r = deriveReview(qualification);
    } finally {
      globalThis.fetch = original;
    }
    expect(spy).not.toHaveBeenCalled();
    expect(r!.networkRequestsMade).toBe(0);
    expect(r!.persistedRecords).toBe(0);
  });
});

describe('implementation-level cases', () => {
  it('the immutable field list matches what the validator actually enforces', () => {
    expect(IMMUTABLE_CLAIM_FIELDS).toContain('populations');
    expect(IMMUTABLE_CLAIM_FIELDS).toContain('temporalFrame');
    expect(IMMUTABLE_CLAIM_FIELDS).toContain('evidenceRefsHash');
    const pk = packet(ABOUT);
    for (const f of ['subject', 'scopeLevel', 'condition', 'metric', 'observedValue', 'detectorVersion']) {
      const r = validateClaimSubmission(
        { ...submissionFor(pk), canonicalClaim: mutate(pk.canonicalClaim, { [f]: 'MUTATED' } as never) },
        baselineFor(pk));
      expect(r.valid, f).toBe(false);
    }
  });

  it('populationsOf never fabricates a population it has no denominator for', () => {
    const pops = populationsOf(
      { detector: 'page_check_failure', detectorVersion: 'v', subject: 's', condition: 'c', scopeLevel: 'analyzed_sample', numerator: null, denominator: null, sourceLinkCount: 0, facts: {}, evidenceRefs: [] },
      { analysisComplete: 25, targetsChecked: 40 });
    expect(pops).toHaveLength(0);
  });

  it('required-context detection is bounded to the documented marker', () => {
    expect(carriesRequiredContext('plain text')).toBe(false);
    expect(carriesRequiredContext('x. For completeness: y.')).toBe(true);
    expect(presentationPermissionOf({
      epistemicClass: 'DIRECT_OBSERVATION', qualificationStatus: 'QUALIFIED',
      outreachSuitability: 'NEEDS_HUMAN_REVIEW', carriesRequiredContext: true,
    })).toBe('PRESENTABLE_WITH_QUALIFIER');
  });

  it('uncertainties come from the frozen enumeration and are sorted', () => {
    const u = uncertaintiesOf({
      siteTotalKnown: false, scopeLevel: 'analyzed_sample', presentationEvidenceAvailable: false,
      requiresAdditionalContext: true, undeterminableCountPresent: true,
      remediationClass: 'content_entity_clarification', populationCount: 2,
    });
    expect(u).toEqual([...u].sort());
    expect(new Set(u).size).toBe(u.length);
    expect(u).toContain('site_total_unknown');
    expect(u).toContain('denominators_differ_across_claim');
  });

  it('a non-presentable permission cannot pass validation even with perfect prose', () => {
    const pk = packet('band:fragile');
    const hidden: ClaimBaseline = {
      ...baselineFor(pk),
      canonicalClaim: mutate(pk.canonicalClaim, { presentationPermission: 'INTERNAL_ONLY' }),
    };
    hidden.claimHash = claimHashOf(hidden.canonicalClaim);
    const r = validateClaimSubmission(
      { ...submissionFor(pk), canonicalClaim: hidden.canonicalClaim }, hidden);
    expect(r.valid).toBe(false);
    expect(r.failures.map(f => f.code)).toContain('not_externally_presentable');
  });
});

describe('subject mention and date licensing', () => {
  it('a URL subject must appear verbatim; a namespaced identifier by its meaningful part', () => {
    expect(subjectMentionOf('https://michaelhingson.com/about/')).toBe('https://michaelhingson.com/about/');
    expect(subjectMentionOf('band:fragile')).toBe('fragile');
    expect(subjectMentionOf('fact_attribution')).toBe('fact_attribution');
  });

  it('the observation date is part of claim identity and cannot be changed', () => {
    const p = packet(ABOUT);
    expect(p.canonicalClaim.observedAt).toBe('2026-09-30');
    const changed = mutate(p.canonicalClaim, { observedAt: '2026-01-01' });
    expect(claimHashOf(changed)).not.toBe(claimHashOf(p.canonicalClaim));
    const r = validateClaimSubmission({ ...submissionFor(p), canonicalClaim: changed }, baselineFor(p));
    expect(r.valid).toBe(false);
  });

  it('a date other than the observation date cannot be stated in prose', () => {
    const p = packet(ABOUT);
    const direct = p.claimCandidates.find(c => c.epistemicClass === 'DIRECT_OBSERVATION')!;
    const r = validateClaimSubmission(
      submissionFor(p, direct.prose.replace('2026-09-30', '2026-01-01')), baselineFor(p));
    expect(r.valid).toBe(false);
    expect(r.failures.some(f => f.detail.includes('is not the observation date'))).toBe(true);
  });

  it('observedAt is taken from the evidence, not a wall clock', () => {
    // Proven by provenance, not by "not today": the fixture's own evidence date
    // happens to be today, so a not-today assertion would prove nothing.
    for (const p of review.packets) {
      expect(p.canonicalClaim.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const evidenceDates = new Set(
        p.evidenceRefs.map(r => (r.observedAt ?? '').slice(0, 10)).filter(Boolean));
      expect(evidenceDates, p.subject).toContain(p.canonicalClaim.observedAt);
    }
    // Shifting the evidence date shifts the claim's date deterministically.
    const shifted: QualificationResultView = {
      ...qualification,
      opportunities: qualification.opportunities.map(o => ({
        ...o,
        facts: { ...o.facts, checkedAt: '2019-03-04T00:00:00.000Z' },
        evidenceRefs: o.evidenceRefs.map(r => ({ ...r, observedAt: '2019-03-04T00:00:00.000Z' })),
      })) as QualificationOpportunityView[],
    };
    for (const p of deriveReview(shifted).packets) {
      expect(p.canonicalClaim.observedAt).toBe('2019-03-04');
    }
  });
});

describe('POSITIVE CONTROLS — the system is not merely rejecting everything', () => {
  it('a broken destination yields a packet', () => {
    expect(packet(ABOUT)).toBeTruthy();
  });

  it('a broken destination is STATEMENT_WITH_DEMONSTRATION', () => {
    expect(packet(ABOUT).presentationMode).toBe('STATEMENT_WITH_DEMONSTRATION');
  });

  it('a broken destination meets Scout evidence requirements', () => {
    expect(packet(ABOUT).meetsScoutEvidenceRequirements).toBe(true);
  });

  it('fragile extraction yields a packet at STATEMENT_ONLY not meeting Scout requirements', () => {
    const p = packet('band:fragile');
    expect(p.presentationMode).toBe('STATEMENT_ONLY');
    expect(p.meetsScoutEvidenceRequirements).toBe(false);
    expect(p.reviewEligibility.entry).toBe('ELIGIBLE_FOR_REVIEW');
  });

  it('THE VALIDATOR ACCEPTS the unmodified approved claim', () => {
    for (const p of review.packets) {
      const r = validateClaimSubmission(submissionFor(p), baselineFor(p));
      expect(r.valid, `${p.subject}: ${JSON.stringify(r.failures)}`).toBe(true);
      expect(r.failures).toHaveLength(0);
    }
  });

  it('a harmless stylistic edit that preserves every required element still validates', () => {
    const p = packet(ABOUT);
    const direct = p.claimCandidates.find(c => c.epistemicClass === 'DIRECT_OBSERVATION')!;
    const restyled = direct.prose.replace('Prequire found links to', 'Prequire located links to');
    const r = validateClaimSubmission(submissionFor(p, restyled), baselineFor(p));
    expect(r.valid, JSON.stringify(r.failures)).toBe(true);
  });

  it('reordered evidence refs produce a deterministic, identical derivation', () => {
    const reordered: QualificationResultView = {
      ...qualification,
      opportunities: qualification.opportunities.map(o => ({ ...o, evidenceRefs: [...o.evidenceRefs].reverse() })),
    };
    expect(JSON.stringify(deriveReview(reordered))).toBe(JSON.stringify(review));
  });
});
