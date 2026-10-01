// Human Review & Approval v0.1 — decision validation and status derivation.
//
// Status is DERIVED from immutable decisions plus the current packet binding.
// Nothing is persisted and no mutable flag exists.
//
// There is deliberately no `approve()`, `autoApprove()`, `createApproval()` or
// `approveIfEligible()`. A ReviewDecision must be SUPPLIED.

import { compareBinding } from './binding';
import { reviewPacketHash } from './packet-hash';
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
 * Shape of a validated decision timestamp, with the fractional part captured so
 * it can be normalized to fixed precision.
 */
const TIMESTAMP_SHAPE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/;

/**
 * Normalizes a supplied ISO timestamp to fixed millisecond precision, so that
 * LEXICAL ordering equals CHRONOLOGICAL ordering.
 *
 * `validateReviewDecision` accepts both `...T18:00:00Z` and `...T18:00:00.500Z`.
 * Compared as raw strings these order wrongly, because "." (0x2E) sorts before
 * "Z" (0x5A): the chronologically later `.500Z` sorted FIRST. Equally `.1Z` and
 * `.10Z` denote the same instant but differ as strings.
 *
 * This reads SUPPLIED DATA only. It introduces no clock: no Date.now(), no
 * `new Date()`, no ambient time. A malformed value is returned unchanged so
 * ordering stays deterministic; validation is what rejects it.
 */
export function normalizedDecisionTimestamp(timestamp: string): string {
  const m = TIMESTAMP_SHAPE.exec(timestamp);
  if (!m) return timestamp;
  return `${m[1]}.${(m[2] ?? '').padEnd(3, '0')}Z`;
}

/**
 * Total deterministic ordering: by normalized decisionTimestamp, then
 * reviewDecisionId as the tie-break. Never by array or insertion order.
 */
export function orderDecisions(decisions: readonly ReviewDecisionRecord[]): ReviewDecisionRecord[] {
  return [...decisions].sort((a, b) => {
    const at = normalizedDecisionTimestamp(a.decisionTimestamp);
    const bt = normalizedDecisionTimestamp(b.decisionTimestamp);
    if (at !== bt) return at < bt ? -1 : 1;
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
 * Whether a decision's four binding fields are exactly this packet's. This is
 * the tuple comparison only — `compareBinding` additionally judges contract
 * versions and current packet state.
 */
function bindsPacketTuple(d: ReviewDecisionRecord, packet: ReviewPacketView, packetHash: string): boolean {
  return d.opportunityKey === packet.opportunityKey
    && d.evidenceFingerprint === packet.evidenceFingerprint
    && d.claimHash === packet.claimHash
    && d.reviewPacketHash === packetHash;
}

interface RevocationResolution {
  /** revoked decision id -> the id of the REVOKE that revoked it. */
  revokedBy: Map<string, string>;
  /** Revocations whose targeting is absent, unresolvable or ambiguous. */
  malformed: { revokeId: string; detail: string }[];
}

/**
 * Resolves which decisions a history's REVOKEs actually revoke.
 *
 * FROZEN SEMANTICS (hra-0.1.2): REVOKED means an explicit LATER human REVOKE,
 * and revoking DE-AUTHORIZES THE EXACT PRESENTATION BINDING rather than only
 * the one decision named. A REVOKE is well formed only when the decision it
 * NAMES exists in the considered history and is strictly EARLIER in the
 * deterministic order; it then revokes every non-REVOKE decision at or before
 * it that shares the named decision's exact binding tuple.
 *
 * That is what stops an older approval of the identical binding from silently
 * becoming current again. It stays binding-scoped, so it does not reach a
 * different evidence generation, and it does not reach decisions made AFTER the
 * revoke — a later human APPROVE_PRESENTATION is a new deliberate act.
 *
 * Anything else — no target, a target outside the considered history, a target
 * at or after the revoke, a self-target, or a target that is itself a REVOKE —
 * is ambiguous, and the caller FAILS CLOSED rather than guessing.
 *
 * Nothing is mutated: history stays append-only and prior decisions are read
 * only. The resolution is derived on every call.
 */
function resolveRevocations(ordered: readonly ReviewDecisionRecord[]): RevocationResolution {
  const positionOf = new Map<string, number>();
  ordered.forEach((d, i) => positionOf.set(d.reviewDecisionId, i));

  const revokedBy = new Map<string, string>();
  const malformed: { revokeId: string; detail: string }[] = [];

  ordered.forEach((d, i) => {
    if (d.decisionType !== 'REVOKE') return;
    const target = d.revokesReviewDecisionId;
    if (typeof target !== 'string' || target.length === 0) {
      malformed.push({ revokeId: d.reviewDecisionId, detail: 'names no target decision' });
      return;
    }
    const ti = positionOf.get(target);
    if (ti === undefined) {
      malformed.push({ revokeId: d.reviewDecisionId, detail: `names ${target}, which is not in the considered history` });
      return;
    }
    if (ti >= i) {
      malformed.push({ revokeId: d.reviewDecisionId, detail: `names ${target}, which is not strictly earlier` });
      return;
    }
    if (ordered[ti].decisionType === 'REVOKE') {
      malformed.push({ revokeId: d.reviewDecisionId, detail: `names ${target}, which is itself a REVOKE` });
      return;
    }

    // De-authorize the whole binding, not just the named decision: every
    // standing decision at or before this revoke that shares the named
    // decision's exact binding tuple.
    const named = ordered[ti];
    for (let j = 0; j <= i; j += 1) {
      const candidate = ordered[j];
      if (candidate.decisionType === 'REVOKE') continue;
      if (!sameBindingTuple(candidate, named)) continue;
      if (!revokedBy.has(candidate.reviewDecisionId)) {
        revokedBy.set(candidate.reviewDecisionId, d.reviewDecisionId);
      }
    }
  });

  return { revokedBy, malformed };
}

/**
 * Derives the current status for one proposition from immutable decisions and
 * the freshly derived packet.
 *
 * Order of reasoning:
 *   1. no decisions for this opportunity  -> UNREVIEWED
 *   2. ambiguous revocation targeting     -> REVOKED (fail closed)
 *   3. nothing left standing              -> REVOKED
 *   4. the current decision binds exactly -> APPROVED_CURRENT / REJECTED_CURRENT
 *   5. an earlier decision binds exactly  -> SUPERSEDED
 *   6. otherwise                          -> STALE or INVALID
 *
 * A prior REVOKE does not poison later legitimate approvals: once revocation is
 * resolved per named target, a newer unrevoked decision becomes current
 * normally.
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

  const { revokedBy, malformed } = resolveRevocations(relevant);
  if (malformed.length > 0) {
    return {
      status: 'REVOKED',
      decisionId: malformed[0].revokeId,
      reason: 'ambiguous revocation targeting, failing closed: '
        + malformed.map(m => `${m.revokeId} ${m.detail}`).join('; '),
      consideredDecisionIds,
    };
  }

  // Decisions that still stand: not themselves revocations, and not revoked.
  const standing = relevant.filter(d => d.decisionType !== 'REVOKE' && !revokedBy.has(d.reviewDecisionId));

  // THIS EXACT BINDING was de-authorized by an explicit REVOKE, and nothing
  // standing re-authorizes it. Reported as REVOKED rather than STALE so the
  // human revocation remains the visible reason, and so an older approval of
  // the same binding can never be read as current.
  const packetHash = reviewPacketHash(packet);
  const revokedOnThisBinding = relevant.filter(
    d => revokedBy.has(d.reviewDecisionId) && bindsPacketTuple(d, packet, packetHash));
  const standsOnThisBinding = standing.some(d => bindsPacketTuple(d, packet, packetHash));
  if (revokedOnThisBinding.length > 0 && !standsOnThisBinding) {
    const newest = revokedOnThisBinding[revokedOnThisBinding.length - 1];
    const revokingId = revokedBy.get(newest.reviewDecisionId)!;
    return {
      status: 'REVOKED',
      decisionId: revokingId,
      reason: `this exact presentation binding was de-authorized by ${revokingId}`
        + `; revoked decisions on it: ${revokedOnThisBinding.map(d => d.reviewDecisionId).join(', ')}`,
      consideredDecisionIds,
    };
  }

  if (standing.length === 0) {
    const revocations = relevant.filter(d => d.decisionType === 'REVOKE');
    const newest = revocations[revocations.length - 1];
    return {
      status: 'REVOKED',
      decisionId: newest.reviewDecisionId,
      reason: `every decision for this opportunity was explicitly revoked; newest revocation ${newest.reviewDecisionId}`
        + (newest.revokesReviewDecisionId ? `, targeting ${newest.revokesReviewDecisionId}` : ''),
      consideredDecisionIds,
    };
  }

  const current = standing[standing.length - 1];
  const binding = compareBinding(current, packet);

  if (binding.outcome === 'EXACT') {
    if (current.decisionType === 'APPROVE_PRESENTATION') {
      return { status: 'APPROVED_CURRENT', decisionId: current.reviewDecisionId, reason: 'bindings exact and approval is current', consideredDecisionIds };
    }
    return { status: 'REJECTED_CURRENT', decisionId: current.reviewDecisionId, reason: 'bindings exact and rejection is current', consideredDecisionIds };
  }

  // The current decision does not bind this packet. If an EARLIER standing
  // decision does, the decision matching this packet has been superseded by a
  // later decision for the same opportunity, and cannot authorize use.
  const matching = standing.filter(d => compareBinding(d, packet).outcome === 'EXACT');
  if (matching.length > 0) {
    const superseded = matching[matching.length - 1];
    return {
      status: 'SUPERSEDED',
      decisionId: superseded.reviewDecisionId,
      reason: `${superseded.reviewDecisionId} binds this packet exactly but was superseded by ${current.reviewDecisionId}`,
      consideredDecisionIds,
    };
  }

  if (binding.outcome === 'STALE_EVIDENCE') {
    return {
      status: 'STALE',
      decisionId: current.reviewDecisionId,
      reason: `evidence binding changed: ${binding.mismatches.join('; ')}`,
      consideredDecisionIds,
    };
  }
  return {
    status: 'INVALID',
    decisionId: current.reviewDecisionId,
    reason: `${binding.outcome}: ${binding.mismatches.join('; ')}`,
    consideredDecisionIds,
  };
}

/**
 * Whether a specific earlier decision is superseded within its binding tuple.
 * Deterministic by (normalized decisionTimestamp, reviewDecisionId).
 */
export function isSuperseded(
  decision: ReviewDecisionRecord,
  decisions: readonly ReviewDecisionRecord[],
): boolean {
  const tuple = orderDecisions(decisions.filter(d => sameBindingTuple(d, decision)));
  if (tuple.length === 0) return false;
  return tuple[tuple.length - 1].reviewDecisionId !== decision.reviewDecisionId;
}
