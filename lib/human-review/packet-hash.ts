// Human Review & Approval v0.1.1 — deterministic review_packet_hash.
//
// `claimHash` binds canonical claim MEANING. It does not bind every
// review-relevant property the human relied on. `review_packet_hash`
// additionally binds the packet-level facts that materially affect whether the
// packet is approvable.
//
// Display prose is deliberately EXCLUDED, so punctuation and whitespace can
// never alter packet identity.
//
// CANONICALIZATION (changed in hra-0.1.1):
// Sub-digests are STRUCTURALLY encoded as canonical JSON, not concatenated with
// reserved delimiter bytes. Field boundaries therefore come from the JSON
// grammar, and `JSON.stringify` escapes quotes, backslashes and control
// characters. Under hra-0.1 the encoding joined fields with raw 0x01/0x02/0x03
// and gate entries with "=", which let a value containing those bytes imitate a
// field boundary: one crafted evidence reference could encode — and therefore
// hash — identically to two genuine ones, and one crafted gate identically to
// two genuine gates. That class of collision is structurally impossible here.
//
// Determinism: fixed key order, set-like collections normalized by their own
// rule, refs deduplicated and byte-sorted. No dependence on insertion order,
// Map iteration order, filesystem state, locale-sensitive collation, wall
// clock, randomness or network.

import { createHash } from 'node:crypto';
import type { EvidenceRefView, ReviewPacketView } from './types';

/**
 * Thrown when a packet identity input is absent or of the wrong runtime type.
 *
 * Hashing a malformed packet FAILS CLOSED rather than proceeding, because
 * `JSON.stringify` omits `undefined` properties: without this check an
 * incomplete packet would hash successfully, and a packet missing a field would
 * be indistinguishable from one whose field was explicitly undefined.
 * TypeScript types are not relied upon, since a packet can arrive from JSON.
 */
export class InvalidPacketIdentityError extends Error {
  constructor(readonly field: string, readonly detail: string) {
    super(`packet identity input "${field}" is invalid: ${detail}`);
    this.name = 'InvalidPacketIdentityError';
  }
}

/** Byte-wise ordering, not locale-sensitive collation. */
function byteCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Canonical encoding of one evidence reference: a fixed-arity JSON array.
 * Nullable fields encode as `null`, which is distinct from an empty string.
 */
function refKey(r: EvidenceRefView): string {
  return JSON.stringify([
    r.kind, r.scanId, r.subjectUrl,
    r.engine ?? null, r.engineVersion ?? null, r.contentSha256 ?? null,
    r.scope, r.observedAt ?? null,
  ]);
}

/** Deduplicated and byte-sorted, so input order cannot affect the digest. */
export function normalizeRefs(refs: readonly EvidenceRefView[]): EvidenceRefView[] {
  const seen = new Set<string>();
  const out: EvidenceRefView[] = [];
  for (const r of refs) {
    const k = refKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out.sort((a, b) => byteCompare(refKey(a), refKey(b)));
}

export function supportingEvidenceRefsDigest(refs: readonly EvidenceRefView[]): string {
  const parts = normalizeRefs(refs).map(refKey);
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}

/**
 * Deterministic digest of the twelve-gate trace. Gate order is normalized so a
 * reordered trace yields the same digest, while a changed outcome does not.
 *
 * Each entry encodes as `["<gate>",<bool>]`, so a gate name containing "=" or a
 * control character cannot imitate two entries.
 */
export function gateTraceDigest(trace: readonly { gate: string; passed: boolean }[]): string {
  const parts = [...trace]
    .map(g => JSON.stringify([g.gate, g.passed]))
    .sort(byteCompare);
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}

/** The required identity fields that must be non-empty strings. */
const REQUIRED_STRING_FIELDS = [
  'opportunityKey', 'evidenceFingerprint', 'claimHash', 'qualificationStatus',
  'presentationPermission', 'presentationMode', 'demonstrabilityStatus',
  'temporalFrame', 'reviewContractVersion', 'qualificationVersion',
] as const;

/**
 * Validates every packet identity input before canonicalization. Rejects
 * absent, null, non-string and empty values, and rejects a non-boolean
 * `meetsScoutEvidenceRequirements`, so no identity field can be silently
 * dropped from the canonical form.
 */
export function assertPacketIdentityInputs(packet: ReviewPacketView): void {
  const p = packet as unknown as Record<string, unknown>;

  for (const field of REQUIRED_STRING_FIELDS) {
    const v = p[field];
    if (typeof v !== 'string') throw new InvalidPacketIdentityError(field, `expected string, got ${v === null ? 'null' : typeof v}`);
    if (v.length === 0) throw new InvalidPacketIdentityError(field, 'must not be empty');
  }

  if (typeof p.meetsScoutEvidenceRequirements !== 'boolean') {
    throw new InvalidPacketIdentityError('meetsScoutEvidenceRequirements',
      `expected boolean, got ${p.meetsScoutEvidenceRequirements === null ? 'null' : typeof p.meetsScoutEvidenceRequirements}`);
  }

  if (!Array.isArray(p.gateTrace)) {
    throw new InvalidPacketIdentityError('gateTrace', `expected array, got ${typeof p.gateTrace}`);
  }
  p.gateTrace.forEach((g: unknown, i: number) => {
    const e = g as Record<string, unknown> | null;
    if (e === null || typeof e !== 'object') throw new InvalidPacketIdentityError(`gateTrace[${i}]`, 'expected object');
    if (typeof e.gate !== 'string' || e.gate.length === 0) throw new InvalidPacketIdentityError(`gateTrace[${i}].gate`, 'expected non-empty string');
    if (typeof e.passed !== 'boolean') throw new InvalidPacketIdentityError(`gateTrace[${i}].passed`, 'expected boolean');
  });

  if (!Array.isArray(p.evidenceRefs)) {
    throw new InvalidPacketIdentityError('evidenceRefs', `expected array, got ${typeof p.evidenceRefs}`);
  }
  p.evidenceRefs.forEach((r: unknown, i: number) => {
    const e = r as Record<string, unknown> | null;
    if (e === null || typeof e !== 'object') throw new InvalidPacketIdentityError(`evidenceRefs[${i}]`, 'expected object');
    for (const field of ['kind', 'scanId', 'subjectUrl', 'scope'] as const) {
      if (typeof e[field] !== 'string' || (e[field] as string).length === 0) {
        throw new InvalidPacketIdentityError(`evidenceRefs[${i}].${field}`, 'expected non-empty string');
      }
    }
    for (const field of ['engine', 'engineVersion', 'contentSha256', 'observedAt'] as const) {
      const v = e[field];
      if (v !== null && typeof v !== 'string') {
        throw new InvalidPacketIdentityError(`evidenceRefs[${i}].${field}`, `expected string or null, got ${typeof v}`);
      }
    }
  });
}

/**
 * The exact inputs frozen by contract. Display prose is absent.
 *
 * Key order is fixed by this literal, so the serialization never depends on the
 * property order of the incoming object.
 */
export function canonicalPacketJson(packet: ReviewPacketView): string {
  assertPacketIdentityInputs(packet);
  const ordered = {
    claimHash: packet.claimHash,
    demonstrabilityStatus: packet.demonstrabilityStatus,
    evidenceFingerprint: packet.evidenceFingerprint,
    gateTraceDigest: gateTraceDigest(packet.gateTrace),
    meetsScoutEvidenceRequirements: packet.meetsScoutEvidenceRequirements,
    opportunityKey: packet.opportunityKey,
    presentationMode: packet.presentationMode,
    presentationPermission: packet.presentationPermission,
    qualificationStatus: packet.qualificationStatus,
    qualificationVersion: packet.qualificationVersion,
    reviewContractVersion: packet.reviewContractVersion,
    supportingEvidenceRefsDigest: supportingEvidenceRefsDigest(packet.evidenceRefs),
    temporalFrame: packet.temporalFrame,
  };
  return JSON.stringify(ordered);
}

export function reviewPacketHash(packet: ReviewPacketView): string {
  return createHash('sha256').update(canonicalPacketJson(packet)).digest('hex').slice(0, 32);
}

/**
 * The bounded audit record of the exact prose a reviewer saw. Audit evidence
 * only — never claim identity and never packet identity.
 */
export function reviewedProseHash(prose: string): string {
  return createHash('sha256').update(prose).digest('hex').slice(0, 32);
}

/** The thirteen hash inputs, exported so a test can assert the set is complete. */
export const PACKET_HASH_INPUTS: readonly string[] = Object.freeze([
  'opportunityKey',
  'evidenceFingerprint',
  'claimHash',
  'qualificationStatus',
  'gateTraceDigest',
  'presentationPermission',
  'presentationMode',
  'demonstrabilityStatus',
  'meetsScoutEvidenceRequirements',
  'temporalFrame',
  'reviewContractVersion',
  'qualificationVersion',
  'supportingEvidenceRefsDigest',
]);
