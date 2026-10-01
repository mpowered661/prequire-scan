// Opportunity Review & Presentation v0.1 — presentation permission (axis 2).
//
// Deterministic, not discretionary. Kept strictly separate from the epistemic
// class (axis 1): the two are never collapsed.

import { REQUIRED_CONTEXT_MARKER } from './versions';
import type { EpistemicClass, PresentationPermission } from './types';

export interface PermissionInput {
  epistemicClass: EpistemicClass;
  /** Qualification status of the owning opportunity. */
  qualificationStatus: string;
  /** Qualification outreach suitability of the owning opportunity. */
  outreachSuitability: string;
  /** Whether the claim carries required context inline. */
  carriesRequiredContext: boolean;
}

/**
 * v0.1 interface limitation: qualification embeds required context inline in the
 * claim text rather than exposing a structured flag, so this layer detects it by
 * a single bounded marker constant. Recorded rather than solved by duplicating
 * the qualification catalog here.
 */
export function carriesRequiredContext(claimText: string): boolean {
  return claimText.includes(REQUIRED_CONTEXT_MARKER);
}

export function presentationPermissionOf(input: PermissionInput): PresentationPermission {
  // A claim on a non-qualified opportunity is never presentable, whatever it says.
  if (input.qualificationStatus !== 'QUALIFIED') return 'NOT_PRESENTABLE';
  // Qualification already refused this opportunity for external use.
  if (input.outreachSuitability === 'NOT_ELIGIBLE') return 'NOT_PRESENTABLE';

  switch (input.epistemicClass) {
    case 'PROHIBITED':
      return 'NOT_PRESENTABLE';
    case 'HYPOTHESIS':
      // Internal only, always — a hypothesis may inform a reviewer and may
      // never leave the system.
      return 'INTERNAL_ONLY';
    case 'DIRECT_OBSERVATION':
      return input.carriesRequiredContext ? 'PRESENTABLE_WITH_QUALIFIER' : 'PRESENTABLE';
    case 'BOUNDED_INTERPRETATION':
      return 'PRESENTABLE';
    default:
      // Fail closed on an unknown epistemic class.
      return 'NOT_PRESENTABLE';
  }
}

export function isExternallyPresentable(p: PresentationPermission): boolean {
  return p === 'PRESENTABLE' || p === 'PRESENTABLE_WITH_QUALIFIER';
}
