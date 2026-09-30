// Opportunity Qualification v0.1 — deterministic evidence clustering.
//
// One cluster = one proposition, one subject, one scope level, one scan.
// 25 source relationships to one broken destination produce ONE cluster.
// One check failing on N pages produces ONE cluster.

import { createHash } from 'node:crypto';
import { dedupeRefs } from './signals';
import { weakestLink } from './confidence';
import type { EvidenceCluster, EvidenceRef, Signal } from './types';

export class CrossScanClusterError extends Error {
  constructor() { super('cross_scan_cluster_forbidden'); }
}

function sha(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);
}

/**
 * Stable proposition identity. Deliberately excludes scanId, counts, evidence
 * refs and any presentation wording, so that the SAME proposition observed in a
 * later scan carries the SAME key.
 */
export function opportunityKeyOf(detector: string, subject: string, scopeLevel: string, condition: string): string {
  return sha(['oq', detector, subject, scopeLevel, condition]);
}

/**
 * The current evidence realization behind a proposition. Changes whenever the
 * evidence changes — a different scan, different counts, different content
 * hashes or different engine versions. A future approval binds to this, so a
 * changed fingerprint invalidates the approval while the opportunity key stays
 * the same.
 */
export function evidenceFingerprintOf(
  scanId: string,
  detectorVersion: string,
  numerator: number | null,
  denominator: number | null,
  refs: EvidenceRef[],
): string {
  const refParts = dedupeRefs(refs).map(r =>
    [r.kind, r.subjectUrl, r.engine ?? '', r.engineVersion ?? '', r.contentSha256 ?? ''].join('|'));
  return sha(['ef', scanId, detectorVersion, String(numerator), String(denominator), ...refParts]);
}

/**
 * Clusters signals. Signals merge only when detector, subject, scope level and
 * condition all match — never across scans, never across detectors, never
 * across unrelated conditions.
 */
export function buildClusters(signals: Signal[]): EvidenceCluster[] {
  if (signals.length === 0) return [];
  const scanIds = new Set(signals.flatMap(s => s.evidenceRefs.map(r => r.scanId)));
  if (scanIds.size > 1) throw new CrossScanClusterError();
  const scanId = [...scanIds][0] ?? '';

  const groups = new Map<string, Signal[]>();
  for (const signal of signals) {
    const key = [signal.detector, signal.subject, signal.scopeLevel, signal.condition].join('\u0000');
    groups.set(key, [...(groups.get(key) ?? []), signal]);
  }

  const clusters: EvidenceCluster[] = [];
  for (const key of [...groups.keys()].sort()) {
    const members = groups.get(key)!;
    const head = members[0];
    const refs = dedupeRefs(members.flatMap(s => s.evidenceRefs));

    // Counts are derived from DEDUPED refs so duplicate evidence cannot inflate.
    const affectedPageCount = new Set(refs.filter(r => r.kind === 'page_observation').map(r => r.subjectUrl)).size;
    const sourceLinkCount = new Set(refs.filter(r => r.kind === 'link_relationship').map(r => r.subjectUrl)).size;

    // Denominators are preserved, never recomputed upward.
    const denominator = head.denominator;
    const numerator = head.scopeLevel === 'analyzed_sample'
      ? affectedPageCount
      : members.reduce((n, s) => Math.max(n, s.numerator ?? 0), 0);

    clusters.push({
      clusterKey: sha(['ck', scanId, head.detector, head.detectorVersion, head.subject, head.scopeLevel, head.condition]),
      opportunityKey: opportunityKeyOf(head.detector, head.subject, head.scopeLevel, head.condition),
      evidenceFingerprint: evidenceFingerprintOf(scanId, head.detectorVersion, numerator, denominator, refs),
      scanId,
      detector: head.detector,
      detectorVersion: head.detectorVersion,
      subject: head.subject,
      condition: head.condition,
      polarity: head.polarity,
      scopeLevel: head.scopeLevel,
      numerator,
      denominator,
      affectedPageCount,
      sourceLinkCount,
      determinable: members.every(s => s.determinable),
      undeterminableCount: members.reduce((n, s) => n + s.undeterminableCount, 0),
      signalKeys: [...new Set(members.map(s => s.signalKey))].sort(),
      evidenceRefs: refs,
      provenance: weakestLink(members.map(s => s.provenance)),
      facts: Object.freeze(Object.assign({}, ...members.map(s => s.facts))),
    });
  }
  return clusters.sort((a, b) => a.clusterKey.localeCompare(b.clusterKey));
}
