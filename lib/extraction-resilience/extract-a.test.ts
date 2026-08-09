import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractA } from './extract-a';
import type { ValueBinding } from './types';

function fixture(name: string): string {
  return readFileSync(join(__dirname, '__fixtures__', `${name}.html`), 'utf8');
}

function bindingFor(bindings: ValueBinding[], label: string, value: string) {
  return bindings.find((b) => b.label === label && b.value === value);
}

function unitTexts(b: ValueBinding | undefined, kind: string): string[] {
  return (b?.units ?? []).filter((u) => u.kind === kind).map((u) => u.text);
}

function dimensionLabels(b: ValueBinding | undefined): string[] {
  return (b?.dimensions ?? []).map((d) => d.label);
}

function qualifierTexts(b: ValueBinding | undefined, kind: string): string[] {
  return (b?.qualifiers ?? []).filter((q) => q.kind === kind).map((q) => q.text);
}

const STRONG = 'https://acmefinancial.example/commercial-lending';

describe('extractA — identity signals', () => {
  it('reads canonical, title, meta description, and H1', () => {
    const a = extractA(STRONG, fixture('strong-semantic'));

    expect(a.identity.canonicalUrl).toBe('https://acmefinancial.example/commercial-lending');
    expect(a.identity.title).toBe('Commercial Real Estate Lending | Acme Financial');
    expect(a.identity.metaDescription).toContain('$250K to $10M');
    expect(a.identity.primaryH1).toBe('Commercial Real Estate Lending');
  });

  it('resolves the entity from JSON-LD ahead of og:site_name', () => {
    const a = extractA(STRONG, fixture('strong-semantic'));

    expect(a.identity.resolvedEntity).toBe('Acme Financial');
    expect(a.identity.entitySource).toBe('json_ld');
  });

  it('falls back to og:site_name when structured data names no organization', () => {
    const a = extractA('https://harborcoffee.example/subscriptions', fixture('no-schema'));

    expect(a.identity.resolvedEntity).toBe('Harbor Coffee Roasters');
    expect(a.identity.entitySource).toBe('og_site_name');
  });

  it('falls back to a title suffix last', () => {
    const a = extractA(
      'https://vector.example/pricing',
      '<html><head><title>Pricing | Vector Tools</title></head><body><h1>Pricing</h1></body></html>',
    );

    expect(a.identity.resolvedEntity).toBe('Vector Tools');
    expect(a.identity.entitySource).toBe('title_suffix');
  });

  it('resolves no entity or topic when the page only has layout chrome', () => {
    const a = extractA('https://unknown.example/', fixture('ambiguous-identity'));

    expect(a.identity.resolvedEntity).toBeNull();
    expect(a.identity.entitySource).toBe('none');
    expect(a.identity.pageTopic).toBeNull();
    expect(a.identity.topicSource).toBe('none');
  });

  it('takes the topic from the H1 when present', () => {
    const a = extractA(STRONG, fixture('strong-semantic'));

    expect(a.identity.pageTopic).toBe('Commercial Real Estate Lending');
    expect(a.identity.topicSource).toBe('h1');
  });
});

describe('extractA — outline and sections', () => {
  it('records the heading outline in document order', () => {
    const a = extractA(STRONG, fixture('strong-semantic'));

    expect(a.outline[0]).toEqual({ level: 1, text: 'Commercial Real Estate Lending' });
    expect(a.outline.map((h) => h.level)).toContain(3);
    expect(a.outline.some((h) => h.text === 'Markets served')).toBe(true);
  });

  it('records semantic sections that are present', () => {
    const a = extractA(STRONG, fixture('strong-semantic'));

    expect(a.semanticSections).toEqual(
      expect.arrayContaining(['header', 'nav', 'main', 'article', 'footer']),
    );
  });

  it('reports an empty outline for a page with no headings', () => {
    const a = extractA('https://unknown.example/', fixture('ambiguous-identity'));
    expect(a.outline).toEqual([]);
  });
});

// The known test case from the specification.
describe('extractA — matrix table semantics (known test case)', () => {
  const a = extractA('https://vantagegroup.example/q3-revenue', fixture('matrix-table'));

  it('retains column headers, row headers, and the cell grid', () => {
    const table = a.tables[0];

    expect(table.columnHeaders).toEqual(['Region', '2025', '2026']);
    expect(table.rowHeaders).toEqual(['North', 'South']);
    expect(table.rows).toEqual([
      ['4.2', '5.1'],
      ['9.8', '3.3'],
    ]);
    expect(table.hasColumnDimension).toBe(true);
    expect(table.isKeyValue).toBe(false);
  });

  it('binds each cell to BOTH its row header and its column header', () => {
    const north2025 = bindingFor(a.bindings, 'North', '4.2');
    const north2026 = bindingFor(a.bindings, 'North', '5.1');
    const south2025 = bindingFor(a.bindings, 'South', '9.8');
    const south2026 = bindingFor(a.bindings, 'South', '3.3');

    expect(north2025).toBeDefined();
    expect(north2026).toBeDefined();
    expect(south2025).toBeDefined();
    expect(south2026).toBeDefined();

    expect(north2025!.labelSource).toBe('row_header');
    expect(dimensionLabels(north2025)).toEqual(['2025']);
    expect(dimensionLabels(north2026)).toEqual(['2026']);
    expect(dimensionLabels(south2025)).toEqual(['2025']);
    expect(dimensionLabels(south2026)).toEqual(['2026']);
  });

  it('treats column headers as attribution, never as claim qualifiers', () => {
    // The defect this guards against: counting "2025" as a qualifier inflated
    // the qualifier denominator on a table that has no qualifiers at all.
    for (const b of a.bindings) {
      expect(b.qualifiers).toEqual([]);
    }
  });

  it('records no units or footnotes on the bare table', () => {
    expect(a.footnotes).toEqual([]);
    expect(a.bindings.every((b) => b.units.length === 0)).toBe(true);
  });

  it('emits a column-header relation for every body cell', () => {
    const colRelations = a.relations.filter((r) => r.kind === 'table_cell_to_column_header');
    expect(colRelations).toHaveLength(4);
  });
});

describe('extractA — spans defeat column attribution safely', () => {
  it('marks column attribution unresolved when a body row uses rowspan', () => {
    const html =
      '<table><thead><tr><th>Region</th><th>2025</th><th>2026</th></tr></thead>' +
      '<tbody><tr><th>North</th><td rowspan="2">4.2</td><td>5.1</td></tr>' +
      '<tr><th>South</th><td>3.3</td></tr></tbody></table>';
    const a = extractA('https://x.test/', html);

    expect(a.bindings.length).toBeGreaterThan(0);
    // Guessing a column here could attribute a number to the wrong year.
    expect(a.bindings.every((b) => b.dimensionUnresolved)).toBe(true);
    expect(a.bindings.every((b) => b.dimensions.length === 0)).toBe(true);
  });

  it('aligns column headers across a colspan in the header row', () => {
    const html =
      '<table><thead><tr><th>Region</th><th colspan="2">Revenue</th></tr></thead>' +
      '<tbody><tr><th>North</th><td>4.2</td><td>5.1</td></tr></tbody></table>';
    const a = extractA('https://x.test/', html);

    expect(a.tables[0].columnHeaders).toEqual(['Region', 'Revenue', 'Revenue']);
    expect(dimensionLabels(bindingFor(a.bindings, 'North', '4.2'))).toEqual(['Revenue']);
  });
});

describe('extractA — key/value table', () => {
  it('treats a two-column table as key/value, not a matrix', () => {
    const a = extractA(STRONG, fixture('strong-semantic'));
    const table = a.tables[0];

    expect(table.isKeyValue).toBe(true);
    expect(table.hasColumnDimension).toBe(false);
    expect(table.rowHeaders).toEqual(['Bridge loan', 'Permanent financing']);
  });

  it('binds the rate to its row label with the percent unit', () => {
    const a = extractA(STRONG, fixture('strong-semantic'));
    const bridge = bindingFor(a.bindings, 'Bridge loan', '8.25');

    expect(bridge).toBeDefined();
    expect(bridge!.origin).toBe('table');
    expect(unitTexts(bridge, 'unit')).toContain('%');
    // A two-column table has no column dimension to attribute.
    expect(bridge!.dimensions).toEqual([]);
  });
});

describe('extractA — number/label association outside tables', () => {
  it('binds a definition term to its value and keeps the unit as an annotation', () => {
    const a = extractA(STRONG, fixture('strong-semantic'));
    const term = bindingFor(a.bindings, 'Minimum term', '12');

    expect(term).toBeDefined();
    expect(term!.labelSource).toBe('definition_term');
    expect(term!.origin).toBe('definition_list');
    expect(unitTexts(term, 'unit')).toContain('months');
  });

  it('binds an inline "label: value" pair', () => {
    const a = extractA(STRONG, fixture('strong-semantic'));
    const retention = bindingFor(a.bindings, 'Enterprise client retention rate', '94');

    expect(retention).toBeDefined();
    expect(retention!.labelSource).toBe('inline_label');
    expect(unitTexts(retention, 'unit')).toContain('%');
  });

  it('separates currency and scale from the numeric core', () => {
    const a = extractA('https://northwind.example/results', fixture('unlabeled-numbers'));
    const contract = bindingFor(a.bindings, 'Contract value', '4.2');

    expect(contract).toBeDefined();
    expect(unitTexts(contract, 'currency')).toContain('$');
    expect(unitTexts(contract, 'scale')).toContain('M');
  });

  it('records a bare stat-tile number as an unlabeled binding', () => {
    const a = extractA('https://northwind.example/results', fixture('unlabeled-numbers'));
    const bare = a.bindings.find((b) => b.value === '89' && b.label === null);

    expect(bare).toBeDefined();
    expect(bare!.labelSource).toBe('none');
  });

  it('does not emit a binding for a page with no factual values', () => {
    const a = extractA('https://unknown.example/', fixture('ambiguous-identity'));
    expect(a.bindings).toEqual([]);
  });
});

describe('extractA — genuine claim qualifiers', () => {
  const a = extractA('https://brightline.example/savings', fixture('qualified-claims'));

  it('detects hedging language as an approximation qualifier', () => {
    const saving = bindingFor(a.bindings, 'Average annual saving', '1,200');

    expect(saving).toBeDefined();
    expect(qualifierTexts(saving, 'approximation')).toContain('up to');
  });

  it('carries footnote small print onto the claim it conditions', () => {
    const saving = bindingFor(a.bindings, 'Average annual saving', '1,200');

    expect(qualifierTexts(saving, 'footnote')).toContain('1');
    // The footnote body itself contributes a restriction and a disclaimer.
    expect(qualifierTexts(saving, 'restriction')).toContain('unaudited');
    expect(qualifierTexts(saving, 'disclaimer')).toContain('individual results may vary');
  });

  it('detects a sample restriction stated inline', () => {
    const satisfaction = bindingFor(a.bindings, 'Reported satisfaction', '96');

    expect(satisfaction).toBeDefined();
    expect(qualifierTexts(satisfaction, 'restriction')).toContain('based on a survey');
  });

  it('detects an eligibility restriction', () => {
    const fee = bindingFor(a.bindings, 'Installation fee', '0');

    expect(fee).toBeDefined();
    expect(qualifierTexts(fee, 'restriction')).toContain('eligible customers');
  });

  it('leaves an unqualified value with no qualifiers at all', () => {
    const warranty = bindingFor(a.bindings, 'Panel warranty', '25');

    expect(warranty).toBeDefined();
    expect(warranty!.qualifiers).toEqual([]);
  });

  it('counts each qualifier on a claim exactly once', () => {
    const saving = bindingFor(a.bindings, 'Average annual saving', '1,200')!;
    const seen = saving.qualifiers.map((q) => `${q.kind}:${q.text}`);

    expect(new Set(seen).size).toBe(seen.length);
  });
});

describe('extractA — figures and assets', () => {
  it('pairs a figure image with its caption', () => {
    const a = extractA(
      'https://meridianhealth.example/impact-2025',
      fixture('image-trapped-facts'),
    );
    const withCaption = a.figures.find((f) => f.caption === 'Cost per visit');

    expect(withCaption).toBeDefined();
    expect(withCaption!.imageSrc).toBe('/charts/cost-per-visit-diagram.png');
    expect(withCaption!.imageAlt).toBeNull();
  });

  it('counts assets and queues image candidates without interpreting them', () => {
    const a = extractA(
      'https://meridianhealth.example/impact-2025',
      fixture('image-trapped-facts'),
    );

    expect(a.assets.images.total).toBe(4);
    expect(a.assets.images.decorative).toBe(1);
    expect(a.assets.images.withoutAlt).toBe(1);
    expect(a.assets.images.withAlt).toBe(2);
    expect(a.assets.svg).toBe(1);
    expect(a.assets.canvas).toBe(1);
    expect(a.assets.iframes).toBe(1);
    expect(a.assets.imageCandidates.map((c) => c.src)).toContain('/charts/retention-chart.png');
  });
});

describe('extractA — structured data reuses the existing scanner parser', () => {
  it('reports schema types and organization names', () => {
    const a = extractA(STRONG, fixture('strong-semantic'));

    expect(a.schema.types).toEqual(expect.arrayContaining(['Organization', 'Service', 'FAQPage']));
    expect(a.schema.blockCount).toBe(1);
    expect(a.schema.organizationNames).toContain('Acme Financial');
    expect(a.schema.hasMalformed).toBe(false);
  });

  it('collects declared numeric values for contradiction checking', () => {
    const a = extractA('https://lumen.example/starter', fixture('schema-body-conflict'));
    const prices = a.schema.declaredValues.filter((v) => v.path.endsWith('price'));

    expect(prices.map((p) => p.value)).toContain('49');
  });

  it('flags malformed JSON-LD without throwing', () => {
    const a = extractA(
      'https://x.example/',
      '<html><head><script type="application/ld+json">{ not json </script></head>' +
        '<body><h1>X</h1></body></html>',
    );

    expect(a.schema.hasMalformed).toBe(true);
    expect(a.schema.types).toEqual([]);
  });
});

describe('extractA — null and missing-field handling', () => {
  it('returns a complete structure for empty input without throwing', () => {
    const a = extractA('https://empty.example/', '');

    expect(a.identity.title).toBeNull();
    expect(a.identity.canonicalUrl).toBeNull();
    expect(a.identity.primaryH1).toBeNull();
    expect(a.identity.resolvedEntity).toBeNull();
    expect(a.outline).toEqual([]);
    expect(a.bindings).toEqual([]);
    expect(a.tables).toEqual([]);
    expect(a.footnotes).toEqual([]);
    expect(a.schema.types).toEqual([]);
    expect(a.assets.images.total).toBe(0);
  });

  it('treats a whitespace-only title as absent', () => {
    const a = extractA(
      'https://x.example/',
      '<html><head><title>   </title></head><body></body></html>',
    );

    expect(a.identity.title).toBeNull();
    expect(a.identity.resolvedEntity).toBeNull();
  });

  it('handles a table with no header row', () => {
    const a = extractA(
      'https://x.example/',
      '<table><tr><td>Setup fee</td><td>$500</td></tr></table>',
    );

    expect(a.tables[0].columnHeaders).toEqual([]);
    expect(bindingFor(a.bindings, 'Setup fee', '500')).toBeDefined();
  });

  it('produces stable ids across repeated runs of the same input', () => {
    // Ids come from a per-call counter, so two scans cannot interleave.
    const html = fixture('strong-semantic');
    const first = extractA(STRONG, html).bindings.map((b) => b.id);
    const second = extractA(STRONG, html).bindings.map((b) => b.id);

    expect(first).toEqual(second);
  });
});
