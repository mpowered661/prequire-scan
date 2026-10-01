// Opportunity Review & Presentation v0.1 — demonstrability.
//
// Qualification answers "is the condition real?". This answers "can it be shown
// to the owner without inventing, reconstructing or refetching anything?".
// Those are different questions, and Tranche D2 deliberately made the second
// harder in exchange for data minimization.

import { CONTEXT_DEPENDENT_DETECTORS, REPRODUCTION_METHODS } from './versions';
import { normalizeRefs } from './canonical-claim';
import type {
  DemonstrabilityStatus,
  DemonstrationEvidence,
  EvidenceRefView,
  PresentationMode,
  ReproductionMethod,
} from './types';

export interface DemonstrabilityInput {
  detector: string;
  /** Qualification's own determination. Authoritative when false. */
  presentationEvidenceAvailable: boolean;
  presentationEvidenceReason: string;
  evidenceRefs: EvidenceRefView[];
}

export function reproductionMethodOf(detector: string): ReproductionMethod {
  return (REPRODUCTION_METHODS as Record<string, ReproductionMethod>)[detector] ?? 'none_available';
}

/**
 * An adverse engine verdict is NOT demonstrable merely because it is adverse.
 * Qualification is authoritative when it says no showable instance was retained;
 * this layer only decides DEMONSTRABLE vs LIMITED when one was.
 */
export function demonstrabilityOf(input: DemonstrabilityInput): DemonstrationEvidence {
  const method = reproductionMethodOf(input.detector);
  const requiresAdditionalContext = CONTEXT_DEPENDENT_DETECTORS.includes(input.detector);

  let status: DemonstrabilityStatus;
  if (!input.presentationEvidenceAvailable || method === 'none_available') {
    status = 'NOT_DEMONSTRABLE';
  } else if (requiresAdditionalContext) {
    status = 'LIMITED_DEMONSTRABILITY';
  } else {
    status = 'DEMONSTRABLE';
  }

  return {
    status,
    // Carried verbatim from qualification; never rewritten or softened.
    reason: input.presentationEvidenceReason,
    reproductionMethod: status === 'NOT_DEMONSTRABLE' ? 'none_available' : method,
    showableRefs: status === 'NOT_DEMONSTRABLE' ? [] : normalizeRefs(input.evidenceRefs),
    requiresAdditionalContext,
  };
}

export function presentationModeOf(status: DemonstrabilityStatus): PresentationMode {
  return status === 'DEMONSTRABLE' ? 'STATEMENT_WITH_DEMONSTRATION' : 'STATEMENT_ONLY';
}

/**
 * Whether this packet has the technical characteristics required to enter a
 * FUTURE Scout approval flow. This is NOT approval — not for Scout, not for
 * presentation, not for outreach, not for sending, not commercially.
 *
 * "SHOW, DON'T MERELY ASSERT": the initial Scout path is demonstration-first,
 * so STATEMENT_ONLY does not meet the requirement. STATEMENT_ONLY remains valid
 * reviewable intelligence and is never discarded.
 */
export function meetsScoutEvidenceRequirements(mode: PresentationMode): boolean {
  return mode === 'STATEMENT_WITH_DEMONSTRATION';
}
