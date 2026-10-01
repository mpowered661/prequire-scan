// Human Review & Approval v0.1 — pure idempotency comparison.
//
// Compares an incoming decision request against an existing decision that
// shares its requestId. Writes nothing, generates no identifier, performs no
// retry.

import { createHash } from 'node:crypto';
import type { IdempotencyComparison, ReviewDecisionRecord } from './types';

/**
 * The CANONICAL DECISION PAYLOAD — exactly the fields whose change would make
 * this a materially different human decision.
 *
 * INCLUDED: decisionType, reviewerId, the four bindings, the three contract
 * versions, presentationMode, demonstrability, temporalFrame,
 * reviewedProseHash, structuredRejectionReason, boundedReviewerNote,
 * revokesReviewDecisionId.
 *
 * EXCLUDED as transient request metadata: reviewDecisionId (durable identity
 * assigned per decision, not part of intent) and decisionTimestamp (when the
 * click landed does not change what was decided; a retry seconds later is the
 * same decision).
 */
export function canonicalDecisionPayload(d: ReviewDecisionRecord): string {
  const ordered = {
    boundedReviewerNote: d.boundedReviewerNote ?? null,
    claimHash: d.claimHash,
    decisionType: d.decisionType,
    demonstrability: d.demonstrability,
    evidenceFingerprint: d.evidenceFingerprint,
    hraVersion: d.hraVersion,
    opportunityKey: d.opportunityKey,
    presentationMode: d.presentationMode,
    qualificationVersion: d.qualificationVersion,
    reviewContractVersion: d.reviewContractVersion,
    reviewPacketHash: d.reviewPacketHash,
    reviewedProseHash: d.reviewedProseHash,
    reviewerCapability: d.reviewerCapability,
    reviewerId: d.reviewerId as string,
    revokesReviewDecisionId: d.revokesReviewDecisionId ?? null,
    structuredRejectionReason: d.structuredRejectionReason ?? null,
    temporalFrame: d.temporalFrame,
  };
  return JSON.stringify(ordered);
}

export function canonicalDecisionPayloadHash(d: ReviewDecisionRecord): string {
  return createHash('sha256').update(canonicalDecisionPayload(d)).digest('hex').slice(0, 32);
}

/** The fields participating in idempotency, exported so a test can assert them. */
export const CANONICAL_PAYLOAD_FIELDS: readonly string[] = Object.freeze([
  'decisionType', 'reviewerId', 'reviewerCapability',
  'opportunityKey', 'evidenceFingerprint', 'claimHash', 'reviewPacketHash',
  'reviewContractVersion', 'qualificationVersion', 'hraVersion',
  'presentationMode', 'demonstrability', 'temporalFrame',
  'reviewedProseHash', 'structuredRejectionReason', 'boundedReviewerNote',
  'revokesReviewDecisionId',
]);

export const EXCLUDED_FROM_CANONICAL_PAYLOAD: readonly string[] = Object.freeze([
  'reviewDecisionId', 'requestId', 'decisionTimestamp',
]);

/**
 * Pure comparison. `existing` is the decision already recorded under the
 * incoming requestId, or null when the requestId has not been seen.
 */
export function compareIdempotency(
  incoming: ReviewDecisionRecord,
  existing: ReviewDecisionRecord | null,
): IdempotencyComparison {
  const incomingHash = canonicalDecisionPayloadHash(incoming);
  if (existing === null) {
    return {
      outcome: 'NEW_DECISION_ALLOWED',
      reason: 'requestId has not been seen',
      canonicalPayloadHash: incomingHash,
    };
  }
  if (existing.requestId !== incoming.requestId) {
    return {
      outcome: 'NEW_DECISION_ALLOWED',
      reason: 'different requestId; a genuinely new later decision is permitted',
      canonicalPayloadHash: incomingHash,
    };
  }
  const existingHash = canonicalDecisionPayloadHash(existing);
  if (existingHash === incomingHash) {
    return {
      outcome: 'SAME_LOGICAL_DECISION',
      reason: 'same requestId and identical canonical payload',
      canonicalPayloadHash: incomingHash,
    };
  }
  return {
    outcome: 'IDEMPOTENCY_CONFLICT',
    reason: `same requestId with a different canonical payload (${existingHash} -> ${incomingHash})`,
    canonicalPayloadHash: incomingHash,
  };
}
