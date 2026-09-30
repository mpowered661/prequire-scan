// Opportunity Qualification v0.1 — technical priority.
//
// Ordered rules producing a band. No arithmetic, no weights, no score.
//
// Technical priority reflects THE STATE OF THE PROPERTY. It deliberately does
// not read a provenance/confidence class, an outreach verdict, or any
// commercial value, so confidence and severity cannot move each other.

import { catalogFor } from './catalog';
import { MAJORITY_THRESHOLD } from './versions';
import type { EvidenceCluster, TechnicalPriority } from './types';

export interface PriorityDecision {
  priority: TechnicalPriority;
  reason: string;
}

/** True when the condition holds on more than half of its population. */
export function isRepeatedAcrossSample(cluster: Pick<EvidenceCluster, 'numerator' | 'denominator'>): boolean {
  if (cluster.numerator === null || cluster.denominator === null || cluster.denominator <= 0) return false;
  return cluster.numerator / cluster.denominator > MAJORITY_THRESHOLD;
}

export function technicalPriority(cluster: EvidenceCluster): PriorityDecision {
  const entry = catalogFor(cluster);
  const remediable = entry.remediationClass !== null && entry.verificationMethod !== null;

  if (cluster.polarity !== 'adverse') {
    return { priority: 'T_NONE', reason: `polarity ${cluster.polarity} is not an adverse condition` };
  }
  if (!remediable) {
    return { priority: 'T_NONE', reason: 'no known remediation class or no verification path' };
  }
  // T1 — a failure state on a destination Prequire actively checked.
  if (cluster.scopeLevel === 'checked_targets') {
    return {
      priority: 'T1',
      reason: 'an observed failure state on a checked destination, with a known remediation and a verification path',
    };
  }
  // T2 — a structural condition repeated across most of the analyzed sample.
  if (cluster.scopeLevel === 'analyzed_sample' && isRepeatedAcrossSample(cluster)) {
    return {
      priority: 'T2',
      reason: `observed on ${cluster.numerator} of ${cluster.denominator} analyzed pages, a majority of the sample`,
    };
  }
  // T3 — present but limited or isolated.
  return {
    priority: 'T3',
    reason: cluster.denominator === null
      ? 'an observed condition of limited extent'
      : `observed on ${cluster.numerator} of ${cluster.denominator}, not a majority`,
  };
}
