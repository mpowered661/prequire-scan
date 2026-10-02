// Phase 2b-C2 — HTTP-free orchestration of a trusted presentation review.
//
// WHAT THIS IS. One function that composes the accepted layers in a fixed,
// fail-closed order: authenticate the reviewer, reload the immutable
// QualificationInput, re-derive deterministically, select exactly one packet,
// compare the caller's claimed binding against the re-derivation, validate the
// decision under the frozen contract, load the complete decision history, apply
// the per-type semantics, derive a snapshot for an approval, and persist.
//
// WHAT THIS IS NOT. There is no HTTP here, no browser, no UI, no route. It
// reimplements nothing: authentication, re-derivation, hashing, binding,
// validation, snapshot derivation, idempotency and the write transaction all
// remain the property of the accepted layers.
//
// WHY THE REQUEST ARRIVES AS `unknown`. Taking a pre-typed request would move
// forbidden-field rejection out of this layer and into a future route, where a
// single `as` would bypass it. The parser below owns that trust requirement, so
// Phase 2b-C3 can be a thin adapter that parses JSON and maps result classes to
// status codes without having to re-establish anything.
//
// APPROVE_PRESENTATION MEANS ONLY: this exact evidence-bound proposition may be
// used in a governed external presentation asset. It authorizes no email, no
// outreach, no CRM write, no publishing, no website change, no social posting,
// no remediation, no CONNECT, no business-impact claim and no verified-fix
// claim. Nothing downstream of persistence happens here, and no field of the
// result may be read as permission to act.

import { randomUUID } from 'node:crypto';

import { deriveApprovalEligibility } from '../human-review/approval-eligibility';
import {
  deriveDecisionStatus,
  normalizedDecisionTimestamp,
  orderDecisions,
  validateReviewDecision,
} from '../human-review/approval-status';
import { compareBinding } from '../human-review/binding';
import { InvalidPacketIdentityError, reviewPacketHash, reviewedProseHash } from '../human-review/packet-hash';
import { derivePresentationSnapshotFromDecision, deterministicSnapshotId } from '../human-review/snapshot';
import type {
  PresentationSnapshotRecord,
  RejectionReason,
  ReviewDecisionRecord,
  ReviewPacketView,
} from '../human-review/types';
import { HRA_VERSION, PRESENTATION_APPROVE_CAPABILITY, REJECTION_REASONS, TEMPORAL_FRAME } from '../human-review/versions';
import { deriveReviewPacketsFromStoredQualificationInput } from '../qualification-input-bridge/rederive';
import { requirePresentationApprove } from './capability';
import { toReviewPacketView } from './packet-view';
import { loadDecisionsForOpportunity } from './review-history';
import { recordPresentationReview } from './review-persistence';

// ── request contract ────────────────────────────────────────────────────────

/**
 * Fields a caller may never supply. Rejected BY NAME rather than ignored, as
 * the accepted internal scan route already does, so a caller cannot believe it
 * influenced evidence, identity, timing or approval state.
 */
export const FORBIDDEN_REQUEST_FIELDS: readonly string[] = Object.freeze([
  'reviewerId', 'reviewer_user_id', 'reviewerEmail', 'email', 'userId',
  'reviewerCapability', 'capability',
  'reviewDecisionId', 'decisionTimestamp', 'recordedAt',
  'reviewedProseHash', 'displayProse', 'prose', 'claimText',
  'presentationSnapshot', 'snapshot', 'presentationSnapshotId',
  'canonicalClaim', 'demonstration', 'supportingEvidenceRefsDigest', 'observedAt',
  'qualificationInput', 'qualification', 'reviewPacket', 'packet',
  'evidence', 'evidenceRefs', 'gateTrace',
  'presentationPermission', 'presentationMode', 'demonstrability',
  'demonstrabilityStatus', 'qualificationStatus', 'temporalFrame',
  'hraVersion', 'reviewContractVersion', 'qualificationVersion',
  'inputHash', 'qualificationInputHash', 'canonicalPayloadHash',
  'approved', 'status', 'meetsScoutEvidenceRequirements',
]);

interface CommonFields {
  /** The immutable observation to reload and re-derive from. */
  scanId: string;
  /** Selects exactly one re-derived packet. */
  opportunityKey: string;
  /** Asserted binding: what the human believes they reviewed. Never proof. */
  evidenceFingerprint: string;
  claimHash: string;
  reviewPacketHash: string;
  /** Caller-generated idempotency key, reused verbatim on a legitimate retry. */
  requestId: string;
  /** Bounded operator commentary. Length and content are the frozen layer's rules. */
  boundedReviewerNote?: string;
}

export type PresentationReviewRequest =
  | (CommonFields & { decisionType: 'APPROVE_PRESENTATION' })
  | (CommonFields & { decisionType: 'REJECT'; structuredRejectionReason: RejectionReason })
  | (CommonFields & { decisionType: 'REVOKE'; revokesReviewDecisionId: string });

// ── result contract ─────────────────────────────────────────────────────────

/**
 * Bounded failure classes. Deliberately HTTP-free: Phase 2b-C3 maps these to
 * status codes without ever inspecting database or Supabase text.
 */
export type ReviewFailureClass =
  | 'request_invalid'
  | 'unauthenticated'
  | 'forbidden'
  | 'server_misconfiguration'
  | 'upstream_failure'
  | 'scan_not_found'
  | 'rederivation_failed'
  | 'opportunity_not_found'
  | 'ambiguous_opportunity'
  | 'invalid_packet_identity'
  | 'binding_mismatch'
  | 'decision_invalid'
  | 'approval_not_eligible'
  | 'snapshot_not_derivable'
  | 'revoke_target_invalid'
  | 'history_failed'
  | 'idempotency_conflict'
  | 'persistence_failed';

export interface ReviewRecorded {
  ok: true;
  /** RECORDED wrote new rows; ALREADY_RECORDED matched an identical retry. */
  outcome: 'RECORDED' | 'ALREADY_RECORDED';
  reviewDecisionId: string;
  requestId: string;
  decisionTimestamp: string;
  /** null for REJECT and REVOKE, which produce no snapshot. */
  presentationSnapshotId: string | null;
}

export interface ReviewRefused {
  ok: false;
  failure: ReviewFailureClass;
  /**
   * STABLE CODES ONLY, from the accepted layers: BindingOutcome,
   * DecisionValidationCode, SnapshotDerivationCode, ReconstructionCode,
   * HistoryFailureCode, CapabilityFailureCode, RecordReviewFailureCode, or a
   * bounded code minted here.
   *
   * The accepted layers also return a `detail` string that can contain raw
   * database text. It is NEVER copied here. A caller — including a future
   * route — has no way to reach it through this type, which is why C3 does not
   * need to know it exists.
   */
  reasons: string[];
}

export type PresentationReviewResult = ReviewRecorded | ReviewRefused;

const refuse = (failure: ReviewFailureClass, ...reasons: string[]): ReviewRefused =>
  ({ ok: false, failure, reasons });

// ── stable-code mapping ─────────────────────────────────────────────────────
// Each table maps an accepted layer's OWN stable code onto a C2 class. The
// lower-layer code is carried through in `reasons` so a future operator can see
// exactly which gate refused, without any raw text crossing the boundary.

const AUTH_CLASS: Readonly<Record<string, ReviewFailureClass>> = Object.freeze({
  authorization_header_missing: 'unauthenticated',
  authorization_scheme_not_bearer: 'unauthenticated',
  bearer_token_empty: 'unauthenticated',
  bearer_token_malformed: 'unauthenticated',
  token_rejected: 'unauthenticated',
  no_user_for_token: 'unauthenticated',
  user_id_malformed: 'unauthenticated',
  capability_absent: 'forbidden',
  capability_revoked: 'forbidden',
  auth_not_configured: 'server_misconfiguration',
  capability_store_not_configured: 'server_misconfiguration',
  auth_transport_error: 'upstream_failure',
  capability_lookup_failed: 'upstream_failure',
  capability_row_malformed: 'upstream_failure',
});

const HISTORY_CLASS: Readonly<Record<string, ReviewFailureClass>> = Object.freeze({
  history_store_not_configured: 'server_misconfiguration',
  history_lookup_failed: 'upstream_failure',
  history_row_malformed: 'history_failed',
});

const PERSISTENCE_CLASS: Readonly<Record<string, ReviewFailureClass>> = Object.freeze({
  idempotency_conflict: 'idempotency_conflict',
  qualification_input_not_found: 'scan_not_found',
  qualification_input_hash_mismatch: 'persistence_failed',
  revoke_target_not_found: 'revoke_target_invalid',
  persistence_not_configured: 'server_misconfiguration',
  transport_error: 'upstream_failure',
  malformed_response: 'upstream_failure',
  unrecognized_outcome: 'upstream_failure',
  // The remaining codes mean THIS layer built a bad payload. They are server
  // faults, never caller faults, and must not be reported as request errors.
  snapshot_required_for_approval: 'persistence_failed',
  snapshot_forbidden_for_decision: 'persistence_failed',
  snapshot_binding_mismatch: 'persistence_failed',
  decision_timestamp_out_of_bounds: 'persistence_failed',
  malformed_input: 'persistence_failed',
});

/** Re-derivation codes that mean the observation is absent or unreadable. */
const REDERIVATION_CLASS: Readonly<Record<string, ReviewFailureClass>> = Object.freeze({
  not_found: 'scan_not_found',
  database_error: 'upstream_failure',
});

// ── request parsing ─────────────────────────────────────────────────────────
// Written without backslash escapes so the patterns survive tooling that
// mishandles them.

/**
 * Generic UUID, for identifiers that REFERENCE an existing row: scanId names a
 * stored observation, revokesReviewDecisionId names a recorded decision. Those
 * values must match what was already persisted, so pinning a version could
 * refuse a legitimate historical id.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * UUIDv4 specifically, for requestId. The authorized contract is a
 * client-generated UUIDv4, server-validated: version nibble 4 and RFC 4122
 * variant bits 10xx. randomUUID() produces exactly this.
 *
 * Nothing in the accepted stack forces this either way -- review_decisions
 * .request_id is a `text` column constrained only to be non-empty, the RPC
 * applies no uuid cast to it, and validateReviewDecision only checks that it is
 * a non-empty string -- so enforcing the specified contract costs nothing and
 * narrows what a caller can pass.
 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX32 = /^[0-9a-f]{32}$/;
const DECISION_TYPES: readonly string[] = Object.freeze([
  'APPROVE_PRESENTATION', 'REJECT', 'REVOKE',
]);

type ParseResult =
  | { ok: true; request: PresentationReviewRequest }
  | { ok: false; reasons: string[] };

/**
 * Validates SHAPE only. It deliberately does not re-decide anything the frozen
 * layer owns: note length, markup and control characters stay with
 * validateReviewDecision, and binding correctness stays with compareBinding.
 *
 * requestId must be a UUIDv4, per the authorized contract. Format alone cannot
 * prove freshness, so two further protections are applied: the key must not
 * equal any content field (checked below), and the persistence layer's UNIQUE
 * constraint decides what a replay means. The version check simply refuses
 * shapes a compliant client would never send.
 */
function parseRequest(raw: unknown): ParseResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reasons: ['request_not_an_object'] };
  }
  const body = raw as Record<string, unknown>;

  const offered = FORBIDDEN_REQUEST_FIELDS.filter(
    k => Object.prototype.hasOwnProperty.call(body, k));
  if (offered.length > 0) {
    // Named so the caller learns it was refused, not silently dropped.
    return { ok: false, reasons: ['forbidden_field_supplied', ...offered.map(f => `forbidden:${f}`)] };
  }

  const reasons: string[] = [];
  const str = (key: string, pattern?: RegExp): string => {
    const v = body[key];
    if (typeof v !== 'string' || v.length === 0) { reasons.push(`${key}_missing`); return ''; }
    if (pattern && !pattern.test(v)) reasons.push(`${key}_malformed`);
    return v;
  };

  const scanId = str('scanId', UUID);
  const opportunityKey = str('opportunityKey');
  const evidenceFingerprint = str('evidenceFingerprint');
  const claimHash = str('claimHash');
  const reviewPacketHash = str('reviewPacketHash', HEX32);
  const requestId = str('requestId', UUID_V4);

  const decisionType = body.decisionType;
  if (typeof decisionType !== 'string' || !DECISION_TYPES.includes(decisionType)) {
    reasons.push('decisionType_unknown');
  }

  // A retry token derived from content would silently collapse two different
  // human actions into one, so equality with any content field is refused.
  for (const [name, value] of Object.entries({
    opportunityKey, scanId, evidenceFingerprint, claimHash, reviewPacketHash,
    revokesReviewDecisionId: typeof body.revokesReviewDecisionId === 'string'
      ? body.revokesReviewDecisionId : '',
  })) {
    if (requestId.length > 0 && requestId === value) {
      reasons.push(`requestId_derived_from_${name}`);
    }
  }

  let note: string | undefined;
  if (body.boundedReviewerNote !== undefined && body.boundedReviewerNote !== null) {
    if (typeof body.boundedReviewerNote !== 'string') reasons.push('boundedReviewerNote_malformed');
    else note = body.boundedReviewerNote;
  }

  // Per-type fields. The union makes these mutually exclusive at the type
  // level; these checks make them mutually exclusive at runtime too.
  let reason: RejectionReason | undefined;
  let revokes: string | undefined;

  if (decisionType === 'REJECT') {
    const v = body.structuredRejectionReason;
    if (typeof v !== 'string' || !REJECTION_REASONS.includes(v)) {
      reasons.push('structuredRejectionReason_required');
    } else {
      reason = v as RejectionReason;
    }
    if (body.revokesReviewDecisionId !== undefined) reasons.push('reject_must_not_carry_revoke_target');
  }

  if (decisionType === 'REVOKE') {
    const v = body.revokesReviewDecisionId;
    if (typeof v !== 'string' || !UUID.test(v)) reasons.push('revokesReviewDecisionId_required');
    else revokes = v;
    // Structurally avoids carried LOW-1: the frozen validator tolerates this
    // combination but the migration-011 CHECK refuses it, and the refusal would
    // surface as an opaque transport error. It never reaches persistence.
    if (body.structuredRejectionReason !== undefined) {
      reasons.push('revoke_must_not_carry_rejection_reason');
    }
  }

  if (decisionType === 'APPROVE_PRESENTATION') {
    if (body.structuredRejectionReason !== undefined) {
      reasons.push('approve_must_not_carry_rejection_reason');
    }
    if (body.revokesReviewDecisionId !== undefined) {
      reasons.push('approve_must_not_carry_revoke_target');
    }
  }

  if (reasons.length > 0) return { ok: false, reasons };

  const common: CommonFields = {
    scanId, opportunityKey, evidenceFingerprint, claimHash, reviewPacketHash, requestId,
  };
  if (note !== undefined) common.boundedReviewerNote = note;

  if (decisionType === 'REJECT') {
    return { ok: true, request: { ...common, decisionType, structuredRejectionReason: reason! } };
  }
  if (decisionType === 'REVOKE') {
    return { ok: true, request: { ...common, decisionType, revokesReviewDecisionId: revokes! } };
  }
  return { ok: true, request: { ...common, decisionType: 'APPROVE_PRESENTATION' } };
}

// ── REVOKE target validation ────────────────────────────────────────────────

/**
 * Validates a revocation target beyond the database's existence check.
 *
 * WHY EXPLICIT CHECKS AND NOT STRING MATCHING. The frozen deriveDecisionStatus
 * reports REVOKED both for a legitimate revocation and for malformed targeting,
 * distinguished only by prose in `reason`. Building correctness on that text
 * would be fragile. Instead the four structural conditions that
 * resolveRevocations treats as malformed are checked here directly, using
 * exported frozen functions only:
 *
 *   names a target            -> the parser already required a UUID
 *   target is in scope        -> history is loaded filtered to this opportunity
 *   target is strictly earlier -> checked against orderDecisions
 *   target is not a REVOKE    -> checked directly
 *
 * plus the binding condition that the database does NOT enforce:
 *
 *   target binds this packet  -> compareBinding(target, view) must be EXACT
 *
 * After those, the frozen status is used as a fail-closed CONSISTENCY
 * ASSERTION rather than as the discriminator.
 */
function validateRevocationTarget(
  candidate: ReviewDecisionRecord,
  targetId: string,
  history: readonly ReviewDecisionRecord[],
  view: ReviewPacketView,
): string[] {
  if (targetId === candidate.reviewDecisionId) return ['revoke_target_is_self'];

  const target = history.find(d => d.reviewDecisionId === targetId);
  if (!target) return ['revoke_target_not_in_history'];

  if (target.decisionType === 'REVOKE') return ['revoke_target_is_a_revocation'];

  // Changed evidence stays independent: a target bound to a different packet
  // cannot be revoked through this binding.
  const targetBinding = compareBinding(target, view);
  if (targetBinding.outcome !== 'EXACT') {
    return ['revoke_target_binding_not_exact', `target_binding:${targetBinding.outcome}`];
  }

  const ordered = orderDecisions([...history, candidate]);
  const ti = ordered.findIndex(d => d.reviewDecisionId === targetId);
  const ci = ordered.findIndex(d => d.reviewDecisionId === candidate.reviewDecisionId);
  if (ti < 0 || ci < 0 || ti >= ci) return ['revoke_target_not_strictly_earlier'];

  // Something must still be standing on this binding for a revocation to mean
  // anything. An already-revoked or never-reviewed binding is refused rather
  // than recording a revocation with no effect.
  const before = deriveDecisionStatus(history, view).status;
  if (before !== 'APPROVED_CURRENT' && before !== 'REJECTED_CURRENT') {
    return ['revoke_nothing_standing', `status_before:${before}`];
  }

  // Consistency assertion, not the discriminator: with a well-formed target the
  // frozen layer must read the binding as revoked once the candidate is added.
  const after = deriveDecisionStatus([...history, candidate], view).status;
  if (after !== 'REVOKED') return ['revoke_frozen_status_inconsistent', `status_after:${after}`];

  return [];
}

// ── orchestration ───────────────────────────────────────────────────────────

/**
 * Records one human review decision, or refuses with a bounded class.
 *
 * ORDER IS A TRUST PROPERTY. Privileged reads happen only after the reviewer is
 * authenticated and holds presentation.approve, and nothing is written until
 * every semantic gate has passed:
 *
 *   1 request shape and forbidden fields
 *   2 current reviewer authority            (the accepted live mint)
 *   3 reload + deterministic re-derivation  (the accepted bridge)
 *   4 exactly one packet for the opportunity
 *   5 production packet view + recomputed hash
 *   6 candidate construction from server-derived fields
 *   7 frozen decision validation
 *   8 frozen binding comparison, EXACT only
 *   9 complete decision history             (accepted C1 reader)
 *  10 per-type semantics
 *  11 snapshot derivation for an approval
 *  12 atomic persistence                    (accepted C2b wrapper)
 */
export async function reviewPresentation(
  authorizationHeader: string | null,
  rawRequest: unknown,
): Promise<PresentationReviewResult> {
  // 1 ── request shape. Owned here so a future route cannot bypass it.
  const parsed = parseRequest(rawRequest);
  if (!parsed.ok) return refuse('request_invalid', ...parsed.reasons);
  const request = parsed.request;

  // 2 ── current authority. The ONLY source of reviewer identity. No bearer
  // parsing, no capability query and no identity assertion happens here.
  const authorized = await requirePresentationApprove(authorizationHeader);
  if (!authorized.ok) {
    return refuse(AUTH_CLASS[authorized.code] ?? 'unauthenticated', authorized.code);
  }

  // 3 ── deterministic re-derivation from the immutable observation.
  const rederived = await deriveReviewPacketsFromStoredQualificationInput(request.scanId);
  if (!rederived.ok) {
    const codes = rederived.failures.map(f => f.code);
    const cls = codes.map(c => REDERIVATION_CLASS[c]).find(Boolean) ?? 'rederivation_failed';
    return refuse(cls, ...codes);
  }

  // 4 ── exactly one packet. Counted, never [0], never "latest".
  const matches = rederived.review.packets.filter(
    pk => pk.opportunityKey === request.opportunityKey);
  if (matches.length === 0) return refuse('opportunity_not_found', 'no_packet_for_opportunity_key');
  if (matches.length > 1) {
    return refuse('ambiguous_opportunity', 'multiple_packets_for_opportunity_key');
  }

  // 5 ── production view and recomputed identity.
  let view: ReviewPacketView;
  let currentPacketHash: string;
  try {
    view = toReviewPacketView(matches[0]);
    currentPacketHash = reviewPacketHash(view);
  } catch (cause) {
    return refuse('invalid_packet_identity',
      cause instanceof InvalidPacketIdentityError ? 'packet_identity_invalid' : 'packet_view_failed');
  }
  void currentPacketHash; // compareBinding recomputes it; kept for clarity only.

  // The snapshot's sourceScanId is taken by the frozen derivation from
  // packet.scanId, while persistence compares it to the scanId passed here. The
  // bridge guarantees they agree, because reconstruction refuses a payload whose
  // scanId does not match the row it was loaded from. Asserting it anyway turns
  // a would-be opaque SNAPSHOT_BINDING_MISMATCH from the write into a precise
  // refusal, and keeps the guarantee local to this composition.
  if (view.scanId !== request.scanId) {
    return refuse('rederivation_failed', 'packet_scan_id_mismatch');
  }

  // 6 ── candidate construction. The caller contributes ONLY the four binding
  // assertions and its own bounded note; everything that carries authority,
  // timing or contract identity is taken from the server and the re-derivation.
  const candidate: ReviewDecisionRecord = {
    reviewDecisionId: randomUUID(),
    requestId: request.requestId,
    decisionType: request.decisionType,
    reviewerId: authorized.reviewer,
    reviewerCapability: PRESENTATION_APPROVE_CAPABILITY,

    opportunityKey: request.opportunityKey,
    evidenceFingerprint: request.evidenceFingerprint,
    claimHash: request.claimHash,
    reviewPacketHash: request.reviewPacketHash,

    reviewContractVersion: view.reviewContractVersion,
    qualificationVersion: view.qualificationVersion,
    hraVersion: HRA_VERSION,

    presentationMode: view.presentationMode,
    demonstrability: view.demonstrabilityStatus,
    temporalFrame: TEMPORAL_FRAME,

    decisionTimestamp: normalizedDecisionTimestamp(new Date().toISOString()),
    reviewedProseHash: reviewedProseHash(view.displayProse),
  };
  if (request.boundedReviewerNote !== undefined) {
    candidate.boundedReviewerNote = request.boundedReviewerNote;
  }
  if (request.decisionType === 'REJECT') {
    candidate.structuredRejectionReason = request.structuredRejectionReason;
  }
  if (request.decisionType === 'REVOKE') {
    candidate.revokesReviewDecisionId = request.revokesReviewDecisionId;
  }

  // 7 ── frozen decision validation.
  const validation = validateReviewDecision(candidate);
  if (!validation.valid) {
    return refuse('decision_invalid', ...validation.failures.map(f => f.code));
  }

  // 8 ── frozen binding comparison. This is where a stale review is caught:
  // the caller's asserted hashes are compared against the re-derivation, and
  // anything but EXACT refuses.
  const binding = compareBinding(candidate, view);
  if (binding.outcome !== 'EXACT') {
    return refuse('binding_mismatch', binding.outcome);
  }

  // 9 ── complete decision history. Loaded only now, after authority. Any
  // reader failure is terminal: a partial history could read a revoked binding
  // as current.
  const historyOutcome = await loadDecisionsForOpportunity(request.opportunityKey);
  if (!historyOutcome.ok) {
    return refuse(HISTORY_CLASS[historyOutcome.code] ?? 'history_failed', historyOutcome.code);
  }
  const history = historyOutcome.decisions;

  // 10/11 ── per-type semantics, and a snapshot for an approval only.
  let snapshot: PresentationSnapshotRecord | null = null;

  if (request.decisionType === 'APPROVE_PRESENTATION') {
    const eligibility = deriveApprovalEligibility(view);
    if (eligibility.outcome !== 'ELIGIBLE_FOR_HUMAN_APPROVAL') {
      // blockingReasons are frozen, bounded strings produced from the packet,
      // never database text.
      return refuse('approval_not_eligible', ...eligibility.blockingReasons);
    }

    const derivation = derivePresentationSnapshotFromDecision({
      packet: view,
      decision: candidate,
      // The candidate must be the current standing decision once appended. The
      // frozen derivation enforces that, so an out-of-order history — including
      // a row timestamped slightly ahead of now — fails closed here rather than
      // producing an approval that is not actually current.
      allDecisions: [...history, candidate],
      presentationSnapshotId: deterministicSnapshotId(
        candidate.reviewDecisionId, view.claimHash,
        view.evidenceFingerprint, candidate.reviewPacketHash),
    });
    if (!derivation.snapshot) {
      return refuse('snapshot_not_derivable', ...derivation.failures.map(f => f.code));
    }
    snapshot = derivation.snapshot;
  }

  if (request.decisionType === 'REVOKE') {
    const problems = validateRevocationTarget(
      candidate, request.revokesReviewDecisionId, history, view);
    if (problems.length > 0) return refuse('revoke_target_invalid', ...problems);
  }

  // REJECT needs no eligibility gate: the frozen model deliberately permits
  // rejecting a packet that could never be approved, and produces no snapshot.

  // 12 ── atomic persistence. Idempotency, the canonical payload hash, the
  // transaction and the evidence recheck all belong to the accepted layers.
  const recorded = await recordPresentationReview({
    decision: candidate,
    snapshot,
    scanId: request.scanId,
    // Server-derived: recomputed from the reconstructed payload by the bridge,
    // never supplied by the caller.
    expectedInputHash: rederived.inputHash,
  });

  if (!recorded.ok) {
    return refuse(PERSISTENCE_CLASS[recorded.code] ?? 'persistence_failed', recorded.code);
  }

  // Persistence is authoritative for identity on a retry: ALREADY_RECORDED
  // returns the ORIGINAL decision id, timestamp and snapshot id, not the ones
  // minted for this attempt.
  return {
    ok: true,
    outcome: recorded.outcome,
    reviewDecisionId: recorded.reviewDecisionId,
    requestId: recorded.requestId,
    decisionTimestamp: recorded.decisionTimestamp,
    presentationSnapshotId: recorded.presentationSnapshotId,
  };
}
