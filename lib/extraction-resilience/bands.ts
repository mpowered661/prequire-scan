import type { ResilienceBand, ResilienceMeasure, ResilienceMeasures } from './types';

// Deterministic, ordered band rules.
//
// Two properties matter here. First, important contradictions and heavy
// qualifier loss short-circuit to `fragile` rather than being averaged against
// measures that happen to look good. Second, thin coverage can never produce a
// strong band — a page we could barely assess is reported as
// `insufficient_evidence`, not as a pass.

// Below this many total observations there is not enough to characterise a page.
const MIN_TOTAL_ASSESSED = 4;

// The strongest band is a positive claim, so it needs a real evidence base.
// Between these two thresholds a page can still be reported as mostly
// resilient — what we did observe survived — but "resilient" is withheld.
// Without this, a thin page with three surviving relationships and one labeled
// value would carry the same verdict as a page with forty.
const MIN_ASSESSED_FOR_RESILIENT = 8;

const SHORT_CIRCUIT_RATIO = 0.5;
const RESILIENT_RATIO = 0.9;
const MOSTLY_RESILIENT_RATIO = 0.7;

// Stable identifier for the ordered rule that decided the band. Tests and the
// UI assert on this rather than on prose, so a reworded reason cannot silently
// change which rule is understood to have fired.
export type BandRule =
  | 'coverage_below_minimum'
  | 'no_readable_facts_with_undeterminable_visuals'
  | 'important_contradiction'
  | 'qualifier_below_threshold'
  | 'factual_below_threshold'
  | 'structural_below_threshold'
  | 'all_measures_strong_but_thin_evidence'
  | 'all_measures_strong'
  | 'all_measures_adequate'
  | 'weakest_measure_below_adequate';

export interface BandVerdict {
  band: ResilienceBand;
  rule: BandRule;
  reason: string;
}

function assessedRatios(m: ResilienceMeasures): { key: string; measure: ResilienceMeasure }[] {
  return (
    [
      ['structure', m.structural_resilience],
      ['labels', m.factual_resilience],
      ['qualifiers', m.qualifier_resilience],
    ] as const
  )
    .filter(([, measure]) => measure.ratio !== null)
    .map(([key, measure]) => ({ key, measure }));
}

function pct(measure: ResilienceMeasure): string {
  return `${measure.preserved}/${measure.assessed}`;
}

export function computeBand(m: ResilienceMeasures): BandVerdict {
  const totalAssessed =
    m.structural_resilience.assessed +
    m.factual_resilience.assessed +
    m.qualifier_resilience.assessed;

  // 1. Coverage gate — before anything else.
  if (totalAssessed < MIN_TOTAL_ASSESSED) {
    return {
      band: 'insufficient_evidence',
      rule: 'coverage_below_minimum',
      reason:
        `Only ${totalAssessed} extractable relationship(s) were found on this page, ` +
        'which is not enough to judge whether meaning survives extraction.',
    };
  }

  if (m.factual_resilience.assessed === 0 && m.factual_resilience.undeterminable > 0) {
    return {
      band: 'insufficient_evidence',
      rule: 'no_readable_facts_with_undeterminable_visuals',
      reason:
        `No factual values were readable from the page text, and ${m.factual_resilience.undeterminable} ` +
        'image or canvas element(s) may carry facts that cannot be assessed without vision. ' +
        'The result is undeterminable rather than a pass.',
    };
  }

  // 2. Important contradictions short-circuit.
  const important = m.contradictions.filter((c) => c.important);
  if (important.length > 0) {
    return {
      band: 'fragile',
      rule: 'important_contradiction',
      reason:
        `${important.length} important contradiction(s) between what the page states and what its ` +
        `structured data declares. ${important[0].detail}`,
    };
  }

  // 3. Heavy loss in any single dimension short-circuits.
  if (
    m.qualifier_resilience.ratio !== null &&
    m.qualifier_resilience.ratio < SHORT_CIRCUIT_RATIO
  ) {
    return {
      band: 'fragile',
      rule: 'qualifier_below_threshold',
      reason:
        `Only ${pct(m.qualifier_resilience)} claim qualifiers (hedging language, disclaimers, ` +
        'restrictions, footnotes) stay attached to their values under lossy extraction, so a ' +
        'conditional claim can be repeated as an unconditional one.',
    };
  }

  if (m.factual_resilience.ratio !== null && m.factual_resilience.ratio < SHORT_CIRCUIT_RATIO) {
    return {
      band: 'fragile',
      rule: 'factual_below_threshold',
      reason:
        `Only ${pct(m.factual_resilience)} facts survive with their label and every dimension that ` +
        'identifies them, so most values on this page cannot be reliably attributed after extraction.',
    };
  }

  if (
    m.structural_resilience.ratio !== null &&
    m.structural_resilience.ratio < SHORT_CIRCUIT_RATIO
  ) {
    return {
      band: 'fragile',
      rule: 'structural_below_threshold',
      reason: `Only ${pct(m.structural_resilience)} structural relationships survive extraction.`,
    };
  }

  // 4. Ordered thresholds across every measure that was assessable.
  const ratios = assessedRatios(m);
  if (ratios.length === 0) {
    return {
      band: 'insufficient_evidence',
      rule: 'coverage_below_minimum',
      reason: 'Nothing on this page could be assessed for extraction resilience.',
    };
  }
  const weakest = ratios.reduce(
    (worst, cur) => (cur.measure.ratio! < worst.measure.ratio! ? cur : worst),
    ratios[0],
  );

  if (ratios.every((r) => r.measure.ratio! >= RESILIENT_RATIO) && m.contradiction_count === 0) {
    if (totalAssessed < MIN_ASSESSED_FOR_RESILIENT) {
      return {
        band: 'mostly_resilient',
        rule: 'all_measures_strong_but_thin_evidence',
        reason:
          `Everything we could check survived extraction, but this page only offered ${totalAssessed} ` +
          'relationships to check — too thin a base to call it resilient outright.',
      };
    }
    return {
      band: 'resilient',
      rule: 'all_measures_strong',
      reason: 'Labels, dimensions, and structural relationships survive lossy extraction intact.',
    };
  }

  if (ratios.every((r) => r.measure.ratio! >= MOSTLY_RESILIENT_RATIO)) {
    return {
      band: 'mostly_resilient',
      rule: 'all_measures_adequate',
      reason:
        `Most meaning survives extraction; the weakest dimension is ${weakest.key} at ` +
        `${pct(weakest.measure)}.`,
    };
  }

  return {
    band: 'fragile',
    rule: 'weakest_measure_below_adequate',
    reason: `Meaning is lost under extraction; the weakest dimension is ${weakest.key} at ${pct(weakest.measure)}.`,
  };
}
