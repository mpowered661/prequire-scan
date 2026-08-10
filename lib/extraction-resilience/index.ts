import { extractA } from './extract-a';
import { extractB } from './extract-b';
import { computeMeasures } from './measures';
import { computeBand } from './bands';
import { runChecks } from './checks';
import type { ExtractionResilienceResult } from './types';

// Bump when the extraction, checks, or band rules change, so a stored result
// can always say what produced it — the same convention as SCAN_PROMPT_VERSION.
export const EXTRACTION_RESILIENCE_VERSION = '2026-08-inc1';

// EXTRACT_B is reproducible from the page; only a short sample is retained so
// stored results stay small.
const EXTRACT_B_SAMPLE_CHARS = 600;

/**
 * Runs the whole Extraction Resilience pass for a page.
 *
 * Entirely deterministic: no model is called anywhere in this path, and no
 * number here is model-produced.
 */
export function buildExtractionResilience(
  url: string,
  rawHtml: string,
): ExtractionResilienceResult {
  const a = extractA(url, rawHtml);
  const b = extractB(rawHtml);
  const measures = computeMeasures(a, b);
  const { band, rule, reason } = computeBand(measures);
  const checks = runChecks(a, measures);

  return {
    band,
    bandRule: rule,
    bandReason: reason,
    measures,
    checks,
    extractA: a,
    extractB: {
      length: b.length,
      tokenCount: b.tokens.length,
      sample: b.text.slice(0, EXTRACT_B_SAMPLE_CHARS),
    },
    // Vision is deferred. This stays null in Increment 1 rather than being
    // filled with a guess.
    visualParity: null,
    meta: {
      increment: 1,
      engine_version: EXTRACTION_RESILIENCE_VERSION,
      extract_a: 'dom_structural',
      extract_b: 'flattened_striphtml',
      vision_assessed: false,
      scoring: 'deterministic_band_rules',
    },
  };
}

export { extractA } from './extract-a';
export { extractB } from './extract-b';
export { computeMeasures } from './measures';
export { computeBand } from './bands';
export { runChecks } from './checks';
export { parseExtractionResilience } from './guard';
export * from './types';
