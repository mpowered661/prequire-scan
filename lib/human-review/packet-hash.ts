// Human Review & Approval v0.1 — deterministic review_packet_hash.
//
// `claimHash` binds canonical claim MEANING. It does not bind every
// review-relevant property the human relied on. `review_packet_hash`
// additionally binds the packet-level facts that materially affect whether the
// packet is approvable.
//
// Display prose is deliberately EXCLUDED, so punctuation and whitespace can
// never alter packet identity.
//
// Determinism: sorted keys, set-like arrays normalized by their own rule, refs
// deduplicated and sorted. No dependence on insertion order, Map iteration
// order, filesystem state, locale-sensitive collation, wall clock, randomness
// or network.

import { createHash } from 'node:crypto';
import type { EvidenceRefView, ReviewPacketView } from './types';

/** Byte-wise ordering, not locale-sensitive collation. */
function byteCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function refKey(r: EvidenceRefView): string {
  return [
    r.kind, r.scanId, r.subjectUrl,
    r.engine ?? '', r.engineVersion ?? '', r.contentSha256 ?? '',
    r.scope, r.observedAt ?? '',
  ].join('\u0001');
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
  return createHash('sha256').update(parts.join('\u0002')).digest('hex').slice(0, 32);
}

/**
 * Deterministic digest of the twelve-gate trace. Gate order is normalized by
 * gate id so a reordered trace yields the same digest, while a changed outcome
 * does not.
 */
export function gateTraceDigest(trace: readonly { gate: string; passed: boolean }[]): string {
  const parts = [...trace]
    .map(g => `${g.gate}=${g.passed ? '1' : '0'}`)
    .sort(byteCompare);
  return createHash('sha256').update(parts.join('\u0003')).digest('hex').slice(0, 32);
}

/**
 * The exact inputs frozen by contract. Display prose is absent.
 */
export function canonicalPacketJson(packet: ReviewPacketView): string {
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
