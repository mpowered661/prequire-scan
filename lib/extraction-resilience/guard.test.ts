import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildExtractionResilience } from './index';
import { parseExtractionResilience } from './guard';

function fixture(name: string): string {
  return readFileSync(join(__dirname, '__fixtures__', `${name}.html`), 'utf8');
}

const REAL = buildExtractionResilience(
  'https://acmefinancial.example/commercial-lending',
  fixture('strong-semantic'),
);

describe('parseExtractionResilience — accepts what the engine produces', () => {
  it('round-trips a real result through JSON', () => {
    const parsed = parseExtractionResilience(JSON.parse(JSON.stringify(REAL)));

    expect(parsed).not.toBeNull();
    expect(parsed!.band).toBe(REAL.band);
    expect(parsed!.bandRule).toBe(REAL.bandRule);
    expect(parsed!.measures.factual_resilience.assessed).toBe(
      REAL.measures.factual_resilience.assessed,
    );
    expect(parsed!.checks.length).toBe(REAL.checks.length);
  });
});

describe('parseExtractionResilience — rejects anything it cannot trust', () => {
  it('returns null for a legacy row that predates the field', () => {
    expect(parseExtractionResilience(undefined)).toBeNull();
    expect(parseExtractionResilience(null)).toBeNull();
  });

  it('returns null for non-object input', () => {
    expect(parseExtractionResilience('resilient')).toBeNull();
    expect(parseExtractionResilience(42)).toBeNull();
    expect(parseExtractionResilience([])).toBeNull();
  });

  it('returns null when the band is not one of the known bands', () => {
    const bad = { ...JSON.parse(JSON.stringify(REAL)), band: 'excellent' };
    expect(parseExtractionResilience(bad)).toBeNull();
  });

  it('returns null when the band rule is missing', () => {
    const bad = JSON.parse(JSON.stringify(REAL));
    delete bad.bandRule;
    expect(parseExtractionResilience(bad)).toBeNull();
  });

  it('returns null when measures are missing', () => {
    const bad = JSON.parse(JSON.stringify(REAL));
    delete bad.measures;
    expect(parseExtractionResilience(bad)).toBeNull();
  });

  it('returns null when a measure is missing its denominator', () => {
    const bad = JSON.parse(JSON.stringify(REAL));
    delete bad.measures.factual_resilience.assessed;
    expect(parseExtractionResilience(bad)).toBeNull();
  });

  it('returns null when contradiction_count is not an integer', () => {
    const bad = JSON.parse(JSON.stringify(REAL));
    bad.measures.contradiction_count = 1.5;
    expect(parseExtractionResilience(bad)).toBeNull();
  });

  it('returns null when a check carries a status outside the contract', () => {
    const bad = JSON.parse(JSON.stringify(REAL));
    bad.checks[0].status = 'not_assessable';
    expect(parseExtractionResilience(bad)).toBeNull();
  });

  it('returns null when checks is not an array', () => {
    const bad = JSON.parse(JSON.stringify(REAL));
    bad.checks = 'none';
    expect(parseExtractionResilience(bad)).toBeNull();
  });

  it('returns null when extractA is missing', () => {
    const bad = JSON.parse(JSON.stringify(REAL));
    delete bad.extractA;
    expect(parseExtractionResilience(bad)).toBeNull();
  });

  it('tolerates a missing visualParity by treating it as not assessed', () => {
    const row = JSON.parse(JSON.stringify(REAL));
    delete row.visualParity;
    const parsed = parseExtractionResilience(row);

    expect(parsed).not.toBeNull();
    expect(parsed!.visualParity).toBeNull();
  });

  it('rejects a stored result claiming vision was performed in Increment 1', () => {
    const bad = JSON.parse(JSON.stringify(REAL));
    bad.meta.vision_assessed = true;
    expect(parseExtractionResilience(bad)).toBeNull();
  });
});
