// The ONE production ReviewPacket -> ReviewPacketView adapter.
//
// The accepted Opportunity Review layer (or-0.1) produces `ReviewPacket`. Every
// frozen Human Review function consumes `ReviewPacketView`. Until now that
// conversion existed only in three test files, which meant the production trust
// path had no way to reach the frozen layer at all.
//
// THIS CONVERSION IS IDENTITY-BEARING. `reviewPacketHash` is computed FROM the
// view, so a change here silently changes packet identity and would invalidate
// every accepted approval binding. It is therefore a faithful transcription of
// the accepted rule and nothing more: no policy, no normalization, no
// "improvement". The calibration test pins all seven accepted Michael hashes.
//
// No client input and no database input participates. Given the same packet it
// returns the same view.

import type { ClaimCandidate, ReviewPacket } from '../opportunity-review/types';
import type { ReviewPacketView } from '../human-review/types';

/**
 * The accepted claim-candidate selection rule, transcribed verbatim from the
 * three test adapters, which were verified byte-equivalent in behaviour before
 * this module was written.
 *
 * It selects the first DIRECT_OBSERVATION candidate that is externally
 * presentable, falling back to the first candidate. The choice supplies
 * `presentationPermission` — WHICH IS ONE OF THE THIRTEEN PACKET HASH INPUTS —
 * and `displayProse`, from which `reviewedProseHash` is later derived.
 *
 * Do not reinterpret this rule without a versioned repair: it moves hashes.
 */
export function selectDirectClaimCandidate(packet: ReviewPacket): ClaimCandidate {
  return packet.claimCandidates.find(
    c => c.epistemicClass === 'DIRECT_OBSERVATION' && c.externallyPresentable,
  ) ?? packet.claimCandidates[0];
}

/**
 * Converts an accepted or-0.1 ReviewPacket into the frozen HRA structural view.
 *
 * Every field is copied straight across; `gateTrace` is narrowed to the two
 * fields the view declares, and the three view fields that come from elsewhere
 * in the packet are taken from their accepted sources:
 *   presentationPermission <- the selected claim candidate
 *   displayProse           <- the selected claim candidate's prose
 *   demonstrabilityStatus  <- packet.demonstration.status
 *   temporalFrame          <- packet.canonicalClaim.temporalFrame
 *   observedAt             <- packet.canonicalClaim.observedAt
 */
export function toReviewPacketView(packet: ReviewPacket): ReviewPacketView {
  const direct = selectDirectClaimCandidate(packet);
  return {
    opportunityKey: packet.opportunityKey,
    evidenceFingerprint: packet.evidenceFingerprint,
    claimHash: packet.claimHash,
    qualificationStatus: packet.qualificationStatus,
    gateTrace: packet.gateTrace.map(g => ({ gate: g.gate, passed: g.passed })),
    presentationPermission: direct.presentationPermission,
    presentationMode: packet.presentationMode,
    demonstrabilityStatus: packet.demonstration.status,
    meetsScoutEvidenceRequirements: packet.meetsScoutEvidenceRequirements,
    temporalFrame: packet.canonicalClaim.temporalFrame,
    reviewContractVersion: packet.reviewContractVersion,
    qualificationVersion: packet.qualificationVersion,
    evidenceRefs: packet.evidenceRefs,
    displayProse: direct.prose,
    canonicalClaim: packet.canonicalClaim,
    demonstration: packet.demonstration,
    observedAt: packet.canonicalClaim.observedAt,
    scanId: packet.scanId,
  };
}
