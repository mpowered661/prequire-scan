import { describe, it, expect } from 'vitest';
import {
  computeAccessibilityScore,
  computeOverallScore,
  SCAN_SYSTEM_PROMPT,
  SCAN_PROMPT_VERSION,
  type CheckItem,
  type ScanResult,
  type CategoryResult,
} from './scanPrompt';

function check(status: CheckItem['status']): CheckItem {
  return { label: 'x', status, detail: '' };
}

function cat(score: number): CategoryResult {
  return { score, checks: [], recommendations: [] };
}

function categories(
  content: number,
  schema: number,
  perf: number,
  a11y: number,
): ScanResult['categories'] {
  return {
    contentQuality: cat(content),
    schemaMarkup: cat(schema),
    performance: cat(perf),
    accessibility: cat(a11y),
  };
}

// Gate 1 (scanner-audit-addendum-2026-08-06): inferred accessibility values
// must not affect the overall score, and unverifiable checks must be reported
// as not_assessable rather than scored.
describe('computeOverallScore', () => {
  it('is the mean of content, schema, and performance', () => {
    expect(computeOverallScore(categories(90, 60, 30, 0))).toBe(60);
  });

  it('ignores the accessibility score entirely', () => {
    const withZeroA11y = computeOverallScore(categories(80, 80, 80, 0));
    const withPerfectA11y = computeOverallScore(categories(80, 80, 80, 100));
    expect(withZeroA11y).toBe(withPerfectA11y);
    expect(withZeroA11y).toBe(80);
  });

  it('rounds to the nearest whole number', () => {
    expect(computeOverallScore(categories(70, 70, 71, 50))).toBe(70); // 70.33 → 70
    expect(computeOverallScore(categories(70, 71, 71, 50))).toBe(71); // 70.67 → 71
  });

  it('is deterministic', () => {
    const c = categories(55, 65, 75, 85);
    const scores = Array.from({ length: 5 }, () => computeOverallScore(c));
    expect(new Set(scores).size).toBe(1);
  });
});

// Server-side rubric — added after live verification caught the model returning
// 92 for four passing checks (rubric says 96 + 4 bonus = 100).
describe('computeAccessibilityScore', () => {
  it('four passes = 96 base + 4 bonus = 100; not_assessable contributes nothing', () => {
    const checks = [
      check('pass'), check('pass'), check('pass'), check('pass'),
      check('not_assessable'), check('not_assessable'),
    ];
    expect(computeAccessibilityScore(checks)).toBe(100);
  });

  it('warn is half credit, fail is zero, no bonus unless all pass', () => {
    // 24 + 12 + 0 + 24 = 60, no bonus
    expect(
      computeAccessibilityScore([
        check('pass'), check('warn'), check('fail'), check('pass'),
        check('not_assessable'), check('not_assessable'),
      ]),
    ).toBe(60);
  });

  it('all fail = 0; no scored checks = 0', () => {
    expect(
      computeAccessibilityScore([check('fail'), check('fail'), check('fail'), check('fail')]),
    ).toBe(0);
    expect(computeAccessibilityScore([check('not_assessable'), check('not_assessable')])).toBe(0);
    expect(computeAccessibilityScore([])).toBe(0);
  });

  it('is deterministic and bounded to 0-100', () => {
    const checks = [check('pass'), check('pass'), check('pass'), check('pass')];
    const runs = Array.from({ length: 5 }, () => computeAccessibilityScore(checks));
    expect(new Set(runs).size).toBe(1);
    expect(runs[0]).toBeLessThanOrEqual(100);
  });
});

describe('SCAN_SYSTEM_PROMPT accessibility contract', () => {
  it('has a version constant', () => {
    expect(SCAN_PROMPT_VERSION).toBe('2026-08');
  });

  it('marks contrast and keyboard checks as not assessable, never scored', () => {
    expect(SCAN_SYSTEM_PROMPT).toContain('not_assessable');
    expect(SCAN_SYSTEM_PROMPT).toContain(
      'Not assessable from fetched HTML — requires a rendered-page audit.',
    );
    expect(SCAN_SYSTEM_PROMPT).toContain(
      'NEVER assign pass, warn, or fail to checks 5 and 6',
    );
  });

  it('scores accessibility over exactly 4 evaluated checks at 24 points each', () => {
    expect(SCAN_SYSTEM_PROMPT).toContain('each is worth 24 points');
    expect(SCAN_SYSTEM_PROMPT).toContain('4 checks = 96 points base');
    // the old 6-check 16-point rubric must be gone
    expect(SCAN_SYSTEM_PROMPT).not.toContain('worth 16 points');
  });

  it('no longer asks the model to judge contrast or keyboard behavior from HTML', () => {
    expect(SCAN_SYSTEM_PROMPT).not.toContain('no light-on-light combinations evident');
    expect(SCAN_SYSTEM_PROMPT).not.toContain('focus indicators not suppressed');
  });

  it('makes no ADA or WCAG compliance claims', () => {
    expect(SCAN_SYSTEM_PROMPT).not.toMatch(/\bADA\b/);
    expect(SCAN_SYSTEM_PROMPT).not.toMatch(/WCAG/i);
  });
});
