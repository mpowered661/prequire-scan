// Immutable persistence for the QualificationInput artifact.
//
// INSERT AND SELECT ONLY. There is deliberately no update, no upsert, no
// delete and no "latest" pointer: one scan event owns at most one input, and a
// changed observation requires a NEW scan_id. A retry of the identical payload
// reuses the stored row; a different payload for the same scan is a CONFLICT
// that is reported, never written over.
//
// The client pattern matches the rest of the repository: a module-level
// service-role client (see lib/supabase/siteScans.ts).

import { createClient } from '@supabase/supabase-js';
import type { QualificationInput } from '../opportunity-qualification/types';
import { qualificationInputHash } from './canonical-hash';
import {
  ACCEPTED_QUALIFICATION_VERSION,
  QUALIFICATION_INPUT_SCHEMA_VERSION,
  type PersistCode,
  type StoredQualificationInputRow,
} from './contract';

export type { StoredQualificationInputRow };

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const TABLE = 'qualification_inputs';

export type PersistOutcome =
  | { ok: true; created: boolean; scanId: string; inputHash: string }
  | { ok: false; code: PersistCode; detail: string };

export type LoadOutcome =
  | { ok: true; row: StoredQualificationInputRow }
  | { ok: false; code: 'not_found' | 'database_error'; detail: string };

/**
 * Persists the artifact for a scan exactly once.
 *
 * `created: false` means an identical artifact already existed and was reused —
 * the idempotent retry path. A unique violation on scan_id is resolved by
 * reading the stored hash: equal means the same observation, different means
 * CONFLICT and nothing is written.
 */
export async function persistQualificationInput(input: QualificationInput): Promise<PersistOutcome> {
  const inputHash = qualificationInputHash(input);
  const row = {
    scan_id: input.scanId,
    input_schema_version: QUALIFICATION_INPUT_SCHEMA_VERSION,
    qualification_version: ACCEPTED_QUALIFICATION_VERSION,
    input_hash: inputHash,
    payload: input as unknown,
  };

  try {
    const { error } = await supabase.from(TABLE).insert(row);
    if (!error) return { ok: true, created: true, scanId: input.scanId, inputHash };

    // 23505 = unique violation on scan_id: this scan already owns an artifact.
    if (error.code === '23505') {
      const existing = await loadQualificationInputRow(input.scanId);
      if (!existing.ok) {
        return { ok: false, code: 'database_error', detail: `unique violation then ${existing.code}` };
      }
      if (existing.row.input_hash === inputHash) {
        return { ok: true, created: false, scanId: input.scanId, inputHash };
      }
      return {
        ok: false,
        code: 'conflicting_payload_for_scan',
        detail: `scan ${input.scanId} already holds ${existing.row.input_hash}; refusing to overwrite with ${inputHash}`,
      };
    }
    return { ok: false, code: 'database_error', detail: error.code ?? 'unknown' };
  } catch {
    return { ok: false, code: 'database_error', detail: 'transport' };
  }
}

/** Reads the immutable row for a scan. No fallback to a "latest" artifact. */
export async function loadQualificationInputRow(scanId: string): Promise<LoadOutcome> {
  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select('scan_id, input_schema_version, qualification_version, input_hash, payload, created_at')
      .eq('scan_id', scanId)
      .maybeSingle();
    if (error) return { ok: false, code: 'database_error', detail: error.code ?? 'unknown' };
    if (!data) return { ok: false, code: 'not_found', detail: `no qualification input for scan ${scanId}` };
    return { ok: true, row: data as StoredQualificationInputRow };
  } catch {
    return { ok: false, code: 'database_error', detail: 'transport' };
  }
}
