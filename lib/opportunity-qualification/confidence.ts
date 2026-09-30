// Opportunity Qualification v0.1 — confidence.
//
// The canonical six-class customer-facing provenance vocabulary, with
// weakest-link propagation. No numeric confidence. No percentages.
//
// Confidence is INDEPENDENT of severity: nothing in this module reads a
// priority, a polarity or a count, and nothing in priority.ts reads a
// provenance class.

import type { ProvenanceClass } from './types';

/**
 * Ordered strongest → weakest. Propagation takes the weakest contributing link.
 */
export const PROVENANCE_ORDER: readonly ProvenanceClass[] = Object.freeze([
  'verified',
  'customer_provided',
  'extracted',
  'inferred',
  'unverified',
  'undeterminable',
]);

/** Classes that may satisfy a qualification gate on their own. */
const GATE_SUFFICIENT: readonly ProvenanceClass[] = Object.freeze([
  'verified',
  'customer_provided',
  'extracted',
]);

export function weakestLink(classes: readonly ProvenanceClass[]): ProvenanceClass {
  if (classes.length === 0) return 'unverified';
  let weakest = PROVENANCE_ORDER.indexOf(classes[0]);
  for (const c of classes) {
    const idx = PROVENANCE_ORDER.indexOf(c);
    // An unrecognized class fails closed to the weakest position.
    if (idx < 0) return 'undeterminable';
    if (idx > weakest) weakest = idx;
  }
  return PROVENANCE_ORDER[weakest];
}

/**
 * Inferred evidence may never independently satisfy a qualification gate.
 * Unverified and undeterminable likewise.
 */
export function canSatisfyGate(confidence: ProvenanceClass): boolean {
  return GATE_SUFFICIENT.includes(confidence);
}

/** Outreach requires directly observed provenance (gate O2). */
export function outreachAllowedConfidence(confidence: ProvenanceClass): boolean {
  return confidence === 'verified' || confidence === 'extracted';
}
