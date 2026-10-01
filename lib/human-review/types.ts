// Human Review & Approval v0.1 — types.
//
// Pure and derive-only. There is no mutable approval state anywhere: no
// `approved`, `rejected`, `revoked`, `current` or `active` boolean. Status is
// always derived from immutable decisions plus the current packet binding.

import type { ReviewerCapability, TrustedReviewerIdentity } from './future-identity';
import type { APPROVABLE_DEMONSTRABILITY, APPROVABLE_PRESENTATION_MODE, TEMPORAL_FRAME } from './versions';

// ── decision vocabulary ──────────────────────────────────────

/**
 * Exactly three kinds. `APPROVE_WITH_EDIT` and `REQUEST_MORE_EVIDENCE` are
 * absent by design — not placeholders for later convenience.
 */
export type ReviewDecisionType = 'APPROVE_PRESENTATION' | 'REJECT' | 'REVOKE';

export type RejectionReason =
  | 'insufficient_presentation_evidence'
  | 'claim_not_suitable_for_external_use'
  | 'scope_or_wording_concern'
  | 'evidence_not_convincing'
  | 'other_bounded';

// ── structural view of the packet this layer is handed ───────

/** Minimal structural view. No import from lib/opportunity-review. */
export interface ReviewPacketView {
  opportunityKey: string;
  evidenceFingerprint: string;
  claimHash: string;
  qualificationStatus: string;
  gateTrace: { gate: string; passed: boolean }[];
  presentationPermission: string;
  presentationMode: string;
  demonstrabilityStatus: string;
  meetsScoutEvidenceRequirements: boolean;
  temporalFrame: string;
  reviewContractVersion: string;
  qualificationVersion: string;
  evidenceRefs: EvidenceRefView[];
  /** Display prose. Deliberately NOT part of packet identity. */
  displayProse: string;
  /** Carried through to a snapshot; never re-derived here. */
  canonicalClaim: unknown;
  demonstration: unknown;
  observedAt: string | null;
  scanId: string;
}

export interface EvidenceRefView {
  kind: string;
  scanId: string;
  subjectUrl: string;
  engine: string | null;
  engineVersion: string | null;
  contentSha256: string | null;
  scope: string;
  observedAt: string | null;
}

// ── immutable supplied decision ──────────────────────────────

/**
 * Immutable supplied decision data. Phase 2a never creates one: a decision is
 * supplied by a future server boundary, or by an isolated test-only builder.
 */
export interface ReviewDecisionRecord {
  reviewDecisionId: string;
  requestId: string;
  decisionType: ReviewDecisionType;
  reviewerId: TrustedReviewerIdentity;
  reviewerCapability: ReviewerCapability;

  opportunityKey: string;
  evidenceFingerprint: string;
  claimHash: string;
  reviewPacketHash: string;

  reviewContractVersion: string;
  qualificationVersion: string;
  hraVersion: string;

  presentationMode: string;
  demonstrability: string;
  temporalFrame: string;

  decisionTimestamp: string;
  /** Audit evidence only — never claim identity. */
  reviewedProseHash: string;

  /** Present only on REJECT. */
  structuredRejectionReason?: RejectionReason;
  /** Bounded plain text, optional, never externally presentable. */
  boundedReviewerNote?: string;
  /** Present only on REVOKE — the decision whose use is being revoked. */
  revokesReviewDecisionId?: string;
}

// ── binding comparison ───────────────────────────────────────

export type BindingOutcome =
  | 'EXACT'
  | 'OPPORTUNITY_CHANGED'
  | 'STALE_EVIDENCE'
  | 'CLAIM_CHANGED'
  | 'PACKET_CHANGED'
  | 'VERSION_INCOMPATIBLE'
  | 'INVALID_CURRENT_STATE';

export interface BindingComparison {
  outcome: BindingOutcome;
  /** Ordered, deterministic. Empty when EXACT. */
  mismatches: string[];
}

// ── approval eligibility ─────────────────────────────────────

export type EligibilityOutcome = 'ELIGIBLE_FOR_HUMAN_APPROVAL' | 'NOT_ELIGIBLE_FOR_HUMAN_APPROVAL';

/**
 * Eligibility means a human MAY be asked. It never means approved: the machine
 * cannot create a human decision.
 */
export interface ApprovalEligibility {
  outcome: EligibilityOutcome;
  /** Ordered, deterministic. Empty when eligible. */
  blockingReasons: string[];
  /** Always false in this layer. */
  impliesApproval: false;
}

// ── derived status ───────────────────────────────────────────

export type DecisionStatus =
  | 'UNREVIEWED'
  | 'APPROVED_CURRENT'
  | 'REJECTED_CURRENT'
  | 'REVOKED'
  | 'SUPERSEDED'
  | 'STALE'
  | 'INVALID';

export interface DerivedStatus {
  status: DecisionStatus;
  /** The decision the status was derived from, if any. */
  decisionId: string | null;
  reason: string;
  /** Deterministic ordering is by (decisionTimestamp, reviewDecisionId). */
  consideredDecisionIds: string[];
}

// ── idempotency ──────────────────────────────────────────────

export type IdempotencyOutcome = 'SAME_LOGICAL_DECISION' | 'IDEMPOTENCY_CONFLICT' | 'NEW_DECISION_ALLOWED';

export interface IdempotencyComparison {
  outcome: IdempotencyOutcome;
  reason: string;
  /** Hash of the canonical payload considered for comparison. */
  canonicalPayloadHash: string;
}

// ── validation ───────────────────────────────────────────────

export type DecisionValidationCode =
  | 'unknown_decision_type'
  | 'missing_binding_field'
  | 'capability_not_recorded'
  | 'hra_version_mismatch'
  | 'review_contract_version_mismatch'
  | 'qualification_version_mismatch'
  | 'temporal_frame_not_current_state'
  | 'approve_requires_demonstration_mode'
  | 'approve_requires_demonstrable'
  | 'reject_requires_structured_reason'
  | 'reject_reason_not_in_vocabulary'
  | 'approve_must_not_carry_rejection_reason'
  | 'revoke_requires_target_decision'
  | 'non_revoke_must_not_carry_revoke_target'
  | 'note_too_long'
  | 'note_contains_markup'
  | 'note_contains_control_characters'
  | 'reviewed_prose_hash_missing'
  | 'forbidden_reviewer_identity'
  | 'timestamp_not_iso';

export interface DecisionValidation {
  valid: boolean;
  failures: { code: DecisionValidationCode; detail: string }[];
}

// ── snapshot ─────────────────────────────────────────────────

export type SnapshotDerivationCode =
  | 'decision_invalid'
  | 'decision_not_approval'
  | 'binding_not_exact'
  | 'packet_not_approvable'
  | 'decision_not_current'
  | 'snapshot_id_not_supplied';

/**
 * Immutable approved presentation truth. References plus bounded fields — never
 * a duplicated ReviewPacket, never raw HTML, prose beyond the bounded audit
 * record, credentials, tokens, contact PII or CRM data.
 */
export interface PresentationSnapshotRecord {
  presentationSnapshotId: string;
  reviewDecisionId: string;

  opportunityKey: string;
  evidenceFingerprint: string;
  claimHash: string;
  reviewPacketHash: string;

  canonicalClaim: unknown;
  reviewedProseHash: string;
  supportingEvidenceRefsDigest: string;
  demonstration: unknown;

  presentationMode: typeof APPROVABLE_PRESENTATION_MODE;
  demonstrability: typeof APPROVABLE_DEMONSTRABILITY;
  observedAt: string | null;
  temporalFrame: typeof TEMPORAL_FRAME;

  reviewContractVersion: string;
  qualificationVersion: string;
  hraVersion: string;
  sourceScanId: string;
}

export interface SnapshotDerivation {
  snapshot: PresentationSnapshotRecord | null;
  failures: { code: SnapshotDerivationCode; detail: string }[];
}

/** Whether an existing snapshot may currently be consumed by a later layer. */
export type ConsumabilityStatus = 'CONSUMABLE' | 'NOT_CONSUMABLE';

export interface SnapshotConsumability {
  status: ConsumabilityStatus;
  reason: string;
}
