// Opportunity Review & Presentation v0.1 — canonical claim derivation.
//
// The canonical claim is the structured, hashable MEANING of a claim. Approval
// binds it; prose does not. Derivation is deterministic: input array order
// cannot change the claim or its hash.

import { createHash } from 'node:crypto';
import { POPULATION_LABELS, TEMPORAL_FRAME } from './versions';
import type {
  CanonicalClaim,
  ClaimMetric,
  ClaimType,
  EpistemicClass,
  EvidenceRefView,
  Population,
  PresentationPermission,
} from './types';

/** Minimal structural view of a qualification opportunity. */
export interface OpportunityView {
  detector: string;
  detectorVersion: string;
  subject: string;
  condition: string;
  scopeLevel: string;
  numerator: number | null;
  denominator: number | null;
  sourceLinkCount: number;
  facts: Readonly<Record<string, string | number | boolean | null>>;
  evidenceRefs: EvidenceRefView[];
}

export interface CoverageForClaim {
  analysisComplete: number;
  targetsChecked: number;
}

function refKey(r: EvidenceRefView): string {
  return [r.kind, r.scanId, r.subjectUrl, r.engine ?? '', r.engineVersion ?? '', r.contentSha256 ?? ''].join('\u0001');
}

/** Deduplicated and sorted, so input order cannot affect the hash. */
export function normalizeRefs(refs: readonly EvidenceRefView[]): EvidenceRefView[] {
  const seen = new Set<string>();
  const out: EvidenceRefView[] = [];
  for (const r of refs) {
    const k = refKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out.sort((a, b) => refKey(a).localeCompare(refKey(b)));
}

export function evidenceRefsHashOf(refs: readonly EvidenceRefView[]): string {
  const parts = normalizeRefs(refs).map(refKey);
  return createHash('sha256').update(parts.join('\u0002')).digest('hex').slice(0, 32);
}

const CLAIM_TYPE_BY_DETECTOR: Readonly<Record<string, ClaimType>> = Object.freeze({
  broken_internal_target: 'checked_target_status',
  page_check_failure: 'sample_check_failure',
  page_check_undeterminable: 'sample_check_failure',
  extraction_band: 'sample_band_assignment',
  content_delivery_condition: 'sample_measure_threshold',
  structured_data_presence: 'sample_condition_presence',
});

const METRIC_BY_DETECTOR: Readonly<Record<string, ClaimMetric>> = Object.freeze({
  broken_internal_target: 'http_status',
  page_check_failure: 'check_status',
  page_check_undeterminable: 'check_status',
  extraction_band: 'band',
  content_delivery_condition: 'text_html_ratio_threshold',
  structured_data_presence: 'condition_present',
});

/**
 * The form of the subject that externally presentable prose must name. A URL
 * subject must appear verbatim. An internal identifier such as `band:fragile`
 * is namespaced for machine identity, so prose names its meaningful part
 * (`fragile`) rather than the namespaced key, which no reader would recognize.
 */
export function subjectMentionOf(subject: string): string {
  if (/^https?:\/\//i.test(subject)) return subject;
  const colon = subject.lastIndexOf(':');
  return colon >= 0 ? subject.slice(colon + 1) : subject;
}

export function claimTypeOf(detector: string): ClaimType | null {
  return CLAIM_TYPE_BY_DETECTOR[detector] ?? null;
}

/**
 * The observation date, taken from the evidence (never a wall clock). Reduced to
 * a calendar date so a claim's identity does not churn on sub-day timing.
 */
function observedAtOf(o: OpportunityView): string | null {
  const fromFacts = o.facts.checkedAt;
  if (typeof fromFacts === 'string' && fromFacts.length >= 10) return fromFacts.slice(0, 10);
  const dates = normalizeRefs(o.evidenceRefs)
    .map(r => r.observedAt)
    .filter((d): d is string => typeof d === 'string' && d.length >= 10)
    .map(d => d.slice(0, 10))
    .sort();
  return dates.length > 0 ? dates[0] : null;
}

function observedValueOf(o: OpportunityView): string {
  switch (o.detector) {
    case 'broken_internal_target': {
      const s = o.facts.httpStatus;
      return s === null || s === undefined ? o.condition : String(s);
    }
    case 'page_check_failure': return 'fail';
    case 'page_check_undeterminable': return 'undeterminable';
    case 'extraction_band': {
      const b = o.facts.band;
      return typeof b === 'string' && b.length > 0 ? b : o.condition;
    }
    default: return o.condition;
  }
}

/**
 * Populations, ordered by label. A broken destination genuinely involves TWO
 * populations — the source pages carrying the link and the checked destinations
 * — and they must never be conflated into one denominator.
 */
export function populationsOf(o: OpportunityView, coverage: CoverageForClaim): Population[] {
  const out: Population[] = [];
  if (o.detector === 'broken_internal_target') {
    out.push({
      label: POPULATION_LABELS.analyzed_pages,
      numerator: o.sourceLinkCount,
      denominator: coverage.analysisComplete,
    });
    out.push({
      label: POPULATION_LABELS.checked_link_destinations,
      numerator: o.numerator ?? 1,
      denominator: o.denominator ?? coverage.targetsChecked,
    });
  } else if (o.numerator !== null && o.denominator !== null) {
    out.push({
      label: POPULATION_LABELS.analyzed_pages,
      numerator: o.numerator,
      denominator: o.denominator,
    });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

export function buildCanonicalClaim(
  o: OpportunityView,
  coverage: CoverageForClaim,
  epistemicClass: EpistemicClass,
  presentationPermission: PresentationPermission,
  qualifiers: readonly string[],
): CanonicalClaim | null {
  const claimType = claimTypeOf(o.detector);
  const metric = METRIC_BY_DETECTOR[o.detector];
  // Fail closed: an unrecognized detector yields no canonical claim at all.
  if (!claimType || !metric) return null;
  return {
    claimType,
    subject: o.subject,
    scopeLevel: o.scopeLevel,
    condition: o.condition,
    metric,
    observedValue: observedValueOf(o),
    observedAt: observedAtOf(o),
    temporalFrame: TEMPORAL_FRAME,
    populations: populationsOf(o, coverage),
    qualifiers: [...new Set(qualifiers)].sort(),
    epistemicClass,
    presentationPermission,
    detector: o.detector,
    detectorVersion: o.detectorVersion,
    evidenceRefsHash: evidenceRefsHashOf(o.evidenceRefs),
  };
}

/**
 * Deterministic canonical serialization: keys sorted, set-like arrays already
 * ordered by their own rule. Prose is NEVER part of the identity.
 */
export function canonicalJson(c: CanonicalClaim): string {
  const ordered = {
    claimType: c.claimType,
    condition: c.condition,
    detector: c.detector,
    detectorVersion: c.detectorVersion,
    epistemicClass: c.epistemicClass,
    evidenceRefsHash: c.evidenceRefsHash,
    metric: c.metric,
    observedAt: c.observedAt,
    observedValue: c.observedValue,
    populations: c.populations
      .map(p => ({ denominator: p.denominator, label: p.label, numerator: p.numerator }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    presentationPermission: c.presentationPermission,
    qualifiers: [...c.qualifiers].sort(),
    scopeLevel: c.scopeLevel,
    subject: c.subject,
    temporalFrame: c.temporalFrame,
  };
  return JSON.stringify(ordered);
}

export function claimHashOf(c: CanonicalClaim): string {
  return createHash('sha256').update(canonicalJson(c)).digest('hex').slice(0, 32);
}

export function proseHashOf(prose: string): string {
  return createHash('sha256').update(prose).digest('hex').slice(0, 32);
}
