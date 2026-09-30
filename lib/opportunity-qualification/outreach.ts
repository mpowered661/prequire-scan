// Opportunity Qualification v0.1 — outreach suitability.
//
// Evaluated SEPARATELY from technical priority and never combined with it into
// one score. The highest state reachable here is ELIGIBLE_FOR_HUMAN_REVIEW,
// which is not approval: APPROVED_FOR_OUTREACH is not representable in v0.1.

import { catalogFor } from './catalog';
import { claimCarriesDenominator, claimHasBarePercentage, externallyPresentableClaims } from './claims';
import { outreachAllowedConfidence } from './confidence';
import type {
  Claim,
  EvidenceCluster,
  OutreachGateId,
  OutreachGateResult,
  OutreachGateVerdict,
  OutreachSuitability,
  QualificationStatus,
} from './types';

interface Verdict { verdict: OutreachGateVerdict; reason: string }

const GATE_NAMES: Readonly<Record<OutreachGateId, string>> = Object.freeze({
  O1: 'Claims are direct observation or approved bounded interpretation',
  O2: 'Confidence is a directly observed class',
  O3: 'Subject is specific',
  O4: 'Condition is reproducible from durable evidence',
  O5: 'Every count carries its denominator and scope word',
  O6: 'A non-specialist understands the statement',
  O7: 'A remediation class exists',
  O8: 'A verification path exists',
  O9: 'No business-impact inference is required',
  O10: 'Not misleading by omission',
});

export function evaluateOutreachGates(cluster: EvidenceCluster, claims: readonly Claim[]): OutreachGateResult[] {
  const entry = catalogFor(cluster);
  const external = externallyPresentableClaims(claims);

  const verdicts: Record<OutreachGateId, Verdict> = {
    O1: external.length === 0
      ? { verdict: 'fail', reason: 'no externally presentable claim exists' }
      : claims.some(c => c.claimClass === 'PROHIBITED')
        ? { verdict: 'fail', reason: 'a prohibited claim was generated' }
        : { verdict: 'pass', reason: `${external.length} presentable claim(s)` },

    O2: outreachAllowedConfidence(cluster.provenance)
      ? { verdict: 'pass', reason: `provenance ${cluster.provenance}` }
      : { verdict: 'fail', reason: `provenance ${cluster.provenance} is not directly observed` },

    O3: cluster.subject.trim().length > 0
      ? { verdict: 'pass', reason: `subject ${cluster.subject}` }
      : { verdict: 'fail', reason: 'no specific subject' },

    O4: cluster.determinable
      ? { verdict: 'pass', reason: 're-derivable from the same durable evidence' }
      : { verdict: 'fail', reason: 'condition is not determinable' },

    O5: external.every(c => claimCarriesDenominator(c, cluster)) && !external.some(claimHasBarePercentage)
      ? { verdict: 'pass', reason: 'all counts carry a denominator and scope word; no bare percentage' }
      : { verdict: 'fail', reason: 'a claim states a count without its denominator and scope, or uses a bare percentage' },

    O6: entry.plainLanguage
      ? { verdict: 'pass', reason: 'stated in plain language' }
      // Uncertain, not fail: a human may still judge it presentable.
      : { verdict: 'uncertain', reason: 'the statement uses engine terminology a non-specialist may not understand' },

    O7: entry.remediationClass
      ? { verdict: 'pass', reason: `remediation class ${entry.remediationClass}` }
      : { verdict: 'fail', reason: 'no remediation class' },

    O8: entry.verificationMethod
      ? { verdict: 'pass', reason: `verification method ${entry.verificationMethod}` }
      : { verdict: 'fail', reason: 'no verification path' },

    O9: entry.requiresImpactInference
      ? { verdict: 'fail', reason: 'the statement only matters to a prospect if an unsupported impact is asserted' }
      : { verdict: 'pass', reason: 'the observation stands on its own without an impact claim' },

    O10: !entry.misleadingWithoutContext
      ? { verdict: 'pass', reason: 'no additional context is required' }
      : entry.requiredContext && external.every(c => c.text.includes(entry.requiredContext!))
        ? { verdict: 'pass', reason: 'the required context is carried in the claim' }
        : { verdict: 'fail', reason: 'stating this without required context would mislead by omission' },
  };

  return (Object.keys(GATE_NAMES) as OutreachGateId[]).map(gate => ({
    gate,
    name: GATE_NAMES[gate],
    verdict: verdicts[gate].verdict,
    reason: verdicts[gate].reason,
  }));
}

/**
 * Presentation evidence availability. Recorded for a future human reviewer and
 * for a future Demonstration Evidence design. It NEVER affects qualification;
 * it can only soften outreach suitability to NEEDS_HUMAN_REVIEW.
 */
export function presentationEvidence(cluster: EvidenceCluster): { available: boolean; reason: string } {
  const entry = catalogFor(cluster);
  return { available: entry.independentlyReproducible, reason: entry.presentationReason };
}

export function outreachSuitability(
  status: QualificationStatus,
  gates: readonly OutreachGateResult[],
  presentationAvailable: boolean,
): OutreachSuitability {
  // Qualification alone never confers outreach eligibility, and a candidate
  // that did not qualify can never be outreach material.
  if (status !== 'QUALIFIED') return 'NOT_ELIGIBLE';
  if (gates.some(g => g.verdict === 'fail')) return 'NOT_ELIGIBLE';
  if (gates.some(g => g.verdict === 'uncertain')) return 'NEEDS_HUMAN_REVIEW';
  // All outreach gates pass but no externally showable instance exists, so a
  // human must decide whether it can be demonstrated.
  if (!presentationAvailable) return 'NEEDS_HUMAN_REVIEW';
  return 'ELIGIBLE_FOR_HUMAN_REVIEW';
}
