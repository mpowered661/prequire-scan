// Deterministic re-derivation of ReviewPackets from the immutable artifact.
//
// This is the function a future Phase 2b approval boundary calls to learn what
// the current ReviewPacket actually is. It accepts a SCAN IDENTITY ONLY. There
// is deliberately no parameter by which a caller could supply a packet, an
// evidence array, a claim, a hash or a qualification outcome — the type system
// makes client-supplied evidence unrepresentable here rather than merely
// discouraged.
//
// It performs no network access and never re-scans: the evidence is whatever
// the scan observed, read back from the immutable row. Re-scanning at approval
// time would change the evidence being approved.

import { qualify } from '../opportunity-qualification/qualify';
import type { QualificationInput } from '../opportunity-qualification/types';
import { deriveReview, type QualificationResultView } from '../opportunity-review/review-packet';
import type { ReviewDerivation } from '../opportunity-review/types';
import { qualificationInputHash } from './canonical-hash';
import {
  ACCEPTED_QUALIFICATION_VERSION,
  QUALIFICATION_INPUT_SCHEMA_VERSION,
  type ReconstructionCode,
  type StoredQualificationInputRow,
} from './contract';
import { reconstructQualificationInput } from './reconstruct';

export interface RederivationFailure {
  code: ReconstructionCode | 'not_found' | 'database_error' | 'qualification_refused' | 'review_refused';
  detail: string;
}

export type RederivationOutcome =
  | { ok: true; input: QualificationInput; review: ReviewDerivation; inputHash: string }
  | { ok: false; failures: RederivationFailure[] };

/**
 * Pure half of the re-derivation, separated so it is testable without a
 * database: verify versions, reconstruct, re-verify the content hash, then run
 * the two accepted pure layers.
 *
 * The hash is RECOMPUTED from the reconstructed value and compared to the
 * stored one. That is what detects a payload edited after it was written: the
 * row's own hash column cannot vouch for the row's own payload.
 */
export function rederiveFromRow(row: StoredQualificationInputRow): RederivationOutcome {
  const failures: RederivationFailure[] = [];

  if (row.input_schema_version !== QUALIFICATION_INPUT_SCHEMA_VERSION) {
    failures.push({ code: 'schema_version_mismatch', detail: `${row.input_schema_version} != ${QUALIFICATION_INPUT_SCHEMA_VERSION}` });
  }
  if (row.qualification_version !== ACCEPTED_QUALIFICATION_VERSION) {
    failures.push({ code: 'qualification_version_mismatch', detail: `${row.qualification_version} != ${ACCEPTED_QUALIFICATION_VERSION}` });
  }
  if (failures.length > 0) return { ok: false, failures };

  const reconstructed = reconstructQualificationInput(row.payload, row.scan_id);
  if (!reconstructed.ok) return { ok: false, failures: reconstructed.failures };

  const inputHash = qualificationInputHash(reconstructed.input);
  if (inputHash !== row.input_hash) {
    return {
      ok: false,
      failures: [{ code: 'input_hash_mismatch', detail: `stored ${row.input_hash} but reconstructed payload hashes to ${inputHash}` }],
    };
  }

  let review: ReviewDerivation;
  try {
    const qualification = qualify(reconstructed.input) as unknown as QualificationResultView;
    try {
      review = deriveReview(qualification);
    } catch (e) {
      return { ok: false, failures: [{ code: 'review_refused', detail: (e as Error).message }] };
    }
  } catch (e) {
    return { ok: false, failures: [{ code: 'qualification_refused', detail: (e as Error).message }] };
  }

  return { ok: true, input: reconstructed.input, review, inputHash };
}

/**
 * Loads the immutable artifact for a scan and re-derives its ReviewPackets.
 *
 * SCAN IDENTITY ONLY. No evidence, no packet and no claim can be passed in.
 */
export async function deriveReviewPacketsFromStoredQualificationInput(
  scanId: string,
): Promise<RederivationOutcome> {
  // Imported lazily so the PURE `rederiveFromRow` above can be used, and
  // tested, without constructing a database client.
  const { loadQualificationInputRow } = await import('./store');
  const loaded = await loadQualificationInputRow(scanId);
  if (!loaded.ok) return { ok: false, failures: [{ code: loaded.code, detail: loaded.detail }] };
  return rederiveFromRow(loaded.row);
}
