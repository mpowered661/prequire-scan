// Opportunity Review & Presentation v0.1 — entry to review.
//
// Not every qualification result becomes a review packet. These rules derive
// purely from qualification semantics — there is no per-subject, per-domain or
// per-count special case anywhere.
//
// The queue must not become the bypass: a non-qualified or externally
// ineligible opportunity never reaches a human.

import { isExternallyPresentable } from './permissions';
import type { PresentationPermission, ReviewEligibility, UncertaintyCode } from './types';

export interface EligibilityInput {
  qualificationStatus: string;
  outreachSuitability: string;
  /** Permissions of every claim on the opportunity. */
  claimPermissions: readonly PresentationPermission[];
  polarity: string;
  firstFailedGate: string | null;
}

export function reviewEligibilityOf(input: EligibilityInput): ReviewEligibility {
  const blockingReasons: string[] = [];

  if (input.qualificationStatus !== 'QUALIFIED') {
    blockingReasons.push(
      `opportunity is ${input.qualificationStatus}` +
      (input.firstFailedGate ? ` (first failed gate ${input.firstFailedGate})` : ''),
    );
  }
  if (input.polarity !== 'adverse') {
    blockingReasons.push(`polarity is ${input.polarity}; only an adverse condition can be reviewed for presentation`);
  }
  if (input.outreachSuitability === 'NOT_ELIGIBLE') {
    blockingReasons.push('qualification marked the opportunity NOT_ELIGIBLE for external use');
  }
  if (!input.claimPermissions.some(isExternallyPresentable)) {
    blockingReasons.push('no externally presentable claim exists');
  }

  return {
    entry: blockingReasons.length === 0 ? 'ELIGIBLE_FOR_REVIEW' : 'NOT_ELIGIBLE_FOR_REVIEW',
    blockingReasons,
  };
}

export interface UncertaintyInput {
  siteTotalKnown: boolean;
  scopeLevel: string;
  presentationEvidenceAvailable: boolean;
  requiresAdditionalContext: boolean;
  undeterminableCountPresent: boolean;
  remediationClass: string | null;
  populationCount: number;
}

/** Drawn from a frozen enumeration, never written freely. */
export function uncertaintiesOf(input: UncertaintyInput): UncertaintyCode[] {
  const out: UncertaintyCode[] = [];
  if (!input.siteTotalKnown) out.push('site_total_unknown');
  if (input.scopeLevel === 'analyzed_sample' || input.scopeLevel === 'checked_targets') {
    out.push('sampled_population_only');
  }
  if (!input.presentationEvidenceAvailable) out.push('presentation_evidence_absent');
  if (input.requiresAdditionalContext) out.push('condition_requires_context');
  if (input.undeterminableCountPresent) out.push('undeterminable_measurements_present');
  out.push('single_scan_only');
  if (input.remediationClass === 'content_entity_clarification') out.push('remediation_class_generic');
  if (input.populationCount > 1) out.push('denominators_differ_across_claim');
  return [...new Set(out)].sort();
}
