// Human Review & Approval v0.1 — decision validation and status derivation.
//
// Status is DERIVED from immutable decisions plus the current packet binding.
// Nothing is persisted and no mutable flag exists.
//
// There is deliberately no `approve()`, `autoApprove()`, `createApproval()` or
// `approveIfEligible()`. A ReviewDecision must be SUPPLIED.

import { compareBinding } from './binding';
import { recordsRequiredCapability } from './future-identity';
import { reviewerIdentityValue } from './future-identity';
import {
  ACCEPTED_OPPORTUNITY_REVIEW_VERSION,
  ACCEPTED_QUALIFICATION_VERSION,
  APPROVABLE_DEMONSTRABILITY,
  APPROVABLE_PRESENTATION_MODE,
  FORBIDDEN_REVIEWER_IDENTITIES,
  HRA_VERSION,
  MARKUP_PATTERN,
  MAX_REVIEWER_NOTE_CHARS,
  REJECTION_REASONS,
  TEMPORAL_FRAME,
} from './versions';
import type {
  DecisionValidation,
  DecisionValidationCode,
  DerivedStatus,
  ReviewDecisionRecord,
  ReviewPacketView,
} from './types';

const DECISION_TYPES = ['APPROVE_PRESENTATION', 'REJECT', 'REVOKE'] as const;
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/**
 * Validates a SUPPLIED immutable decision record. This is validation of data,
 * not authorization and not approval creation.
 */
export function validateReviewDecision(d: ReviewDecisionRecord): DecisionValidation {
  const failures: { code: DecisionValidationCode; detail: string }[] = [];
  const fail = (code: DecisionValidationCode, detail: string) => failures.push({ code, detail });

  if (!(DECISION_TYPES as readonly string[]).includes(d.decisionType)) {
    fail('unknown_decision_type', String(d.decisionType));
  }

  for (const [field, value] of [
    ['reviewDecisionId', d.reviewDecisionId], ['requestId', d.requestId],
    ['opportunityKey', d.opportunityKey], ['evidenceFingerprint', d.evidenceFingerprint],
    ['claimHash', d.claimHash], ['reviewPacketHash', d.reviewPacketHash],
  ] as const) {
    if (typeof value !== 'string' || value.length === 0) fail('missing_binding_field', field);
  }

  const identity = reviewerIdentityValue(d.reviewerId);
  if (typeof identity !== 'string' || identity.length === 0
    || FORBIDDEN_REVIEWER_IDENTITIES.includes(identity.trim().toLowerCase())) {
    fail('forbidden_reviewer_identity', `"${identity}" is not an acceptable reviewer identity`);
  }

  if (!recordsRequiredCapability(d.reviewerCapability)) {
    fail('capability_not_recorded', String(d.reviewerCapability));
  }

  if (d.hraVersion !== HRA_VERSION) fail('hra_version_mismatch', `${d.hraVersion} != ${HRA_VERSION}`);
  if (d.reviewContractVersion !== ACCEPTED_OPPORTUNITY_REVIEW_VERSION) {
    fail('review_contract_version_mismatch', `${d.reviewContractVersion} != ${ACCEPTED_OPPORTUNITY_REVIEW_VERSION}`);
  }
  if (d.qualificationVersion !== ACCEPTED_QUALIFICATION_VERSION) {
    fail('qualification_version_mismatch', `${d.qualificationVersion} != ${ACCEPTED_QUALIFICATION_VERSION}`);
  }
  if (d.temporalFrame !== TEMPORAL_FRAME) {
    fail('temporal_frame_not_current_state', String(d.temporalFrame));
  }
  if (!ISO_TIMESTAMP.test(d.decisionTimestamp)) {
    fail('timestamp_not_iso', d.decisionTimestamp);
  }
  if (typeof d.reviewedProseHash !== 'string' || d.reviewedProseHash.length === 0) {
    fail('reviewed_prose_hash_missing', 'reviewedProseHash is required as the audit record');
  }

  if (d.decisionType === 'APPROVE_PRESENTATION') {
    if (d.presentationMode !== APPROVABLE_PRESENTATION_MODE) {
      fail('approve_requires_demonstration_mode', `presentationMode is ${d.presentationMode}`);
    }
    if (d.demonstrability !== APPROVABLE_DEMONSTRABILITY) {
      fail('approve_requires_demonstrable', `demonstrability is ${d.demonstrability}`);
    }
    if (d.structuredRejectionReason !== undefined) {
      fail('approve_must_not_carry_rejection_reason', String(d.structuredRejectionReason));
    }
  }

  if (d.decisionType === 'REJECT') {
    if (d.structuredRejectionReason === undefined) {
      fail('reject_requires_structured_reason', 'a bounded structured reason is required');
    } else if (!REJECTION_REASONS.includes(d.structuredRejectionReason)) {
      fail('reject_reason_not_in_vocabulary', d.structuredRejectionReason);
    }
  }

  if (d.decisionType === 'REVOKE') {
    if (typeof d.revokesReviewDecisionId !== 'string' || d.revokesReviewDecisionId.length === 0) {
      fail('revoke_requires_target_decision', 'revokesReviewDecisionId is required');
    }
  } else if (d.revokesReviewDecisionId !== undefined) {
    fail('non_revoke_must_not_carry_revoke_target', String(d.revokesReviewDecisionId));
  }

  if (d.boundedReviewerNote !== undefined) {
    const note = d.boundedReviewerNote;
    // Oversized input is REJECTED, never silently truncated.
    if (note.length > MAX_REVIEWER_NOTE_CHARS) {
      fail('note_too_long', `${note.length} > ${MAX_REVIEWER_NOTE_CHARS}`);
    }
    if (MARKUP_PATTERN.test(note)) fail('note_contains_markup', 'markup or angle brackets');
    if (CONTROL_CHAR_PATTERN.test(note)) fail('note_contains_control_characters', 'control character');
  }

  return { valid: failures.length === 0, failures };
}

/**
 * Total deterministic ordering: by decisionTimestamp, then reviewDecisionId as
 * the tie-break. Never by array or insertion order.
 */
export function orderDecisions(decisions: readonly ReviewDecisionRecord[]): ReviewDecisionRecord[] {
  return [...decisions].sort((a, b) => {
    if (a.decisionTimestamp !== b.decisionTimestamp) {
      return a.decisionTimestamp < b.decisionTimestamp ? -1 : 1;
    }
    return a.reviewDecisionId < b.reviewDecisionId ? -1 : a.reviewDecisionId > b.reviewDecisionId ? 1 : 0;
  });
}

/** Decisions sharing the exact binding tuple of the supplied decision. */
function sameBindingTuple(a: ReviewDecisionRecord, b: ReviewDecisionRecord): boolean {
  return a.opportunityKey === b.opportunityKey
    && a.evidenceFingerprint === b.evidenceFingerprint
    && a.claimHash === b.claimHash
    && a.reviewPacketHash === b.reviewPacketHash;
}

/**
 * Derives the current status for one proposition from immutable decisions and
 * the freshly derived packet.
 *
 * Precedence: an explicit REVOKE outranks everything; otherwise binding
 * mismatch decides STALE vs INVALID; otherwise the latest decision for the
 * tuple decides, and earlier ones are SUPERSEDED.
 */
export function deriveDecisionStatus(
  decisions: readonly ReviewDecisionRecord[],
  packet: ReviewPacketView,
): DerivedStatus {
  const relevant = orderDecisions(
    decisions.filter(d => d.opportunityKey === packet.opportunityKey));
  const consideredDecisionIds = relevant.map(d => d.reviewDecisionId);

  if (relevant.length === 0) {
    return { status: 'UNREVIEWED', decisionId: null, reason: 'no decision for this opportunity', consideredDecisionIds };
  }

  const latest = relevant[relevant.length - 1];

  // An explicit human REVOKE removes current usability regardless of bindings.
  const revocations = relevant.filter(d => d.decisionType === 'REVOKE');
  if (revocations.length > 0) {
    const newestRevoke = revocations[revocations.length - 1];
    return {
      status: 'REVOKED',
      decisionId: newestRevoke.reviewDecisionId,
      reason: `explicitly revoked by ${newestRevoke.reviewDecisionId}`
        + (newestRevoke.revokesReviewDecisionId ? `, targeting ${newestRevoke.revokesReviewDecisionId}` : ''),
      consideredDecisionIds,
    };
  }

  const binding = compareBinding(latest, packet);
  if (binding.outcome === 'STALE_EVIDENCE') {
    return {
      status: 'STALE',
      decisionId: latest.reviewDecisionId,
      reason: `evidence binding changed: ${binding.mismatches.join('; ')}`,
      consideredDecisionIds,
    };
  }
  if (binding.outcome !== 'EXACT') {
    return {
      status: 'INVALID',
      decisionId: latest.reviewDecisionId,
      reason: `${binding.outcome}: ${binding.mismatches.join('; ')}`,
      consideredDecisionIds,
    };
  }

  // Bindings are exact. Within this tuple the latest decision is current and
  // any earlier one is superseded.
  const tuple = relevant.filter(d => sameBindingTuple(d, latest));
  const current = tuple[tuple.length - 1];
  if (current.reviewDecisionId !== latest.reviewDecisionId) {
    return {
      status: 'SUPERSEDED',
      decisionId: latest.reviewDecisionId,
      reason: `superseded by ${current.reviewDecisionId}`,
      consideredDecisionIds,
    };
  }

  if (current.decisionType === 'APPROVE_PRESENTATION') {
    return { status: 'APPROVED_CURRENT', decisionId: current.reviewDecisionId, reason: 'bindings exact and approval is latest', consideredDecisionIds };
  }
  return { status: 'REJECTED_CURRENT', decisionId: current.reviewDecisionId, reason: 'bindings exact and rejection is latest', consideredDecisionIds };
}

/**
 * Whether a specific earlier decision is superseded within its binding tuple.
 * Deterministic by (decisionTimestamp, reviewDecisionId).
 */
export function isSuperseded(
  decision: ReviewDecisionRecord,
  decisions: readonly ReviewDecisionRecord[],
): boolean {
  const tuple = orderDecisions(decisions.filter(d => sameBindingTuple(d, decision)));
  if (tuple.length === 0) return false;
  return tuple[tuple.length - 1].reviewDecisionId !== decision.reviewDecisionId;
}
