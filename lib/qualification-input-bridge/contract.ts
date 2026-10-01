// Trusted scan -> QualificationInput bridge v0.1 — frozen contract.
//
// This layer is the ONLY trusted path by which a QualificationInput comes into
// existence. It sits between the accepted site-discovery observation pipeline
// and the accepted (pure) qualification and opportunity-review layers, and it
// adds the one thing those layers cannot provide for themselves: an immutable,
// content-addressed record of the exact input they were given.
//
// TRUST MODEL
//   untrusted target domain
//     -> server-side bounded runScan        (server-observed evidence)
//       -> pure adapter                      (no I/O, no network)
//         -> validated QualificationInput
//           -> canonical hash
//             -> immutable persistence       (unique per scan event)
//
// A QualificationInput is an immutable INPUT artifact. It is not a cache, not an
// approval, not a ReviewPacket, not a PresentationSnapshot, and never
// human-approved truth. It is the record from which qualification and review can
// be reproduced byte-for-byte.

/**
 * Schema identity of the persisted payload. A stored row carrying a different
 * value is refused rather than coerced.
 */
export const QUALIFICATION_INPUT_SCHEMA_VERSION = 'qualification-input/0.1';

/**
 * Canonicalization identity of `input_hash`. Separate from the schema version
 * because the encoding could change without the payload shape changing.
 */
export const QUALIFICATION_INPUT_HASH_VERSION = 'qualification-input-hash/0.1';

/** The qualification contract this bridge is calibrated against. */
export const ACCEPTED_QUALIFICATION_VERSION = 'oq-0.1.1';

/** Scan modes the qualification contract accepts. */
export const ACCEPTED_SCAN_MODES: readonly string[] = Object.freeze([
  'prospect_observation',
  'authorized_customer_scan',
]);

/** The eight coverage counters, exported so a test can assert completeness. */
export const COVERAGE_COUNTERS: readonly string[] = Object.freeze([
  'discovered', 'selected', 'fetched', 'analysisComplete',
  'uniqueInternalTargets', 'targetsChecked', 'targetsUnchecked', 'siteTotalKnown',
]);

// ── refusal codes ────────────────────────────────────────────

/** Why an observation may not become a QualificationInput. */
export type IncompleteObservationCode =
  | 'scan_aborted'
  | 'page_observations_absent'
  | 'link_targets_absent'
  | 'link_relationships_absent'
  | 'page_analysis_manifest_absent'
  | 'link_integrity_manifest_absent'
  | 'scan_id_mismatch'
  | 'seed_url_missing'
  | 'unsupported_scan_mode';

/** Why a stored payload may not be reconstructed. */
export type ReconstructionCode =
  | 'schema_version_mismatch'
  | 'qualification_version_mismatch'
  | 'input_hash_mismatch'
  | 'payload_not_object'
  | 'missing_required_field'
  | 'wrong_primitive_type'
  | 'unexpected_prototype'
  | 'forbidden_key'
  | 'non_json_value'
  | 'non_finite_number'
  | 'scan_id_association_mismatch';

/** Why persistence refused. */
export type PersistCode =
  | 'conflicting_payload_for_scan'
  | 'database_error';

/**
 * Keys that must never appear as own properties anywhere in a persisted or
 * reconstructed payload. `__proto__` assignment mutates a prototype instead of
 * creating an own property, and `constructor`/`prototype` shapes are refused
 * outright rather than stripped.
 */
export const FORBIDDEN_PAYLOAD_KEYS: readonly string[] = Object.freeze([
  '__proto__', 'constructor', 'prototype',
]);

// ── persisted row shape ──────────────────────────────────────

/**
 * The stored artifact as a plain row. Declared here, not in the store module,
 * so the PURE re-derivation path can type a row without importing a database
 * client. `payload` is deliberately `unknown`: it is never cast, only validated.
 */
export interface StoredQualificationInputRow {
  scan_id: string;
  input_schema_version: string;
  qualification_version: string;
  input_hash: string;
  payload: unknown;
  created_at: string;
}
