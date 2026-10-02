// Phase 2b-C1 — reader for the immutable review decision history.
//
// WHAT THIS IS. A server-only SELECT over the append-only review_decisions
// table, hydrated into the frozen ReviewDecisionRecord shape so the frozen
// history functions (orderDecisions, resolveRevocations, deriveDecisionStatus,
// isSuperseded, derivePresentationSnapshotFromDecision) can consume it.
//
// WHAT THIS IS NOT. It authenticates nobody and authorizes nothing. It performs
// no capability lookup, no packet re-derivation, no eligibility check, no
// decision validation on anyone's behalf, and no write of any kind. It does not
// import the authority path, and it must never be used to decide whether a
// request may proceed.
//
// CURRENT REVIEW AUTHORITY COMES ONLY FROM requirePresentationApprove.
// Nothing this module returns is evidence that anybody is authenticated now,
// holds presentation.approve now, or may approve, revoke or persist anything
// now. It returns what was recorded in the past.
//
// SHAPE, NOT POLICY. Hydration checks that a persisted row can faithfully
// become the frozen record. It deliberately does NOT re-decide the human's
// judgement: contract versions, presentation mode and demonstrability are
// accepted as recorded, because a historical decision may legitimately have
// been made under an older contract. Only values the frozen TYPE or the
// migration-011 schema pins to a single literal are checked against it.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
// Type-only: erased at runtime, so obtaining the branded type creates no
// dependency on the authority path. future-identity.ts imports nothing.
import type { ReviewerCapability, TrustedReviewerIdentity } from '../human-review/future-identity';
import type {
  RejectionReason,
  ReviewDecisionRecord,
  ReviewDecisionType,
} from '../human-review/types';
import {
  MAX_REVIEWER_NOTE_CHARS,
  PRESENTATION_APPROVE_CAPABILITY,
  REJECTION_REASONS,
  TEMPORAL_FRAME,
} from '../human-review/versions';

const SUPABASE_URL_VAR = 'NEXT_PUBLIC_SUPABASE_URL';
const SERVICE_ROLE_KEY_VAR = 'SUPABASE_SERVICE_ROLE_KEY';

const TABLE = 'review_decisions';

/**
 * The columns hydration reads, named explicitly rather than selected with '*'.
 *
 * review_decisions also carries recorded_at, created_at, canonical_payload_hash,
 * source_scan_id and qualification_input_hash. None of those exist on the frozen
 * ReviewDecisionRecord, so they are deliberately NOT selected: a column added to
 * the table later cannot silently enter the hydrated shape.
 */
const COLUMNS = [
  'review_decision_id',
  'request_id',
  'decision_type',
  'reviewer_user_id',
  'reviewer_capability',
  'opportunity_key',
  'evidence_fingerprint',
  'claim_hash',
  'review_packet_hash',
  'review_contract_version',
  'qualification_version',
  'hra_version',
  'presentation_mode',
  'demonstrability',
  'temporal_frame',
  'decision_timestamp',
  'reviewed_prose_hash',
  'structured_rejection_reason',
  'bounded_reviewer_note',
  'revokes_review_decision_id',
].join(', ');

let historyClient: SupabaseClient | null = null;

/**
 * Created lazily, never at module load, so an unconfigured environment fails
 * closed instead of making this file unimportable.
 */
function client(): SupabaseClient | null {
  if (historyClient) return historyClient;
  const url = process.env[SUPABASE_URL_VAR];
  const key = process.env[SERVICE_ROLE_KEY_VAR];
  if (!url || !key) return null;
  historyClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return historyClient;
}

/** Test seam. Never call this from production code. */
export function UNSAFE_setHistoryClientForTests(stub: unknown): void {
  historyClient = stub as SupabaseClient | null;
}

export type HistoryFailureCode =
  | 'history_store_not_configured'
  | 'history_lookup_failed'
  | 'history_row_malformed';

export type DecisionHistoryOutcome =
  | { ok: true; decisions: ReviewDecisionRecord[] }
  /**
   * `detail` is an INTERNAL diagnostic. It may contain database text and must
   * never be returned to an HTTP caller; only `code` is stable and safe to map.
   */
  | { ok: false; code: HistoryFailureCode; detail: string };

// ── field validators ────────────────────────────────────────────────────────
// Written without backslash escapes so the patterns survive any tooling that
// mishandles them: [.] rather than an escaped dot, [0-9] rather than a class
// shorthand.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX32 = /^[0-9a-f]{32}$/;
/**
 * The NORMALIZED frozen form, with exactly three fractional digits. This is
 * what migration 011's decision_timestamp CHECK stores and what
 * normalizedDecisionTimestamp produces, so a stored row that does not match it
 * could not have been written through the accepted path.
 */
const NORMALIZED_ISO =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$/;

const DECISION_TYPES: readonly string[] = Object.freeze([
  'APPROVE_PRESENTATION', 'REJECT', 'REVOKE',
]);

/** Thrown only inside hydration; converted to a bounded code by the caller. */
class MalformedHistoryRow extends Error {
  constructor(readonly column: string, detail: string) {
    super(`${column}: ${detail}`);
    this.name = 'MalformedHistoryRow';
  }
}

function nonEmptyString(row: Record<string, unknown>, column: string): string {
  const v = row[column];
  if (typeof v !== 'string') {
    throw new MalformedHistoryRow(column, `expected string, got ${v === null ? 'null' : typeof v}`);
  }
  if (v.length === 0) throw new MalformedHistoryRow(column, 'must not be empty');
  return v;
}

function matching(row: Record<string, unknown>, column: string, pattern: RegExp, what: string): string {
  const v = nonEmptyString(row, column);
  if (!pattern.test(v)) throw new MalformedHistoryRow(column, `is not ${what}`);
  return v;
}

function exactly(row: Record<string, unknown>, column: string, expected: string): string {
  const v = nonEmptyString(row, column);
  if (v !== expected) throw new MalformedHistoryRow(column, `expected ${expected}, got ${v}`);
  return v;
}

/** null and undefined both mean ABSENT; anything else must be a string. */
function optionalString(row: Record<string, unknown>, column: string): string | undefined {
  const v = row[column];
  if (v === null || v === undefined) return undefined;
  if (typeof v !== 'string') {
    throw new MalformedHistoryRow(column, `expected string or null, got ${typeof v}`);
  }
  if (v.length === 0) throw new MalformedHistoryRow(column, 'present but empty');
  return v;
}

// ── historical attribution hydration ────────────────────────────────────────

/**
 * Converts one persisted row into the frozen historical record shape.
 *
 * VALIDATE BEFORE ASSERT. Every field is checked first; the row is never cast
 * wholesale. `row as ReviewDecisionRecord` would accept any shape the database
 * happened to return.
 *
 * ABSENT IS NOT NULL. The three optional fields are omitted when the column is
 * NULL rather than set to null, because the frozen layer tests them with
 * `!== undefined`: a hydrated null would make an APPROVE look like it carried a
 * rejection reason.
 *
 * Throws MalformedHistoryRow, which the caller converts to history_row_malformed.
 */
function hydrateRecordedDecision(raw: unknown): ReviewDecisionRecord {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new MalformedHistoryRow('row', 'expected an object');
  }
  const row = raw as Record<string, unknown>;

  const decisionType = nonEmptyString(row, 'decision_type');
  if (!DECISION_TYPES.includes(decisionType)) {
    throw new MalformedHistoryRow('decision_type', `unknown decision type ${decisionType}`);
  }

  // Validated as a UUID BEFORE the attribution assertion below.
  const recordedReviewer = matching(row, 'reviewer_user_id', UUID, 'a uuid');

  // ── HISTORICAL ATTRIBUTION ASSERTION ──────────────────────────────────────
  // This restores historical attribution recorded at write time.
  // It does not establish current authentication or authorization.
  // Current review authority can only come from requirePresentationApprove.
  //
  // The value is an auth.users id that was verified, and confirmed to hold an
  // active presentation.approve, at the moment this immutable row was written.
  // Reading it back asserts nothing about now: not that the account still
  // exists, not that it is authenticated, not that it still holds the
  // capability, and not that it may approve, revoke or persist anything.
  //
  // Kept local on purpose. There is deliberately no exported helper that can
  // brand an arbitrary string.
  const reviewerId = recordedReviewer as unknown as TrustedReviewerIdentity;
  // ──────────────────────────────────────────────────────────────────────────

  const reason = optionalString(row, 'structured_rejection_reason');
  if (reason !== undefined && !REJECTION_REASONS.includes(reason)) {
    throw new MalformedHistoryRow('structured_rejection_reason', `not in the frozen vocabulary: ${reason}`);
  }

  const note = optionalString(row, 'bounded_reviewer_note');
  if (note !== undefined && note.length > MAX_REVIEWER_NOTE_CHARS) {
    throw new MalformedHistoryRow('bounded_reviewer_note', `exceeds ${MAX_REVIEWER_NOTE_CHARS} characters`);
  }

  const revokesRaw = optionalString(row, 'revokes_review_decision_id');
  if (revokesRaw !== undefined && !UUID.test(revokesRaw)) {
    throw new MalformedHistoryRow('revokes_review_decision_id', 'is not a uuid');
  }

  const record: ReviewDecisionRecord = {
    reviewDecisionId: matching(row, 'review_decision_id', UUID, 'a uuid'),
    requestId: nonEmptyString(row, 'request_id'),
    decisionType: decisionType as ReviewDecisionType,
    reviewerId,
    // The frozen ReviewerCapability type is a single literal, and migration 011
    // pins the column to it, so anything else cannot faithfully hydrate.
    reviewerCapability: exactly(
      row, 'reviewer_capability', PRESENTATION_APPROVE_CAPABILITY) as ReviewerCapability,

    // Opaque upstream identifiers: presence only, never a format guess.
    opportunityKey: nonEmptyString(row, 'opportunity_key'),
    evidenceFingerprint: nonEmptyString(row, 'evidence_fingerprint'),
    claimHash: nonEmptyString(row, 'claim_hash'),
    // Produced in this repository by reviewPacketHash(), so the width is known.
    reviewPacketHash: matching(row, 'review_packet_hash', HEX32, '32 lowercase hex characters'),

    // Recorded as observed. NO value check: which versions are acceptable is
    // policy that validateReviewDecision owns for NEW decisions, and a
    // historical decision may legitimately predate the current contract.
    reviewContractVersion: nonEmptyString(row, 'review_contract_version'),
    qualificationVersion: nonEmptyString(row, 'qualification_version'),
    hraVersion: nonEmptyString(row, 'hra_version'),

    // Also recorded as observed: a REJECT may carry any mode, and only the
    // approve path pins these to the approvable constants.
    presentationMode: nonEmptyString(row, 'presentation_mode'),
    demonstrability: nonEmptyString(row, 'demonstrability'),
    // Pinned by both the frozen constant and the migration-011 CHECK.
    temporalFrame: exactly(row, 'temporal_frame', TEMPORAL_FRAME),

    decisionTimestamp: matching(
      row, 'decision_timestamp', NORMALIZED_ISO, 'a normalized ISO timestamp'),
    reviewedProseHash: matching(
      row, 'reviewed_prose_hash', HEX32, '32 lowercase hex characters'),
  };

  // Added only when present, so the key is absent rather than null.
  if (reason !== undefined) record.structuredRejectionReason = reason as RejectionReason;
  if (note !== undefined) record.boundedReviewerNote = note;
  if (revokesRaw !== undefined) record.revokesReviewDecisionId = revokesRaw;

  return record;
}

// ── the reader ──────────────────────────────────────────────────────────────

/**
 * Every recorded decision for exactly one opportunity, oldest first.
 *
 * SCOPE. Filtered server-side on an exact opportunity_key match. The whole
 * table is never loaded and filtered in JavaScript, and there is deliberately
 * no "latest" shortcut: the frozen functions need the COMPLETE history for the
 * opportunity, because a revocation de-authorizes a whole binding and
 * supersession depends on every decision in order.
 *
 * ORDERING. Ordering authority belongs to the frozen orderDecisions, which
 * sorts on normalizedDecisionTimestamp then reviewDecisionId. Callers must
 * still pass the result through it rather than relying on this query. The
 * ORDER BY below is nonetheless deterministic, and because decision_timestamp
 * is stored in the normalized form it sorts the same way, so the two agree.
 *
 * Returns an empty history for an unreviewed opportunity; that is not an error.
 *
 * SELECT ONLY. No insert, update, upsert, delete or rpc is reachable from here.
 */
export async function loadDecisionsForOpportunity(
  opportunityKey: string,
): Promise<DecisionHistoryOutcome> {
  if (typeof opportunityKey !== 'string' || opportunityKey.length === 0) {
    return {
      ok: false,
      code: 'history_row_malformed',
      detail: 'opportunityKey must be a non-empty string',
    };
  }

  const supabase = client();
  if (!supabase) {
    return {
      ok: false,
      code: 'history_store_not_configured',
      detail: `reading review history requires ${SUPABASE_URL_VAR} and ${SERVICE_ROLE_KEY_VAR}`,
    };
  }

  let rows: unknown;
  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select(COLUMNS)
      .eq('opportunity_key', opportunityKey)
      .order('decision_timestamp', { ascending: true })
      .order('review_decision_id', { ascending: true });
    if (error) {
      return {
        ok: false,
        code: 'history_lookup_failed',
        detail: error.message ?? 'select returned an error',
      };
    }
    rows = data;
  } catch (cause) {
    return {
      ok: false,
      code: 'history_lookup_failed',
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  }

  if (rows === null || rows === undefined) return { ok: true, decisions: [] };
  if (!Array.isArray(rows)) {
    return { ok: false, code: 'history_lookup_failed', detail: 'select did not return an array' };
  }

  // Fail closed on the WHOLE history: a single unhydratable row means the
  // recorded history cannot be reconstructed faithfully, and deriving status
  // from a partial history could silently read a revoked binding as current.
  const decisions: ReviewDecisionRecord[] = [];
  for (const raw of rows) {
    try {
      decisions.push(hydrateRecordedDecision(raw));
    } catch (cause) {
      const where = cause instanceof MalformedHistoryRow ? cause.message : String(cause);
      return {
        ok: false,
        code: 'history_row_malformed',
        detail: `a recorded decision for this opportunity could not be hydrated (${where})`,
      };
    }
  }

  return { ok: true, decisions };
}
