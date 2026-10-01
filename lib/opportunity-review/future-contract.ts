// Opportunity Review & Presentation v0.1 — FUTURE contract types.
//
// ReviewDecision and PresentationSnapshot are recorded here as the frozen
// contract for a LATER persistence tranche. They are deliberately made
// UNCONSTRUCTIBLE in v0.1.
//
// The mechanism is a branded reviewer identity. `TrustedReviewerIdentity` is a
// nominal type with a private brand that no function in this codebase produces.
// Because `ReviewDecision` requires one, and `PresentationSnapshot` requires a
// `ReviewDecision`, neither can be built by any derive-only function here — a
// caller would have to write a deliberate type assertion, which is visible in
// review and caught by the adversarial tests.
//
// Why: this stack has no authenticated operator identity. Per the frozen
// contract, "no durable approval without trustworthy reviewer identity."

import type { CanonicalClaim, DemonstrationEvidence, EvidenceRefView, PresentationMode, Population } from './types';

declare const TRUSTED_REVIEWER_BRAND: unique symbol;

/**
 * A Prequire OPERATOR identity, established by an authentication boundary that
 * does not exist yet. Never the observed subject, the website owner, the
 * customer, the prospect, or a scan identifier.
 *
 * No factory for this type exists, by design.
 */
export type TrustedReviewerIdentity = string & { readonly [TRUSTED_REVIEWER_BRAND]: 'authenticated_prequire_operator' };

export type ReviewDecisionKind = 'APPROVE' | 'REJECT' | 'REQUEST_MORE_EVIDENCE' | 'APPROVE_WITH_EDIT';

/**
 * FUTURE TYPE — not instantiated in v0.1.
 *
 * The approval binding is structurally fused into the decision: a decision
 * cannot exist without the evidence fingerprint and claim hash it is bound to.
 */
export interface ReviewDecision {
  opportunityKey: string;
  evidenceFingerprint: string;
  claimHash: string;
  /** Audit only. Approval validity binds `claimHash`, not the prose. */
  approvedProseHash: string;
  decision: ReviewDecisionKind;
  /** Unconstructible in v0.1 — see TrustedReviewerIdentity. */
  reviewerId: TrustedReviewerIdentity;
  decidedAt: string;
  note?: string;
  reviewContractVersion: string;
  qualificationVersion: string;
}

export type ApprovalValidity =
  | 'ACTIVE'
  | 'STALE_EVIDENCE'
  | 'STALE_CLAIM'
  | 'INVALIDATED_NOT_QUALIFIED'
  | 'INVALIDATED_CONDITION_RESOLVED'
  | 'INVALIDATED_EVIDENCE_WEAKENED';

/**
 * FUTURE TYPE — not instantiated in v0.1.
 *
 * Requires a ReviewDecision, which requires a TrustedReviewerIdentity, so this
 * is transitively unconstructible. Deliberately carries no recipient, channel,
 * CTA, send state or rendering instruction.
 */
export interface PresentationSnapshot {
  presentationSnapshotId: string;
  decision: ReviewDecision;
  canonicalClaim: CanonicalClaim;
  approvedProse: string;
  populations: Population[];
  supportingEvidenceRefs: EvidenceRefView[];
  demonstration: DemonstrationEvidence;
  permittedMode: PresentationMode;
  wordingConstraints: {
    requiredPhrases: string[];
    forbiddenTerms: string[];
    immutableFields: string[];
    maxProseChars: number;
  };
}

/**
 * Fields a future writing model may NEVER alter. Exported so the validator and
 * the tests read from one list.
 */
export const IMMUTABLE_CLAIM_FIELDS: readonly string[] = Object.freeze([
  'subject', 'scopeLevel', 'condition', 'metric', 'observedValue', 'temporalFrame',
  'populations', 'qualifiers', 'epistemicClass', 'presentationPermission',
  'detector', 'detectorVersion', 'evidenceRefsHash', 'claimType',
]);

/**
 * Deliberately absent from v0.1: any state asserting that a proposition may be
 * delivered. Exported as a negative list so a test can assert none of these
 * strings is reachable as a value anywhere in this layer.
 */
export const UNREPRESENTABLE_STATES: readonly string[] = Object.freeze([
  'APPROVED',
  'APPROVED_FOR_PRESENTATION',
  'APPROVED_FOR_OUTREACH',
  'EMAIL_READY',
  'SEND_READY',
  'CONTACT_READY',
  'CRM_READY',
]);

/** Placeholder identities that must never be accepted as a reviewer. */
export const FORBIDDEN_REVIEWER_IDENTITIES: readonly string[] = Object.freeze([
  'system', 'admin', 'human', 'reviewer', 'operator', 'prequire', 'unknown', '',
]);
