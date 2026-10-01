// Pure RunScanResult -> QualificationInput adapter. No I/O, no network, no
// persistence, no clock, no randomness. Given the same observation it returns
// the same input.

import type { CoverageManifest } from '../site-discovery/coverage-manifest';
import type { InventoryUrl } from '../site-discovery/inventory';
import type { ExtractedLink, PageObservation, RunScanResult, TargetObservation } from '../site-discovery/types';
import type {
  CoverageContext,
  DurableLinkRelationship,
  DurablePageObservation,
  DurableScanUrl,
  DurableTargetObservation,
  QualificationInput,
} from '../opportunity-qualification/types';
import { ACCEPTED_SCAN_MODES, type IncompleteObservationCode } from './contract';

export interface AdapterRefusal {
  code: IncompleteObservationCode;
  detail: string;
}

export type AdapterOutcome =
  | { ok: true; input: QualificationInput }
  | { ok: false; refusals: AdapterRefusal[] };

/**
 * ABSENCE IS NOT ZERO.
 *
 * `links`, `linkTargets` and `pageObservations` are optional on RunScanResult.
 * An absent collection means that stage DID NOT RUN; a present empty array
 * means it ran and observed nothing. Those are different facts, and conflating
 * them would let an aborted scan masquerade as a site with no links. Only a
 * complete observation may become a QualificationInput.
 *
 * The two manifest blocks are required for the same reason: the coverage
 * denominators come from them, and a missing denominator is not a zero
 * denominator.
 */
export function buildQualificationInput(scanId: string, result: RunScanResult): AdapterOutcome {
  const refusals: AdapterRefusal[] = [];
  const fail = (code: IncompleteObservationCode, detail: string) => refusals.push({ code, detail });

  const manifest = result.manifest;

  if (manifest.status === 'aborted') {
    fail('scan_aborted', `manifest.status is aborted${manifest.abort_reason ? `: ${manifest.abort_reason}` : ''}`);
  }
  if (manifest.scan_id !== scanId) {
    fail('scan_id_mismatch', `requested ${scanId} but manifest carries ${manifest.scan_id}`);
  }
  if (typeof manifest.seed_url !== 'string' || manifest.seed_url.length === 0) {
    fail('seed_url_missing', 'the observation has no resolved seed url');
  }
  if (!ACCEPTED_SCAN_MODES.includes(manifest.scan_mode)) {
    fail('unsupported_scan_mode', String(manifest.scan_mode));
  }
  if (result.pageObservations === undefined) {
    fail('page_observations_absent', 'page analysis did not run; absence is not an observation of zero');
  }
  if (result.linkTargets === undefined) {
    fail('link_targets_absent', 'target checking did not run; absence is not an observation of zero');
  }
  if (result.links === undefined) {
    fail('link_relationships_absent', 'link extraction did not run; absence is not an observation of zero');
  }
  if (manifest.page_analysis === undefined) {
    fail('page_analysis_manifest_absent', 'no page-analysis coverage denominators');
  }
  if (manifest.link_integrity === undefined) {
    fail('link_integrity_manifest_absent', 'no link-integrity coverage denominators');
  }

  if (refusals.length > 0) return { ok: false, refusals };

  const input: QualificationInput = {
    scanId,
    scanMode: manifest.scan_mode as QualificationInput['scanMode'],
    domain: manifest.domain,
    coverage: deriveCoverage(manifest),
    scanUrls: result.urls.map(toDurableScanUrl),
    pageObservations: (result.pageObservations as PageObservation[]).map(toDurablePageObservation),
    linkTargets: (result.linkTargets as TargetObservation[]).map(toDurableTargetObservation),
    linkRelationships: (result.links as ExtractedLink[]).map(toDurableLinkRelationship),
  };
  return { ok: true, input };
}

/**
 * The eight coverage counters, each from a named manifest field so every
 * denominator a later claim may cite is traceable to the observation.
 *
 * `siteTotalKnown` is ALWAYS false: a bounded crawl never establishes a site's
 * true page count, so no claim derived from this input may use the whole site as
 * a denominator. This is a deliberate constant, not an unimplemented field.
 */
function deriveCoverage(manifest: CoverageManifest): CoverageContext {
  const pages = manifest.page_analysis!;
  const links = manifest.link_integrity!;
  return {
    discovered: manifest.urls.discovered,
    selected: manifest.urls.selected,
    fetched: manifest.urls.fetched,
    analysisComplete: pages.pages_analysis_complete,
    uniqueInternalTargets: links.unique_internal_targets,
    targetsChecked: links.targets_checked,
    targetsUnchecked: links.targets_unchecked,
    siteTotalKnown: false,
  };
}

function toDurableScanUrl(row: InventoryUrl): DurableScanUrl {
  return {
    urlNormalized: row.urlNormalized,
    httpStatus: row.httpStatus,
    contentSha256: row.contentSha256 ?? null,
    fetchState: row.fetchState,
    analysisState: row.analysisState ?? 'not_attempted',
    analyzed: row.analyzed,
  };
}

function toDurablePageObservation(o: PageObservation): DurablePageObservation {
  return {
    scanId: o.scanId,
    requestedUrl: o.requestedUrl,
    finalUrl: o.finalUrl,
    engine: o.engine,
    engineVersion: o.engineVersion,
    contentSha256: o.contentSha256,
    status: o.status,
    errorReason: o.errorReason,
    observedAt: o.observedAt,
    scope: o.scope,
    observation: o.observation,
  };
}

function toDurableTargetObservation(t: TargetObservation): DurableTargetObservation {
  // responseMs is deliberately dropped: it is performance telemetry, not
  // evidence, and including it would make the input hash timing-dependent.
  return {
    targetUrlNormalized: t.targetUrlNormalized,
    checkState: t.checkState,
    uncheckedReason: t.uncheckedReason,
    classification: t.classification,
    httpStatus: t.httpStatus,
    redirectTargetUrl: t.redirectTargetUrl,
    redirectLeftOrigin: t.redirectLeftOrigin,
    redirectHops: t.redirectHops,
    methodUsed: t.methodUsed,
    sourceLinkCount: t.sourceLinkCount,
    checkedAt: t.checkedAt,
  };
}

function toDurableLinkRelationship(l: ExtractedLink): DurableLinkRelationship {
  return {
    sourceUrl: l.sourceUrl,
    targetUrlNormalized: l.targetUrlNormalized,
    anchorText: l.anchorText,
    placement: l.placement,
    internal: l.isInternal,
  };
}
