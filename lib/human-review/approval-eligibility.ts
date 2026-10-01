// Human Review & Approval v0.1 — approval eligibility.
//
// CRITICAL SEMANTICS: this answers "may a human be ASKED to approve?" It never
// answers "is this approved?" The machine cannot create a human decision, and
// `impliesApproval` is a literal `false` on every result so a consumer cannot
// mistake eligibility for approval.

import {
  APPROVABLE_DEMONSTRABILITY,
  APPROVABLE_PRESENTATION_MODE,
  EXTERNALLY_PRESENTABLE_PERMISSIONS,
  REQUIRED_QUALIFICATION_STATUS,
  TEMPORAL_FRAME,
} from './versions';
import type { ApprovalEligibility, ReviewPacketView } from './types';

/**
 * Derives whether a packet has the technical characteristics required before a
 * human may be asked for an APPROVE_PRESENTATION decision.
 *
 * STATEMENT_ONLY packets are NOT approvable in v0.1. They remain reviewable,
 * derivable and visible to this layer — they are never discarded, and nothing
 * here converts them to a demonstration mode.
 */
export function deriveApprovalEligibility(packet: ReviewPacketView): ApprovalEligibility {
  const blockingReasons: string[] = [];

  if (packet.qualificationStatus !== REQUIRED_QUALIFICATION_STATUS) {
    blockingReasons.push(`qualificationStatus is ${packet.qualificationStatus}`);
  }
  if (!EXTERNALLY_PRESENTABLE_PERMISSIONS.includes(packet.presentationPermission)) {
    blockingReasons.push(`presentationPermission ${packet.presentationPermission} does not permit external use`);
  }
  if (packet.presentationMode !== APPROVABLE_PRESENTATION_MODE) {
    blockingReasons.push(`statement_only_not_approvable_in_v0_1: presentationMode is ${packet.presentationMode}`);
  }
  if (packet.demonstrabilityStatus !== APPROVABLE_DEMONSTRABILITY) {
    blockingReasons.push(`demonstrability is ${packet.demonstrabilityStatus}, not ${APPROVABLE_DEMONSTRABILITY}`);
  }
  if (packet.meetsScoutEvidenceRequirements !== true) {
    blockingReasons.push('meetsScoutEvidenceRequirements is false');
  }
  if (packet.temporalFrame !== TEMPORAL_FRAME) {
    blockingReasons.push(`temporalFrame ${packet.temporalFrame} is not ${TEMPORAL_FRAME}`);
  }

  return {
    outcome: blockingReasons.length === 0 ? 'ELIGIBLE_FOR_HUMAN_APPROVAL' : 'NOT_ELIGIBLE_FOR_HUMAN_APPROVAL',
    blockingReasons,
    // Eligibility is never approval. A human decision must be supplied.
    impliesApproval: false,
  };
}
