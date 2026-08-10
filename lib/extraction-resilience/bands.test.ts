import { describe, it, expect } from 'vitest';
import { computeBand } from './bands';
import type { ResilienceMeasure, ResilienceMeasures, Contradiction } from './types';

function m(preserved: number, assessed: number, undeterminable = 0): ResilienceMeasure {
  return {
    preserved,
    assessed,
    undeterminable,
    notApplicable: assessed === 0,
    ratio: assessed === 0 ? null : preserved / assessed,
    lost: [],
  };
}

function measures(over: Partial<ResilienceMeasures> = {}): ResilienceMeasures {
  const base: ResilienceMeasures = {
    structural_resilience: m(10, 10),
    factual_resilience: m(10, 10),
    qualifier_resilience: m(10, 10),
    contradiction_count: 0,
    contradictions: [],
    delta: {
      aTextLength: 1000,
      bTextLength: 900,
      bindingLossRatio: 0,
      structuralRelationsLost: 0,
      structuralRelationsTotal: 10,
    },
  };
  return { ...base, ...over };
}

const importantContradiction: Contradiction = {
  kind: 'schema_body_value',
  detail: 'x',
  left: 'a',
  right: 'b',
  important: true,
};

const minorContradiction: Contradiction = {
  kind: 'duplicate_label_conflict',
  detail: 'x',
  left: 'a',
  right: 'b',
  important: false,
};

describe('computeBand — coverage gate runs first', () => {
  it('returns insufficient_evidence when almost nothing was assessable', () => {
    const { band } = computeBand(
      measures({
        structural_resilience: m(0, 0),
        factual_resilience: m(0, 0),
        qualifier_resilience: m(0, 0),
      }),
    );

    expect(band).toBe('insufficient_evidence');
  });

  it('reports the rule that decided the band, not just the band', () => {
    const { rule } = computeBand(
      measures({
        structural_resilience: m(0, 0),
        factual_resilience: m(0, 0),
        qualifier_resilience: m(0, 0),
      }),
    );

    expect(rule).toBe('coverage_below_minimum');
  });

  it('never reports a strong band off a single observation', () => {
    const { band } = computeBand(
      measures({
        structural_resilience: m(1, 1),
        factual_resilience: m(0, 0),
        qualifier_resilience: m(0, 0),
      }),
    );

    expect(band).not.toBe('resilient');
    expect(band).toBe('insufficient_evidence');
  });

  it('returns insufficient_evidence when no facts were readable but images may hold them', () => {
    const { band, reason } = computeBand(
      measures({
        factual_resilience: m(0, 0, 3),
        qualifier_resilience: m(0, 0),
      }),
    );

    expect(band).toBe('insufficient_evidence');
    expect(reason).toMatch(/undeterminable|image/i);
  });
});

describe('computeBand — short-circuits to fragile', () => {
  it('short-circuits on an important contradiction even when everything else is perfect', () => {
    const { band, reason } = computeBand(
      measures({ contradiction_count: 1, contradictions: [importantContradiction] }),
    );

    expect(band).toBe('fragile');
    expect(reason).toMatch(/contradiction/i);
  });

  it('identifies the contradiction rule as the trigger', () => {
    const { rule } = computeBand(
      measures({ contradiction_count: 1, contradictions: [importantContradiction] }),
    );

    expect(rule).toBe('important_contradiction');
  });

  it('does not short-circuit on a minor contradiction alone', () => {
    const { band } = computeBand(
      measures({ contradiction_count: 1, contradictions: [minorContradiction] }),
    );

    expect(band).not.toBe('fragile');
  });

  it('short-circuits on heavy qualifier loss rather than averaging it away', () => {
    const { band, reason } = computeBand(
      measures({ qualifier_resilience: m(0, 16) }),
    );

    expect(band).toBe('fragile');
    expect(reason).toMatch(/qualifier/i);
    expect(computeBand(measures({ qualifier_resilience: m(0, 16) })).rule).toBe(
      'qualifier_below_threshold',
    );
  });

  it('cannot be triggered by a qualifier measure that is not applicable', () => {
    // The corrected known-table case: no qualifiers at all must not band the
    // page fragile via the qualifier rule.
    const { band, rule } = computeBand(
      measures({
        qualifier_resilience: m(0, 0),
        factual_resilience: m(0, 4),
        structural_resilience: m(5, 9),
      }),
    );

    expect(band).toBe('fragile');
    expect(rule).toBe('factual_below_threshold');
  });

  it('short-circuits on heavy factual loss', () => {
    const { band, reason, rule } = computeBand(measures({ factual_resilience: m(1, 5) }));

    expect(band).toBe('fragile');
    expect(reason).toMatch(/label|facts/i);
    expect(rule).toBe('factual_below_threshold');
  });
});

describe('computeBand — ordered thresholds', () => {
  it('reports resilient only when every assessed measure is near-total and nothing conflicts', () => {
    expect(computeBand(measures()).band).toBe('resilient');
    expect(computeBand(measures()).rule).toBe('all_measures_strong');
  });

  it('reports mostly_resilient for a moderate shortfall', () => {
    const { band } = computeBand(measures({ qualifier_resilience: m(8, 10) }));
    expect(band).toBe('mostly_resilient');
  });

  it('reports fragile below the mostly_resilient threshold', () => {
    const { band } = computeBand(measures({ structural_resilience: m(6, 10) }));
    expect(band).toBe('fragile');
  });

  it('withholds the strongest band when the evidence base is thin', () => {
    // Everything observed survived, but only four things were observable.
    const { band, reason } = computeBand(
      measures({
        structural_resilience: m(2, 2),
        factual_resilience: m(1, 1),
        qualifier_resilience: m(1, 1),
      }),
    );

    expect(band).toBe('mostly_resilient');
    expect(reason).toMatch(/thin|only/i);
  });

  it('ignores a not-applicable measure instead of penalizing the page', () => {
    const { band } = computeBand(
      measures({ qualifier_resilience: m(0, 0) }),
    );

    expect(band).toBe('resilient');
  });
});

describe('computeBand — output shape', () => {
  it('always explains the band it chose', () => {
    const { reason } = computeBand(measures());
    expect(reason.length).toBeGreaterThan(0);
  });
});
