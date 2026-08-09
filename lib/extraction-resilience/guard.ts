import type {
  ExtractionResilienceResult,
  ResilienceBand,
  ResilienceStatus,
  ResilienceMeasure,
} from './types';

// Defensive reader for anything that comes back out of storage.
//
// `scan_results.result_json` is jsonb and rows written before this feature
// simply have no `extraction_resilience` key, so every read path must tolerate
// absence. Beyond that, a stored blob is untrusted shape: rather than letting a
// half-written or hand-edited row render as a confident verdict, anything that
// does not match the contract is rejected outright and the UI omits the panel.
//
// This is also the seam a future model-assisted pass must pass through. If
// Increment 2 ever has a model contribute evidence, its output is validated
// here and discarded on any mismatch — a model must never be able to widen the
// status contract or introduce a band the deterministic rules did not choose.

const BANDS: ResilienceBand[] = [
  'resilient', 'mostly_resilient', 'fragile', 'insufficient_evidence',
];

const STATUSES: ResilienceStatus[] = [
  'pass', 'warning', 'fail', 'undeterminable', 'not_applicable',
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validMeasure(v: unknown): v is ResilienceMeasure {
  if (!isRecord(v)) return false;
  if (typeof v.preserved !== 'number' || !Number.isFinite(v.preserved)) return false;
  if (typeof v.assessed !== 'number' || !Number.isFinite(v.assessed)) return false;
  if (typeof v.undeterminable !== 'number') return false;
  if (v.ratio !== null && typeof v.ratio !== 'number') return false;
  if (!Array.isArray(v.lost)) return false;
  // A numerator larger than its denominator is not a measure we can present.
  if (v.preserved > v.assessed) return false;
  return true;
}

export function parseExtractionResilience(
  raw: unknown,
): ExtractionResilienceResult | null {
  if (!isRecord(raw)) return null;

  if (typeof raw.band !== 'string' || !BANDS.includes(raw.band as ResilienceBand)) return null;
  if (typeof raw.bandReason !== 'string') return null;
  if (typeof raw.bandRule !== 'string' || raw.bandRule.length === 0) return null;

  const measures = raw.measures;
  if (!isRecord(measures)) return null;
  for (const key of ['structural_resilience', 'factual_resilience', 'qualifier_resilience'] as const) {
    if (!validMeasure(measures[key])) return null;
  }
  if (!Number.isInteger(measures.contradiction_count)) return null;
  if (!Array.isArray(measures.contradictions)) return null;
  if (!isRecord(measures.delta)) return null;

  if (!Array.isArray(raw.checks)) return null;
  for (const c of raw.checks) {
    if (!isRecord(c)) return null;
    if (typeof c.id !== 'string' || typeof c.label !== 'string') return null;
    if (typeof c.status !== 'string' || !STATUSES.includes(c.status as ResilienceStatus)) return null;
  }

  if (!isRecord(raw.extractA)) return null;
  if (!isRecord(raw.extractA.identity)) return null;

  // Increment 1 never performs vision. A stored result claiming otherwise did
  // not come from this engine and must not be rendered as if it had.
  const meta = raw.meta;
  if (isRecord(meta) && meta.vision_assessed === true) return null;

  const result = raw as unknown as ExtractionResilienceResult;
  return {
    ...result,
    visualParity: result.visualParity ?? null,
  };
}
