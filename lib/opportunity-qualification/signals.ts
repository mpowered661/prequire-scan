// Opportunity Qualification v0.1 — detectors.
//
// A detector turns durable observations into normalized Signals. A Signal is a
// fact about the evidence: it carries no severity, no outreach decision and no
// claim. Detectors read ONLY projected durable evidence — never raw HTML,
// never page prose, never a live engine.

import { DETECTORS } from './versions';
import type {
  ConditionPolarity,
  ScalarFacts,
  DurablePageObservation,
  EvidenceRef,
  ProvenanceClass,
  QualificationInput,
  Signal,
} from './types';

function refKey(ref: EvidenceRef): string {
  return [ref.kind, ref.scanId, ref.subjectUrl, ref.engine ?? '', ref.engineVersion ?? '', ref.contentSha256 ?? ''].join('\u0000');
}

/** Duplicate evidence must never inflate a count. */
export function dedupeRefs(refs: EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  const out: EvidenceRef[] = [];
  for (const ref of refs) {
    const key = refKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out.sort((a, b) => refKey(a).localeCompare(refKey(b)));
}

function pageRef(o: DurablePageObservation): EvidenceRef {
  return {
    kind: 'page_observation',
    scanId: o.scanId,
    subjectUrl: o.requestedUrl,
    engine: o.engine,
    engineVersion: o.engineVersion,
    contentSha256: o.contentSha256,
    scope: 'page',
    observedAt: o.observedAt,
  };
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/** URLs whose page analysis completed. Gate G4 depends on this set. */
function completeAnalysisUrls(input: QualificationInput): Set<string> {
  return new Set(
    input.scanUrls
      .filter(r => r.analysisState === 'complete' && r.urlNormalized !== null)
      .map(r => r.urlNormalized!),
  );
}

/** Observations from complete pages only, for one engine, status ok. */
function usableObservations(input: QualificationInput, engine: string): DurablePageObservation[] {
  const complete = completeAnalysisUrls(input);
  return input.pageObservations
    .filter(o => o.engine === engine && o.status === 'ok' && complete.has(o.requestedUrl))
    .sort((a, b) => a.requestedUrl.localeCompare(b.requestedUrl));
}

interface PageAggregate {
  condition: string;
  polarity: ConditionPolarity;
  determinable: boolean;
  matched: DurablePageObservation[];
}

function analyzedSampleSignal(
  detector: string,
  detectorVersion: string,
  subject: string,
  agg: PageAggregate,
  denominator: number,
  provenance: ProvenanceClass,
  undeterminableCount = 0,
  facts: ScalarFacts = {},
): Signal {
  const refs = dedupeRefs(agg.matched.map(pageRef));
  return {
    detector,
    detectorVersion,
    signalKey: `${detector}:${subject}:${agg.condition}`,
    subject,
    condition: agg.condition,
    polarity: agg.polarity,
    scopeLevel: 'analyzed_sample',
    // The numerator counts DISTINCT pages, derived from deduped refs.
    numerator: new Set(refs.map(r => r.subjectUrl)).size,
    denominator,
    determinable: agg.determinable,
    undeterminableCount,
    evidenceRefs: refs,
    provenance,
    facts,
  };
}

// ── 1. broken internal link destinations (Tranche C) ─────────

const ADVERSE_TARGET_CLASSIFICATIONS = new Set(['broken_4xx', 'server_failure_5xx']);

/**
 * Tranche C never checks an off-origin target, so a checked external target is
 * not representable in durable evidence. Treated as hostile input anyway: an
 * off-origin subject can never become an internally verified opportunity.
 */
function isOnScopeOrigin(targetUrl: string, domain: string): boolean {
  let host: string;
  try {
    host = new URL(targetUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  const d = domain.toLowerCase().replace(/^www\./, '');
  const h = host.replace(/^www\./, '');
  return h === d;
}

function detectBrokenTargets(input: QualificationInput): Signal[] {
  const out: Signal[] = [];
  const byTarget = new Map<string, typeof input.linkRelationships>();
  for (const rel of input.linkRelationships) {
    if (rel.targetUrlNormalized === null) continue;
    const list = byTarget.get(rel.targetUrlNormalized) ?? [];
    list.push(rel);
    byTarget.set(rel.targetUrlNormalized, list);
  }

  for (const target of [...input.linkTargets].sort((a, b) => a.targetUrlNormalized.localeCompare(b.targetUrlNormalized))) {
    // An unchecked target may never carry a classification, and may never be
    // treated as broken. A redirect is not a failure.
    if (target.checkState !== 'checked') continue;
    if (target.classification === null) continue;
    if (!ADVERSE_TARGET_CLASSIFICATIONS.has(target.classification)) continue;
    if (!isOnScopeOrigin(target.targetUrlNormalized, input.domain)) continue;

    const relationships = byTarget.get(target.targetUrlNormalized) ?? [];
    const refs: EvidenceRef[] = [
      {
        kind: 'link_target',
        scanId: input.scanId,
        subjectUrl: target.targetUrlNormalized,
        engine: null,
        engineVersion: null,
        contentSha256: null,
        scope: 'link_target',
        observedAt: target.checkedAt,
      },
      ...relationships.map(rel => ({
        kind: 'link_relationship' as const,
        scanId: input.scanId,
        subjectUrl: rel.sourceUrl,
        engine: null,
        engineVersion: null,
        contentSha256: null,
        scope: 'link_relationship' as const,
        observedAt: target.checkedAt,
      })),
    ];
    out.push({
      detector: 'broken_internal_target',
      detectorVersion: DETECTORS.broken_internal_target,
      signalKey: `broken_internal_target:${target.targetUrlNormalized}:${target.classification}`,
      subject: target.targetUrlNormalized,
      condition: target.classification,
      polarity: 'adverse',
      scopeLevel: 'checked_targets',
      numerator: 1,
      denominator: input.coverage.targetsChecked,
      determinable: true,
      undeterminableCount: 0,
      evidenceRefs: dedupeRefs(refs),
      // Prequire itself performed the check.
      provenance: 'verified',
      facts: {
        httpStatus: target.httpStatus,
        classification: target.classification,
        methodUsed: target.methodUsed,
        checkedAt: target.checkedAt,
        sourceLinkCount: target.sourceLinkCount,
        redirectHops: target.redirectHops,
      },
    });
  }
  return out;
}

// ── 2/3. per-check outcomes (extraction resilience) ──────────

function detectPageChecks(input: QualificationInput): Signal[] {
  const observations = usableObservations(input, 'extraction_resilience');
  const denominator = input.coverage.analysisComplete;
  const failed = new Map<string, DurablePageObservation[]>();
  const undet = new Map<string, DurablePageObservation[]>();

  for (const o of observations) {
    const checks = obj(o.observation).checks;
    if (!Array.isArray(checks)) continue;
    for (const raw of checks) {
      const c = obj(raw);
      const id = typeof c.id === 'string' ? c.id : null;
      if (!id) continue;
      if (c.status === 'fail') failed.set(id, [...(failed.get(id) ?? []), o]);
      // undeterminable is NOT a failure. It is recorded separately and is
      // never counted in a failure numerator.
      if (c.status === 'undeterminable') undet.set(id, [...(undet.get(id) ?? []), o]);
    }
  }

  const out: Signal[] = [];
  for (const id of [...failed.keys()].sort()) {
    out.push(analyzedSampleSignal(
      'page_check_failure', DETECTORS.page_check_failure, id,
      { condition: 'check_failed', polarity: 'adverse', determinable: true, matched: failed.get(id)! },
      denominator, 'extracted', 0, { checkId: id, engine: 'extraction_resilience' },
    ));
  }
  for (const id of [...undet.keys()].sort()) {
    const matched = undet.get(id)!;
    out.push(analyzedSampleSignal(
      'page_check_undeterminable', DETECTORS.page_check_undeterminable, id,
      { condition: 'check_undeterminable', polarity: 'indeterminate', determinable: false, matched },
      denominator, 'undeterminable', new Set(matched.map(o => o.requestedUrl)).size,
      { checkId: id, engine: 'extraction_resilience' },
    ));
  }
  return out;
}

// ── 4. extraction resilience band ────────────────────────────

const ADVERSE_BANDS = new Set(['fragile']);

function detectExtractionBand(input: QualificationInput): Signal[] {
  const observations = usableObservations(input, 'extraction_resilience');
  const byBand = new Map<string, DurablePageObservation[]>();
  for (const o of observations) {
    const band = obj(o.observation).band;
    if (typeof band !== 'string') continue;
    byBand.set(band, [...(byBand.get(band) ?? []), o]);
  }
  const out: Signal[] = [];
  for (const band of [...byBand.keys()].sort()) {
    const adverse = ADVERSE_BANDS.has(band);
    const insufficient = band === 'insufficient_evidence';
    out.push(analyzedSampleSignal(
      'extraction_band', DETECTORS.extraction_band, `band:${band}`,
      {
        condition: band,
        polarity: adverse ? 'adverse' : insufficient ? 'indeterminate' : 'healthy',
        determinable: !insufficient,
        matched: byBand.get(band)!,
      },
      input.coverage.analysisComplete,
      insufficient ? 'undeterminable' : 'extracted',
      insufficient ? byBand.get(band)!.length : 0,
      { band, engine: 'extraction_resilience' },
    ));
  }
  return out;
}

// ── 5. content delivery ──────────────────────────────────────

const ADVERSE_DELIVERY_STATUSES = new Set(['client_side_rendered', 'empty', 'js_challenge']);

function detectContentDelivery(input: QualificationInput): Signal[] {
  const observations = usableObservations(input, 'content_delivery');
  const byStatus = new Map<string, DurablePageObservation[]>();
  for (const o of observations) {
    const status = obj(o.observation).status;
    if (typeof status !== 'string') continue;
    byStatus.set(status, [...(byStatus.get(status) ?? []), o]);
  }
  const out: Signal[] = [];
  for (const status of [...byStatus.keys()].sort()) {
    if (!ADVERSE_DELIVERY_STATUSES.has(status)) continue;
    out.push(analyzedSampleSignal(
      'content_delivery_condition', DETECTORS.content_delivery_condition, `delivery:${status}`,
      { condition: status, polarity: 'adverse', determinable: true, matched: byStatus.get(status)! },
      input.coverage.analysisComplete, 'extracted', 0,
      {
        deliveryStatus: status,
        engine: 'content_delivery',
        contentAppearsRenderedOnAll: byStatus.get(status)!.every(o => (obj(o.observation).content_appears_rendered === true)),
      },
    ));
  }
  return out;
}

// ── 6. structured data ───────────────────────────────────────

function detectStructuredData(input: QualificationInput): Signal[] {
  const observations = usableObservations(input, 'structured_data');
  if (observations.length === 0) return [];
  const present = observations.filter(o => obj(o.observation).hasSchema === true);
  const malformed = observations.filter(o => obj(o.observation).hasMalformed === true);
  const absent = observations.filter(o => obj(o.observation).hasSchema !== true);
  const denominator = input.coverage.analysisComplete;
  const out: Signal[] = [];

  if (present.length > 0) {
    out.push(analyzedSampleSignal(
      'structured_data_presence', DETECTORS.structured_data_presence, 'structured_data',
      // Structured data being present is a HEALTHY state. It must never be
      // converted into an adverse opportunity.
      { condition: 'structured_data_present', polarity: 'healthy', determinable: true, matched: present },
      denominator, 'extracted',
    ));
  }
  if (absent.length > 0) {
    out.push(analyzedSampleSignal(
      'structured_data_presence', DETECTORS.structured_data_presence, 'structured_data',
      { condition: 'structured_data_absent', polarity: 'adverse', determinable: true, matched: absent },
      denominator, 'extracted',
    ));
  }
  if (malformed.length > 0) {
    out.push(analyzedSampleSignal(
      'structured_data_presence', DETECTORS.structured_data_presence, 'structured_data_malformed',
      { condition: 'structured_data_malformed', polarity: 'adverse', determinable: true, matched: malformed },
      denominator, 'extracted',
    ));
  }
  return out;
}

// ── registry ─────────────────────────────────────────────────

const DETECTOR_FNS: readonly ((input: QualificationInput) => Signal[])[] = Object.freeze([
  detectBrokenTargets,
  detectPageChecks,
  detectExtractionBand,
  detectContentDelivery,
  detectStructuredData,
]);

/** Deterministic: signals are sorted by signalKey, independent of input order. */
export function deriveSignals(input: QualificationInput): Signal[] {
  const out: Signal[] = [];
  for (const fn of DETECTOR_FNS) out.push(...fn(input));
  return out.sort((a, b) => a.signalKey.localeCompare(b.signalKey) || a.detector.localeCompare(b.detector));
}
