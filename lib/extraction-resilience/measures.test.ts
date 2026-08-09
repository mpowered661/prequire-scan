import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractA } from './extract-a';
import { extractB } from './extract-b';
import { computeMeasures } from './measures';
import { computeBand } from './bands';
import type { ResilienceMeasures } from './types';

function fixture(name: string): string {
  return readFileSync(join(__dirname, '__fixtures__', `${name}.html`), 'utf8');
}

function measure(name: string, url = 'https://example.test/'): ResilienceMeasures {
  const html = fixture(name);
  return computeMeasures(extractA(url, html), extractB(html));
}

// ── The known test case ──────────────────────────────────────
// Region | 2025 | 2026 / North | 4.2 | 5.1 / South | 9.8 | 3.3
// flattens to "Region 2025 2026 North 4.2 5.1 South 9.8 3.3".

describe('computeMeasures — known matrix table: fact attribution', () => {
  const m = measure('matrix-table', 'https://vantagegroup.example/q3-revenue');

  it('counts one fact per body cell', () => {
    expect(m.factual_resilience.assessed).toBe(4);
  });

  it('counts no fact as survived, because column attribution is lost', () => {
    // A fact here is the triple (row label, column label, value). The flattened
    // stream keeps "South 9.8" but nothing says whether 9.8 is the 2025 or the
    // 2026 figure, so the fact is not preserved.
    expect(m.factual_resilience.preserved).toBe(0);
    expect(m.factual_resilience.ratio).toBe(0);
  });

  it('names the column header as the missing part for the South row', () => {
    const south = m.factual_resilience.lost.filter((l) => l.startsWith('South'));

    expect(south).toHaveLength(2);
    expect(south.join(' ')).toContain('column header');
    expect(south.join(' ')).toMatch(/2025/);
    expect(south.join(' ')).toMatch(/2026/);
  });

  it('names the column header as the missing part for the North row too', () => {
    const north = m.factual_resilience.lost.filter((l) => l.startsWith('North'));

    expect(north).toHaveLength(2);
    expect(north.join(' ')).toContain('column header');
  });
});

describe('computeMeasures — known matrix table: qualifier denominator', () => {
  const m = measure('matrix-table', 'https://vantagegroup.example/q3-revenue');

  it('reports not_applicable because the table has no claim qualifiers', () => {
    // Regression: table header/cell relationships were previously counted as
    // qualifiers, producing a misleading 0/16 on a table with no qualifiers.
    expect(m.qualifier_resilience.assessed).toBe(0);
    expect(m.qualifier_resilience.preserved).toBe(0);
    expect(m.qualifier_resilience.ratio).toBeNull();
    expect(m.qualifier_resilience.notApplicable).toBe(true);
  });

  it('keeps table header relations out of the qualifier denominator entirely', () => {
    const columnRelations = 4; // one per body cell
    expect(m.qualifier_resilience.assessed).toBeLessThan(columnRelations);
    expect(m.qualifier_resilience.lost).toEqual([]);
  });

  it('still records the column relations as structural, where they belong', () => {
    expect(m.structural_resilience.assessed).toBeGreaterThanOrEqual(4);
    expect(m.delta.structuralRelationsLost).toBeGreaterThanOrEqual(4);
  });

  it('finds no contradictions on this page', () => {
    expect(m.contradiction_count).toBe(0);
  });
});

describe('computeMeasures — known matrix table: band trigger', () => {
  it('bands fragile because of lost fact attribution, not a qualifier metric', () => {
    const m = measure('matrix-table', 'https://vantagegroup.example/q3-revenue');
    const { band, rule } = computeBand(m);

    expect(band).toBe('fragile');
    expect(rule).toBe('factual_below_threshold');
    // The qualifier measure must not be what produced this verdict.
    expect(m.qualifier_resilience.ratio).toBeNull();
  });
});

// ── Qualifier denominator, positive case ─────────────────────

describe('computeMeasures — a page with genuine claim qualifiers', () => {
  const m = measure('qualified-claims', 'https://brightline.example/savings');

  it('puts real qualifiers in the denominator', () => {
    expect(m.qualifier_resilience.assessed).toBeGreaterThan(0);
    expect(m.qualifier_resilience.notApplicable).toBe(false);
  });

  it('counts a qualifier stated both inline and in its footnote exactly once', () => {
    const html = fixture('qualified-claims');
    const a = extractA('https://brightline.example/savings', html);
    const saving = a.bindings.find((b) => b.label === 'Average annual saving')!;
    const keys = saving.qualifiers.map((q) => `${q.kind}:${q.text}`);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it('loses the footnote reference, which cannot survive flattening', () => {
    expect(m.qualifier_resilience.lost.join(' ')).toMatch(/footnote/i);
  });

  it('excludes an unqualified value from the qualifier denominator', () => {
    const html = fixture('qualified-claims');
    const a = extractA('https://brightline.example/savings', html);
    const warranty = a.bindings.find((b) => b.label === 'Panel warranty')!;

    expect(warranty.qualifiers).toEqual([]);
  });
});

// ── Other fixtures ───────────────────────────────────────────

describe('computeMeasures — a strongly marked-up page', () => {
  const m = measure('strong-semantic', 'https://acmefinancial.example/commercial-lending');

  it('preserves every labeled value', () => {
    expect(m.factual_resilience.assessed).toBeGreaterThanOrEqual(7);
    expect(m.factual_resilience.preserved).toBe(m.factual_resilience.assessed);
  });

  it('keeps definition-list terms bound to their values', () => {
    // Regression: the definition-list relation was emitted anchor-first while
    // the table relation was emitted dependent-first, so survival testing
    // compared the wrong sides.
    const dlLost = m.structural_resilience.lost.filter((l) =>
      l.startsWith('definition_term_to_value'),
    );

    expect(dlLost).toEqual([]);
  });

  it('reports no contradictions', () => {
    expect(m.contradiction_count).toBe(0);
    expect(m.contradictions).toEqual([]);
  });
});

describe('computeMeasures — numbers without labels', () => {
  const m = measure('unlabeled-numbers', 'https://northwind.example/results');

  it('counts an unlabeled value as meaning that did not survive', () => {
    expect(m.factual_resilience.assessed).toBeGreaterThanOrEqual(5);
    expect(m.factual_resilience.preserved).toBeLessThanOrEqual(2);
    expect(m.factual_resilience.ratio).toBeLessThan(0.5);
  });

  it('lists the unlabeled values as losses', () => {
    expect(m.factual_resilience.lost.join(' ')).toContain('89');
  });
});

describe('computeMeasures — schema and body disagree', () => {
  const m = measure('schema-body-conflict', 'https://lumen.example/starter');

  it('detects the price stated differently in structured data and body copy', () => {
    const priceConflict = m.contradictions.find((c) => c.kind === 'schema_body_value');

    expect(priceConflict).toBeDefined();
    expect(priceConflict!.important).toBe(true);
    expect([priceConflict!.left, priceConflict!.right].join(' ')).toContain('49');
    expect([priceConflict!.left, priceConflict!.right].join(' ')).toContain('79');
  });

  it('detects the entity named differently in schema and og:site_name', () => {
    const entityConflict = m.contradictions.find((c) => c.kind === 'entity_name');

    expect(entityConflict).toBeDefined();
    expect([entityConflict!.left, entityConflict!.right].join(' ')).toContain('Lumen Analytics');
  });

  it('reports contradiction_count as an integer matching the list length', () => {
    expect(Number.isInteger(m.contradiction_count)).toBe(true);
    expect(m.contradiction_count).toBeGreaterThanOrEqual(2);
    expect(m.contradiction_count).toBe(m.contradictions.length);
  });
});

describe('computeMeasures — facts that may be trapped in images', () => {
  const m = measure('image-trapped-facts', 'https://meridianhealth.example/impact-2025');

  it('surfaces chart-like images and canvas as undeterminable, not as passes', () => {
    expect(m.factual_resilience.undeterminable).toBeGreaterThan(0);
  });

  it('excludes undeterminable items from the denominator', () => {
    expect(m.factual_resilience.assessed).toBe(0);
    expect(m.factual_resilience.ratio).toBeNull();
    expect(m.factual_resilience.notApplicable).toBe(true);
  });
});

describe('computeMeasures — a page with no assessable content', () => {
  const m = measure('ambiguous-identity', 'https://unknown.example/');

  it('reports zero denominators rather than inventing a perfect score', () => {
    expect(m.factual_resilience.assessed).toBe(0);
    expect(m.factual_resilience.ratio).toBeNull();
    expect(m.structural_resilience.assessed).toBe(0);
    expect(m.qualifier_resilience.ratio).toBeNull();
  });
});

describe('computeMeasures — numerator and denominator are always retained', () => {
  it('never collapses a measure to a bare ratio', () => {
    const m = measure('strong-semantic', 'https://acmefinancial.example/commercial-lending');

    for (const key of [
      'structural_resilience',
      'factual_resilience',
      'qualifier_resilience',
    ] as const) {
      expect(m[key]).toHaveProperty('preserved');
      expect(m[key]).toHaveProperty('assessed');
      expect(m[key]).toHaveProperty('undeterminable');
      expect(m[key].preserved).toBeLessThanOrEqual(m[key].assessed);
    }
  });

  it('reports facts blocked by spans as undeterminable, not as failures', () => {
    const html =
      '<table><thead><tr><th>Region</th><th>2025</th><th>2026</th></tr></thead>' +
      '<tbody><tr><th>North</th><td rowspan="2">4.2</td><td>5.1</td></tr>' +
      '<tr><th>South</th><td>3.3</td></tr></tbody></table>';
    const m = computeMeasures(extractA('https://x.test/', html), extractB(html));

    expect(m.factual_resilience.assessed).toBe(0);
    expect(m.factual_resilience.undeterminable).toBeGreaterThan(0);
  });

  it('handles an empty document without throwing', () => {
    const m = computeMeasures(extractA('https://e.test/', ''), extractB(''));

    expect(m.contradiction_count).toBe(0);
    expect(m.factual_resilience.assessed).toBe(0);
    expect(m.delta.aTextLength).toBe(0);
  });
});
