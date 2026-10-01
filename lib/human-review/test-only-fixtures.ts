// TEST-ONLY fixtures for Human Review & Approval v0.1.
//
// ████████████████████████████████████████████████████████████████████████
// ██  UNSAFE. TEST CODE ONLY. NEVER IMPORT THIS FROM PRODUCTION CODE.    ██
// ████████████████████████████████████████████████████████████████████████
//
// This file contains the ONLY place in the repository where a
// `TrustedReviewerIdentity` is produced, and it does so by a deliberate type
// assertion. That assertion is legitimate here and nowhere else: these values
// stand in for an identity that a FUTURE authenticated server boundary
// (Phase 2b) would have verified.
//
// Production modules must never import from this file. The adversarial suite
// asserts that no production module under lib/human-review/ references it, and
// asserts that no production factory exists.
//
// NOTHING HERE IMPLIES THAT AN ARBITRARY STRING IS TRUSTWORTHY IN PRODUCTION.
// No real human approval is represented by any fixture built here.

import { reviewedProseHash, reviewPacketHash } from './packet-hash';
import {
  ACCEPTED_OPPORTUNITY_REVIEW_VERSION,
  ACCEPTED_QUALIFICATION_VERSION,
  HRA_VERSION,
  PRESENTATION_APPROVE_CAPABILITY,
  TEMPORAL_FRAME,
} from './versions';
import type { ReviewerCapability, TrustedReviewerIdentity } from './future-identity';
import type { ReviewDecisionRecord, ReviewDecisionType, ReviewPacketView } from './types';

/**
 * UNSAFE TEST-ONLY. Mints a TrustedReviewerIdentity by assertion.
 *
 * The name is deliberately alarming so it cannot appear in production review
 * without comment.
 */
export function UNSAFE_testOnlyTrustedReviewer(value: string): TrustedReviewerIdentity {
  return value as unknown as TrustedReviewerIdentity;
}

/** A hypothetical operator. Placeholder only; no real person, no real approval. */
export const PLACEHOLDER_OPERATOR = UNSAFE_testOnlyTrustedReviewer(
  'PLACEHOLDER-OPERATOR-00000000-0000-4000-8000-000000000001',
);

export interface DecisionFixtureOptions {
  decisionType: ReviewDecisionType;
  packet: ReviewPacketView;
  reviewDecisionId?: string;
  requestId?: string;
  reviewer?: TrustedReviewerIdentity;
  capability?: ReviewerCapability | string;
  decisionTimestamp?: string;
  structuredRejectionReason?: ReviewDecisionRecord['structuredRejectionReason'];
  boundedReviewerNote?: string;
  revokesReviewDecisionId?: string;
  /** Overrides for adversarial cases. */
  override?: Partial<ReviewDecisionRecord>;
}

/**
 * UNSAFE TEST-ONLY. Builds an immutable decision record as a future server
 * boundary would have supplied it, with the bindings taken from the packet so
 * the happy path is exact by construction.
 */
export function UNSAFE_testOnlyDecision(opts: DecisionFixtureOptions): ReviewDecisionRecord {
  const { packet } = opts;
  const base: ReviewDecisionRecord = {
    reviewDecisionId: opts.reviewDecisionId ?? 'PLACEHOLDER-DECISION-0001',
    requestId: opts.requestId ?? 'PLACEHOLDER-REQUEST-0001',
    decisionType: opts.decisionType,
    reviewerId: opts.reviewer ?? PLACEHOLDER_OPERATOR,
    reviewerCapability: (opts.capability ?? PRESENTATION_APPROVE_CAPABILITY) as ReviewerCapability,

    opportunityKey: packet.opportunityKey,
    evidenceFingerprint: packet.evidenceFingerprint,
    claimHash: packet.claimHash,
    reviewPacketHash: reviewPacketHash(packet),

    reviewContractVersion: ACCEPTED_OPPORTUNITY_REVIEW_VERSION,
    qualificationVersion: ACCEPTED_QUALIFICATION_VERSION,
    hraVersion: HRA_VERSION,

    presentationMode: packet.presentationMode,
    demonstrability: packet.demonstrabilityStatus,
    temporalFrame: TEMPORAL_FRAME,

    decisionTimestamp: opts.decisionTimestamp ?? '2026-09-30T18:00:00.000Z',
    reviewedProseHash: reviewedProseHash(packet.displayProse),
  } as ReviewDecisionRecord;

  if (opts.structuredRejectionReason !== undefined) base.structuredRejectionReason = opts.structuredRejectionReason;
  if (opts.boundedReviewerNote !== undefined) base.boundedReviewerNote = opts.boundedReviewerNote;
  if (opts.revokesReviewDecisionId !== undefined) base.revokesReviewDecisionId = opts.revokesReviewDecisionId;

  return { ...base, ...(opts.override ?? {}) };
}
