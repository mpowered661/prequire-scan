// Human Review & Approval v0.1 — pure PresentationSnapshot derivation.
//
// Fails closed unless EVERY frozen condition passes. Derives from a current
// ReviewPacket plus a SUPPLIED valid APPROVE_PRESENTATION decision. It never
// creates a decision and never persists anything.
//
// SNAPSHOT ID BOUNDARY: Phase 2a has no persistence, so the identifier is
// SUPPLIED rather than generated — no random UUID is minted for convenience. A
// deterministic helper is offered for callers that want a content-addressed id,
// but Phase 2b may instead use a storage-generated identity; either is accepted
// here as a supplied future-storage identity.

import { createHash } from 'node:crypto';
import { compareBinding } from './binding';
import { deriveApprovalEligibility } from './approval-eligibility';
import { deriveDecisionStatus, validateReviewDecision } from './approval-status';
import { supportingEvidenceRefsDigest } from './packet-hash';
import { APPROVABLE_DEMONSTRABILITY, APPROVABLE_PRESENTATION_MODE, HRA_VERSION, TEMPORAL_FRAME } from './versions';
import type {
  PresentationSnapshotRecord,
  ReviewDecisionRecord,
  ReviewPacketView,
  SnapshotConsumability,
  SnapshotDerivation,
  SnapshotDerivationCode,
} from './types';

/**
 * Optional deterministic, content-addressed identifier. Offered so callers need
 * no randomness; Phase 2b may supply a storage identity instead.
 */
export function deterministicSnapshotId(
  reviewDecisionId: string,
  claimHash: string,
  evidenceFingerprint: string,
  reviewPacketHash: string,
): string {
  return createHash('sha256')
    .update([reviewDecisionId, claimHash, evidenceFingerprint, reviewPacketHash].join('|'))
    .digest('hex')
    .slice(0, 32);
}

/**
 * Deep, detached, frozen copy of a nested approved value.
 *
 * A snapshot is immutable approved presentation truth, so it must not alias its
 * input. `Object.freeze` alone is shallow: under hra-0.1 the snapshot's
 * `canonicalClaim` was the very object the packet held, so mutating the packet
 * after derivation retroactively changed the snapshot, and nested properties
 * stayed writable through the snapshot itself.
 *
 * Object keys are copied in sorted order so the copy is deterministic. Only
 * plain JSON-shaped values are accepted — exactly what or-0.1 produces — and
 * anything else FAILS CLOSED rather than being silently flattened, which would
 * lose approved content.
 */
function deepFrozenCopy(value: unknown, path = 'canonicalClaim'): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map((v, i) => deepFrozenCopy(v, `${path}[${i}]`)));
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`snapshot value at ${path} is not a plain JSON-shaped object; refusing to copy it`);
  }
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    out[key] = deepFrozenCopy(source[key], `${path}.${key}`);
  }
  return Object.freeze(out);
}

export interface SnapshotDerivationInput {
  packet: ReviewPacketView;
  decision: ReviewDecisionRecord;
  /** All immutable decisions known for this opportunity, for status derivation. */
  allDecisions: readonly ReviewDecisionRecord[];
  /** Supplied future-storage identity. No id is generated here. */
  presentationSnapshotId: string;
}

/**
 * Derives an immutable snapshot, or returns the reasons it may not exist.
 *
 * No snapshot from: REJECT · REVOKE · STATEMENT_ONLY · NOT_DEMONSTRABLE ·
 * LIMITED_DEMONSTRABILITY · a stale packet · an invalid packet · a changed
 * claim, fingerprint or packet hash · the wrong opportunity · a wrong contract
 * version · a missing capability · a non-current decision.
 */
export function derivePresentationSnapshotFromDecision(
  input: SnapshotDerivationInput,
): SnapshotDerivation {
  const { packet, decision, allDecisions, presentationSnapshotId } = input;
  const failures: { code: SnapshotDerivationCode; detail: string }[] = [];
  const fail = (code: SnapshotDerivationCode, detail: string) => failures.push({ code, detail });

  if (typeof presentationSnapshotId !== 'string' || presentationSnapshotId.length === 0) {
    fail('snapshot_id_not_supplied', 'Phase 2a does not generate identifiers');
  }

  const validation = validateReviewDecision(decision);
  if (!validation.valid) {
    fail('decision_invalid', validation.failures.map(f => `${f.code}: ${f.detail}`).join('; '));
  }

  if (decision.decisionType !== 'APPROVE_PRESENTATION') {
    fail('decision_not_approval', `decisionType is ${decision.decisionType}`);
  }

  const binding = compareBinding(decision, packet);
  if (binding.outcome !== 'EXACT') {
    fail('binding_not_exact', `${binding.outcome}: ${binding.mismatches.join('; ')}`);
  }

  const eligibility = deriveApprovalEligibility(packet);
  if (eligibility.outcome !== 'ELIGIBLE_FOR_HUMAN_APPROVAL') {
    fail('packet_not_approvable', eligibility.blockingReasons.join('; '));
  }

  const status = deriveDecisionStatus(allDecisions, packet);
  if (status.status !== 'APPROVED_CURRENT' || status.decisionId !== decision.reviewDecisionId) {
    fail('decision_not_current', `derived status is ${status.status} (${status.reason})`);
  }

  if (failures.length > 0) return { snapshot: null, failures };

  const snapshot: PresentationSnapshotRecord = {
    presentationSnapshotId,
    reviewDecisionId: decision.reviewDecisionId,

    opportunityKey: packet.opportunityKey,
    evidenceFingerprint: packet.evidenceFingerprint,
    claimHash: packet.claimHash,
    reviewPacketHash: decision.reviewPacketHash,

    // Carried through unchanged from or-0.1; never re-derived or re-worded.
    // Deep-copied and deep-frozen so later mutation of the packet cannot
    // retroactively alter approved truth.
    canonicalClaim: deepFrozenCopy(packet.canonicalClaim, 'canonicalClaim'),
    reviewedProseHash: decision.reviewedProseHash,
    // References digest, not duplicated evidence payloads.
    supportingEvidenceRefsDigest: supportingEvidenceRefsDigest(packet.evidenceRefs),
    demonstration: deepFrozenCopy(packet.demonstration, 'demonstration'),

    presentationMode: APPROVABLE_PRESENTATION_MODE,
    demonstrability: APPROVABLE_DEMONSTRABILITY,
    observedAt: packet.observedAt,
    temporalFrame: TEMPORAL_FRAME,

    reviewContractVersion: packet.reviewContractVersion,
    qualificationVersion: packet.qualificationVersion,
    hraVersion: HRA_VERSION,
    sourceScanId: packet.scanId,
  };

  return { snapshot: Object.freeze(snapshot), failures: [] };
}

/**
 * Whether an existing snapshot may currently be consumed by a later layer such
 * as a Video Brief. A Video Brief consumes a specific snapshot id, never "the
 * latest opportunity".
 *
 * FROZEN RULE: a reviewer's later loss of capability does NOT by itself make a
 * snapshot unconsumable. Authority is evaluated at decisionTimestamp. Only an
 * explicit REVOKE, or evidence/claim invalidation, disables use.
 */
export function deriveSnapshotConsumability(
  snapshot: PresentationSnapshotRecord,
  packet: ReviewPacketView,
  allDecisions: readonly ReviewDecisionRecord[],
): SnapshotConsumability {
  const status = deriveDecisionStatus(allDecisions, packet);
  if (status.status === 'REVOKED') {
    return { status: 'NOT_CONSUMABLE', reason: `explicitly revoked: ${status.reason}` };
  }
  if (status.status !== 'APPROVED_CURRENT') {
    return { status: 'NOT_CONSUMABLE', reason: `derived status is ${status.status}: ${status.reason}` };
  }
  if (status.decisionId !== snapshot.reviewDecisionId) {
    return { status: 'NOT_CONSUMABLE', reason: `current decision ${status.decisionId} is not this snapshot's decision` };
  }
  if (snapshot.claimHash !== packet.claimHash
    || snapshot.evidenceFingerprint !== packet.evidenceFingerprint) {
    return { status: 'NOT_CONSUMABLE', reason: 'snapshot bindings no longer match the current packet' };
  }
  return { status: 'CONSUMABLE', reason: 'approval is current and bindings match' };
}
