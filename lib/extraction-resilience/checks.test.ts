import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractA } from './extract-a';
import { extractB } from './extract-b';
import { computeMeasures } from './measures';
import { runChecks } from './checks';
import type { ResilienceCheck, ResilienceStatus } from './types';

function fixture(name: string): string {
  return readFileSync(join(__dirname, '__fixtures__', `${name}.html`), 'utf8');
}

function checksFor(name: string, url = 'https://example.test/'): ResilienceCheck[] {
  const html = fixture(name);
  const a = extractA(url, html);
  const b = extractB(html);
  return runChecks(a, computeMeasures(a, b));
}

function statusOf(checks: ResilienceCheck[], id: string): ResilienceStatus | undefined {
  return checks.find((c) => c.id === id)?.status;
}

const VALID_STATUSES: ResilienceStatus[] = [
  'pass', 'warning', 'fail', 'undeterminable', 'not_applicable',
];

describe('runChecks — status contract', () => {
  it('only ever emits the five contract statuses', () => {
    for (const name of [
      'strong-semantic', 'matrix-table', 'unlabeled-numbers',
      'weak-headings', 'no-schema', 'ambiguous-identity',
      'image-trapped-facts', 'schema-body-conflict', 'qualified-claims',
    ]) {
      for (const check of checksFor(name)) {
        expect(VALID_STATUSES).toContain(check.status);
      }
    }
  });

  it('gives every check a stable id and a human-readable detail', () => {
    for (const check of checksFor('strong-semantic')) {
      expect(check.id).toMatch(/^[a-z_]+$/);
      expect(check.label.length).toBeGreaterThan(0);
      expect(check.detail.length).toBeGreaterThan(0);
    }
  });
});

describe('runChecks — table semantics', () => {
  it('passes a table that carries real header relationships', () => {
    expect(statusOf(checksFor('matrix-table'), 'table_semantics')).toBe('pass');
  });

  it('is not applicable when the page has no tables', () => {
    expect(statusOf(checksFor('no-schema'), 'table_semantics')).toBe('not_applicable');
  });
});

describe('runChecks — number/label association', () => {
  it('passes when values carry labels', () => {
    expect(statusOf(checksFor('strong-semantic'), 'number_label_association')).toBe('pass');
  });

  it('fails when most values are bare', () => {
    const checks = checksFor('unlabeled-numbers');

    expect(statusOf(checks, 'number_label_association')).toBe('fail');
    expect(checks.find((c) => c.id === 'number_label_association')!.evidence.join(' ')).toContain('89');
  });

  it('is not applicable when the page states no values', () => {
    expect(statusOf(checksFor('ambiguous-identity'), 'number_label_association')).toBe('not_applicable');
  });
});

describe('runChecks — unit preservation', () => {
  it('passes when units travel with their numbers', () => {
    expect(statusOf(checksFor('strong-semantic'), 'unit_preservation')).toBe('pass');
  });

  it('is not applicable on a table that states no units', () => {
    expect(statusOf(checksFor('matrix-table'), 'unit_preservation')).toBe('not_applicable');
  });

  it('fails when a unit lives in a caption the flattened text separates', () => {
    const html =
      '<table><caption>Revenue in $ millions</caption>' +
      '<thead><tr><th>Region</th><th>2025</th></tr></thead>' +
      '<tbody><tr><th>North</th><td>4.2</td></tr></tbody></table>';
    const a = extractA('https://x.test/', html);
    const checks = runChecks(a, computeMeasures(a, extractB(html)));

    expect(statusOf(checks, 'unit_preservation')).toBe('fail');
  });
});

describe('runChecks — claim qualifier preservation', () => {
  it('is not applicable on a table with headers but no claim qualifiers', () => {
    // Regression: header/cell relations must never reach this check.
    const checks = checksFor('matrix-table');
    const qualifier = checks.find((c) => c.id === 'qualifier_preservation')!;

    expect(qualifier.status).toBe('not_applicable');
    expect(qualifier.evidence).toEqual([]);
    expect(qualifier.detail).toMatch(/nothing of this kind to lose/i);
  });

  it('fails when real qualifiers are stripped by flattening', () => {
    expect(statusOf(checksFor('qualified-claims'), 'qualifier_preservation')).not.toBe(
      'not_applicable',
    );
  });

  it('is not applicable when the page states no qualified claims', () => {
    expect(statusOf(checksFor('no-schema'), 'qualifier_preservation')).toBe('not_applicable');
  });
});

describe('runChecks — fact attribution', () => {
  it('fails the known matrix table because column attribution is lost', () => {
    const checks = checksFor('matrix-table');
    const fact = checks.find((c) => c.id === 'fact_attribution')!;

    expect(fact.status).toBe('fail');
    expect(fact.evidence.join(' ')).toContain('column header');
  });

  it('passes a page whose values keep their full attribution', () => {
    expect(statusOf(checksFor('strong-semantic'), 'fact_attribution')).toBe('pass');
  });
});

describe('runChecks — footnote reachability', () => {
  it('passes when a footnote reference resolves to its text', () => {
    expect(statusOf(checksFor('qualified-claims'), 'footnote_reachability')).toBe('pass');
  });

  it('is not applicable on the bare matrix table, which has no footnotes', () => {
    expect(statusOf(checksFor('matrix-table'), 'footnote_reachability')).toBe('not_applicable');
  });

  it('is not applicable when the page has no footnotes', () => {
    expect(statusOf(checksFor('strong-semantic'), 'footnote_reachability')).toBe('not_applicable');
  });

  it('fails when a footnote reference points nowhere', () => {
    const html = '<p>Revenue was 4.2<sup><a href="#missing">1</a></sup> last year.</p>';
    const a = extractA('https://x.test/', html);
    const checks = runChecks(a, computeMeasures(a, extractB(html)));

    expect(statusOf(checks, 'footnote_reachability')).toBe('fail');
  });
});

describe('runChecks — contradictions', () => {
  it('fails when structured data and body copy state different values', () => {
    expect(statusOf(checksFor('schema-body-conflict'), 'schema_body_contradiction')).toBe('fail');
  });

  it('fails when the entity is named inconsistently', () => {
    expect(statusOf(checksFor('schema-body-conflict'), 'entity_consistency')).toBe('fail');
  });

  it('passes entity consistency when the names agree', () => {
    expect(statusOf(checksFor('strong-semantic'), 'entity_consistency')).toBe('pass');
  });

  it('is undeterminable when nothing identifies the entity at all', () => {
    expect(statusOf(checksFor('ambiguous-identity'), 'entity_consistency')).toBe('undeterminable');
  });

  it('is not applicable when the page carries no structured data', () => {
    expect(statusOf(checksFor('no-schema'), 'schema_body_contradiction')).toBe('not_applicable');
  });
});

describe('runChecks — visual facts are never guessed', () => {
  it('reports undeterminable when chart-like images may hold facts', () => {
    const checks = checksFor('image-trapped-facts');
    const visual = checks.find((c) => c.id === 'visual_fact_reachability')!;

    expect(visual.status).toBe('undeterminable');
    expect(visual.detail).toMatch(/vision|cannot|not assessed/i);
  });

  it('is not applicable on a page with no such images', () => {
    expect(statusOf(checksFor('no-schema'), 'visual_fact_reachability')).toBe('not_applicable');
  });

  it('never reports a pass or fail for visual facts in Increment 1', () => {
    for (const name of ['image-trapped-facts', 'strong-semantic', 'matrix-table']) {
      const status = statusOf(checksFor(name), 'visual_fact_reachability');
      expect(['undeterminable', 'not_applicable']).toContain(status);
    }
  });
});

describe('runChecks — extraction delta', () => {
  it('flags a page whose structure is largely destroyed by flattening', () => {
    expect(['warning', 'fail']).toContain(statusOf(checksFor('matrix-table'), 'extraction_delta'));
  });

  it('counts the column-header relations among the destroyed structure', () => {
    const checks = checksFor('matrix-table');
    const delta = checks.find((c) => c.id === 'extraction_delta')!;

    expect(delta.evidence.join(' ')).toContain('table_cell_to_column_header');
  });
});

describe('runChecks — null handling', () => {
  it('produces a full check set for an empty document without throwing', () => {
    const a = extractA('https://e.test/', '');
    const checks = runChecks(a, computeMeasures(a, extractB('')));

    expect(checks.length).toBeGreaterThanOrEqual(9);
    for (const check of checks) {
      expect(VALID_STATUSES).toContain(check.status);
    }
  });
});
