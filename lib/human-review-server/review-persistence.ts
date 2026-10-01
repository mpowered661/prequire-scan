// Phase 2b-B — the smallest service-role wrapper around the one write path.
//
// This module does NOT decide anything. It does not authenticate, it does not
// check capability, it does not compare bindings, it does not derive status and
// it does not build a decision or a snapshot. Callers hand it values the frozen
// layer already produced, and it writes them exactly once.
//
// WHY A WRAPPER AND NOT A DIRECT INSERT: the decision and its snapshot must
// land together or not at all, and the immutable QualificationInput identity
// must be rechecked at write time, inside the same transaction. Two separate
// .insert() calls from here could not give either guarantee. All of it lives in
// record_presentation_review (migration 011); this file is a typed call site.
//
// MIGRATION 011 IS NOT APPLIED. Every function here will fail at runtime until
// it is. That is deliberate for this tranche: no route and no UI reaches this
// code yet.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { normalizedDecisionTimestamp } from '../human-review/approval-status';
import { canonicalDecisionPayloadHash } from '../human-review/idempotency';
import { reviewerIdentityValue } from '../human-review/future-identity';
import type {
  PresentationSnapshotRecord,
  ReviewDecisionRecord,
} from '../human-review/types';

/** Read through process.env indirectly, so a bundler cannot inline the key. */
const SUPABASE_URL_VAR = 'NEXT_PUBLIC_SUPABASE_URL';
const SERVICE_ROLE_KEY_VAR = 'SUPABASE_SERVICE_ROLE_KEY';

const RPC_NAME = 'record_presentation_review';

let persistenceClient: SupabaseClient | null = null;

/**
 * Created lazily, never at module load. A module-level client would make this
 * file unimportable without live credentials and would drag a connection into
 * any test that merely touches the types.
 */
function client(): SupabaseClient | null {
  if (persistenceClient) return persistenceClient;
  const url = process.env[SUPABASE_URL_VAR];
  const key = process.env[SERVICE_ROLE_KEY_VAR];
  if (!url || !key) return null;
  persistenceClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return persistenceClient;
}

/** Test seam. Never call this from production code. */
export function UNSAFE_setPersistenceClientForTests(stub: unknown): void {
  persistenceClient = stub as SupabaseClient | null;
}

export type RecordReviewFailureCode =
  | 'idempotency_conflict'
  | 'qualification_input_not_found'
  | 'qualification_input_hash_mismatch'
  | 'snapshot_required_for_approval'
  | 'snapshot_forbidden_for_decision'
  | 'snapshot_binding_mismatch'
  | 'revoke_target_not_found'
  | 'decision_timestamp_out_of_bounds'
  | 'malformed_input'
  | 'persistence_not_configured'
  | 'transport_error'
  | 'malformed_response'
  | 'unrecognized_outcome';

export interface RecordedReview {
  ok: true;
  /** RECORDED wrote a new row; ALREADY_RECORDED matched an identical retry. */
  outcome: 'RECORDED' | 'ALREADY_RECORDED';
  reviewDecisionId: string;
  requestId: string;
  decisionTimestamp: string;
  /** null for REJECT and REVOKE, which produce no snapshot. */
  presentationSnapshotId: string | null;
  canonicalPayloadHash: string;
}

export type RecordReviewOutcome =
  | RecordedReview
  | { ok: false; code: RecordReviewFailureCode; detail: string };

/**
 * Maps the RPC's outcome vocabulary onto this module's failure codes.
 *
 * Fails closed: an outcome this build does not recognise is NOT treated as
 * success, because a future migration could add one.
 */
const FAILURE_BY_OUTCOME: Readonly<Record<string, RecordReviewFailureCode>> =
  Object.freeze({
    IDEMPOTENCY_CONFLICT: 'idempotency_conflict',
    QUALIFICATION_INPUT_NOT_FOUND: 'qualification_input_not_found',
    QUALIFICATION_INPUT_HASH_MISMATCH: 'qualification_input_hash_mismatch',
    SNAPSHOT_REQUIRED_FOR_APPROVAL: 'snapshot_required_for_approval',
    SNAPSHOT_FORBIDDEN_FOR_DECISION: 'snapshot_forbidden_for_decision',
    SNAPSHOT_BINDING_MISMATCH: 'snapshot_binding_mismatch',
    REVOKE_TARGET_NOT_FOUND: 'revoke_target_not_found',
    DECISION_TIMESTAMP_OUT_OF_BOUNDS: 'decision_timestamp_out_of_bounds',
    MALFORMED_INPUT: 'malformed_input',
  });

export interface RecordReviewRequest {
  /** Already validated by validateReviewDecision. Not re-validated here. */
  decision: ReviewDecisionRecord;
  /** Required for APPROVE_PRESENTATION, null for REJECT and REVOKE. */
  snapshot: PresentationSnapshotRecord | null;
  /** The immutable observation the packet was derived from. */
  scanId: string;
  /** The exact qualification_inputs.input_hash expected at write time. */
  expectedInputHash: string;
}

/**
 * Builds the decision payload the RPC reads.
 *
 * Fields are listed EXPLICITLY rather than spreading the record, so a field
 * added to ReviewDecisionRecord later cannot silently start being persisted
 * without a migration to hold it.
 *
 * decisionTimestamp is normalized with the frozen helper: the database stores
 * the normalized form so its lexicographic order matches orderDecisions.
 * Normalization only pads the fractional part, so nothing is lost.
 */
function decisionPayload(d: ReviewDecisionRecord): Record<string, unknown> {
  return {
    reviewDecisionId: d.reviewDecisionId,
    requestId: d.requestId,
    decisionType: d.decisionType,
    reviewerId: reviewerIdentityValue(d.reviewerId),
    reviewerCapability: d.reviewerCapability,
    opportunityKey: d.opportunityKey,
    evidenceFingerprint: d.evidenceFingerprint,
    claimHash: d.claimHash,
    reviewPacketHash: d.reviewPacketHash,
    reviewContractVersion: d.reviewContractVersion,
    qualificationVersion: d.qualificationVersion,
    hraVersion: d.hraVersion,
    presentationMode: d.presentationMode,
    demonstrability: d.demonstrability,
    temporalFrame: d.temporalFrame,
    decisionTimestamp: normalizedDecisionTimestamp(d.decisionTimestamp),
    reviewedProseHash: d.reviewedProseHash,
    structuredRejectionReason: d.structuredRejectionReason ?? null,
    boundedReviewerNote: d.boundedReviewerNote ?? null,
    revokesReviewDecisionId: d.revokesReviewDecisionId ?? null,
  };
}

/** Same discipline as decisionPayload: explicit, never spread. */
function snapshotPayload(s: PresentationSnapshotRecord): Record<string, unknown> {
  return {
    presentationSnapshotId: s.presentationSnapshotId,
    reviewDecisionId: s.reviewDecisionId,
    opportunityKey: s.opportunityKey,
    evidenceFingerprint: s.evidenceFingerprint,
    claimHash: s.claimHash,
    reviewPacketHash: s.reviewPacketHash,
    canonicalClaim: s.canonicalClaim,
    demonstration: s.demonstration,
    reviewedProseHash: s.reviewedProseHash,
    supportingEvidenceRefsDigest: s.supportingEvidenceRefsDigest,
    presentationMode: s.presentationMode,
    demonstrability: s.demonstrability,
    temporalFrame: s.temporalFrame,
    observedAt: s.observedAt,
    reviewContractVersion: s.reviewContractVersion,
    qualificationVersion: s.qualificationVersion,
    hraVersion: s.hraVersion,
    sourceScanId: s.sourceScanId,
  };
}

/**
 * Records one human decision, atomically with its snapshot when it is an
 * approval.
 *
 * Idempotent on requestId: an identical retry returns ALREADY_RECORDED with the
 * ORIGINAL identifiers and timestamp, never a second row. A retry carrying the
 * same requestId but a different logical payload is an idempotency_conflict and
 * writes nothing — the canonical payload hash is computed with the frozen
 * canonicalDecisionPayloadHash, which excludes reviewDecisionId, requestId and
 * decisionTimestamp, so a retry differing only in those is still the same
 * logical decision.
 */
export async function recordPresentationReview(
  request: RecordReviewRequest,
): Promise<RecordReviewOutcome> {
  const { decision, snapshot, scanId, expectedInputHash } = request;
  const canonicalPayloadHash = canonicalDecisionPayloadHash(decision);

  // Resolved before the try: a missing key is a CONFIGURATION fault, and
  // reporting it as transport_error would send an operator to debug the
  // network instead of the deployment.
  const supabase = client();
  if (!supabase) {
    return {
      ok: false,
      code: 'persistence_not_configured',
      detail: `${RPC_NAME} requires ${SUPABASE_URL_VAR} and ${SERVICE_ROLE_KEY_VAR}`,
    };
  }

  let payload: unknown;
  try {
    const { data, error } = await supabase.rpc(RPC_NAME, {
      p_decision: decisionPayload(decision),
      p_snapshot: snapshot ? snapshotPayload(snapshot) : null,
      p_scan_id: scanId,
      p_expected_input_hash: expectedInputHash,
      p_canonical_payload_hash: canonicalPayloadHash,
    });
    if (error) {
      return {
        ok: false,
        code: 'transport_error',
        detail: error.message ?? 'rpc returned an error',
      };
    }
    payload = data;
  } catch (cause) {
    return {
      ok: false,
      code: 'transport_error',
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  }

  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, code: 'malformed_response', detail: 'rpc returned a non-object' };
  }

  const row = payload as Record<string, unknown>;
  const outcome = row.outcome;
  const detail = typeof row.detail === 'string' ? row.detail : '';

  if (typeof outcome !== 'string') {
    return { ok: false, code: 'malformed_response', detail: 'rpc returned no outcome' };
  }

  if (outcome !== 'RECORDED' && outcome !== 'ALREADY_RECORDED') {
    const mapped = FAILURE_BY_OUTCOME[outcome];
    // Fail closed: an unknown outcome is never success.
    return mapped
      ? { ok: false, code: mapped, detail }
      : { ok: false, code: 'unrecognized_outcome', detail: `rpc returned ${outcome}` };
  }

  const reviewDecisionId = row.reviewDecisionId;
  const requestId = row.requestId;
  const decisionTimestamp = row.decisionTimestamp;
  const snapshotId = row.presentationSnapshotId;
  const returnedHash = row.canonicalPayloadHash;

  if (typeof reviewDecisionId !== 'string'
    || typeof requestId !== 'string'
    || typeof decisionTimestamp !== 'string'
    || typeof returnedHash !== 'string'
    || !(snapshotId === null || snapshotId === undefined || typeof snapshotId === 'string')) {
    return {
      ok: false,
      code: 'malformed_response',
      detail: 'rpc success payload is missing a required identifier',
    };
  }

  return {
    ok: true,
    outcome,
    reviewDecisionId,
    requestId,
    decisionTimestamp,
    presentationSnapshotId: typeof snapshotId === 'string' ? snapshotId : null,
    canonicalPayloadHash: returnedHash,
  };
}
