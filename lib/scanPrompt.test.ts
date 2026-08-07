import { describe, it, expect } from 'vitest';
import {
  computeOverallScore,
  SCAN_SYSTEM_PROMPT,
  SCAN_PROMPT_VERSION,
  type ScanResult,
  type CategoryResult,
} from './scanPrompt';

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
