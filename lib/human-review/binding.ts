// Human Review & Approval v0.1 — deterministic binding comparison.
//
// The TOCTOU defence. A decision carries four bindings plus two contract
// versions; this compares them against a FRESHLY derived packet. Any mismatch
// is named. Nothing ever "approves whatever is latest".

import { reviewPacketHash } from './packet-hash';
import {
  ACCEPTED_OPPORTUNITY_REVIEW_VERSION,
  ACCEPTED_QUALIFICATION_VERSION,
  EXTERNALLY_PRESENTABLE_PERMISSIONS,
  REQUIRED_QUALIFICATION_STATUS,
  TEMPORAL_FRAME,
} from './versions';
import type { BindingComparison, ReviewDecisionRecord, ReviewPacketView } from './types';

/**
 * Compares a supplied decision's bindings to the current packet.
 *
 * Outcome precedence is deliberate and ordered most- to least-specific:
 * a different opportunity is not "stale evidence", and a version
 * incompatibility is reported before a hash difference it would itself cause.
 */
export function compareBinding(
  decision: Pick<ReviewDecisionRecord,
    'opportunityKey' | 'evidenceFingerprint' | 'claimHash' | 'reviewPacketHash'
    | 'reviewContractVersion' | 'qualificationVersion'>,
  packet: ReviewPacketView,
): BindingComparison {
  const mismatches: string[] = [];
  const currentPacketHash = reviewPacketHash(packet);

  if (decision.opportunityKey !== packet.opportunityKey) {
    mismatches.push(`opportunityKey ${decision.opportunityKey} -> ${packet.opportunityKey}`);
    return { outcome: 'OPPORTUNITY_CHANGED', mismatches };
  }

  if (decision.reviewContractVersion !== packet.reviewContractVersion
    || decision.qualificationVersion !== packet.qualificationVersion
    || packet.reviewContractVersion !== ACCEPTED_OPPORTUNITY_REVIEW_VERSION
    || packet.qualificationVersion !== ACCEPTED_QUALIFICATION_VERSION) {
    mismatches.push(
      `contract versions decision(${decision.reviewContractVersion}/${decision.qualificationVersion})`
      + ` packet(${packet.reviewContractVersion}/${packet.qualificationVersion})`
      + ` accepted(${ACCEPTED_OPPORTUNITY_REVIEW_VERSION}/${ACCEPTED_QUALIFICATION_VERSION})`);
    return { outcome: 'VERSION_INCOMPATIBLE', mismatches };
  }

  // The current packet must still be in a state that could support external
  // presentation at all. Checked before hash differences so the reason reported
  // is the substantive one.
  if (packet.qualificationStatus !== REQUIRED_QUALIFICATION_STATUS) {
    mismatches.push(`qualificationStatus is ${packet.qualificationStatus}`);
    return { outcome: 'INVALID_CURRENT_STATE', mismatches };
  }
  if (!EXTERNALLY_PRESENTABLE_PERMISSIONS.includes(packet.presentationPermission)) {
    mismatches.push(`presentationPermission ${packet.presentationPermission} does not permit external use`);
    return { outcome: 'INVALID_CURRENT_STATE', mismatches };
  }
  if (packet.temporalFrame !== TEMPORAL_FRAME) {
    mismatches.push(`temporalFrame ${packet.temporalFrame} is not ${TEMPORAL_FRAME}`);
    return { outcome: 'INVALID_CURRENT_STATE', mismatches };
  }

  if (decision.evidenceFingerprint !== packet.evidenceFingerprint) {
    mismatches.push(`evidenceFingerprint ${decision.evidenceFingerprint} -> ${packet.evidenceFingerprint}`);
    return { outcome: 'STALE_EVIDENCE', mismatches };
  }

  if (decision.claimHash !== packet.claimHash) {
    mismatches.push(`claimHash ${decision.claimHash} -> ${packet.claimHash}`);
    return { outcome: 'CLAIM_CHANGED', mismatches };
  }

  if (decision.reviewPacketHash !== currentPacketHash) {
    mismatches.push(`reviewPacketHash ${decision.reviewPacketHash} -> ${currentPacketHash}`);
    return { outcome: 'PACKET_CHANGED', mismatches };
  }

  return { outcome: 'EXACT', mismatches: [] };
}
