import { updateFetchState, type InventoryUrl } from './inventory';
import { assertPageEngine, engineIndex, PAGE_ENGINES, PAGE_ENGINE_SET_VERSION, type PageEngine } from './page-engines';
import { analysisStateFor, countFailuresByReason, failedObservation, okObservation } from './page-evidence';
import { projectDurableEvidence } from './evidence-projection';
import type { AnalysisState, FetchedPageArtifact, OnPage, PageObservation } from './types';
import { HARD_MAX_ANALYSIS_BYTES } from './versions';

export interface PageAnalysisManifestBlock {
  engine_set_version: string;
  engines: string[];
  engine_versions: Record<string, string>;
  pages_fetched: number;
  pages_analysis_complete: number;
  pages_analysis_partial: number;
  pages_analysis_failed: number;
  pages_not_attempted: number;
  observations_recorded: number;
  engine_failures_by_reason: Record<string, number>;
  network_requests_made: 0;
  stop_reason: null | 'complete' | 'no_pages_fetched' | 'disabled';
}

interface RankedObservation {
  selectionRank: number;
  engineIndex: number;
  observation: PageObservation;
}

export function analyzePageArtifact(
  scanId: string,
  artifact: FetchedPageArtifact,
  engines: readonly PageEngine[] = PAGE_ENGINES,
  observedAt = artifact.fetchedAt,
): {
  observations: PageObservation[];
  analysisState: AnalysisState;
} {
  const observations: PageObservation[] = [];
  if (analysisByteLength(artifact) > HARD_MAX_ANALYSIS_BYTES) {
    // D v0.1 bounds analysis input size only; it has no hard wall-clock CPU deadline.
    // Interruptible parser isolation with workers or subprocesses is out of scope.
    for (const engine of engines) {
      assertPageEngine(engine);
      observations.push(failedObservation({
        scanId,
        artifact,
        engine: engine.name,
        engineVersion: engine.engineVersion,
        error: 'analysis_input_too_large',
        observedAt,
      }));
    }
    return {
      observations,
      analysisState: analysisStateFor(observations),
    };
  }
  for (const engine of engines) {
    assertPageEngine(engine);
    try {
      // D2: the rich engine result stays transient. Only its registered
      // projection may become durable evidence, and an engine whose evidence
      // cannot be projected within bounds is recorded as failed, not persisted.
      const durable = projectDurableEvidence(engine.name, engine.run(artifact));
      observations.push(okObservation({
        scanId,
        artifact,
        engine: engine.name,
        engineVersion: engine.engineVersion,
        observation: durable,
        observedAt,
      }));
    } catch (error) {
      observations.push(failedObservation({
        scanId,
        artifact,
        engine: engine.name,
        engineVersion: engine.engineVersion,
        error,
        observedAt,
      }));
    }
  }
  return {
    observations,
    analysisState: analysisStateFor(observations),
  };
}

export function createPageAnalysisSink(scanId: string, rows: InventoryUrl[]): {
  onPage: OnPage;
  observations: () => PageObservation[];
} {
  const byUrl = new Map(rows.filter(row => row.urlNormalized !== null).map(row => [row.urlNormalized!, row]));
  const seen = new Set<string>();
  const observations: RankedObservation[] = [];
  return {
    onPage(artifact) {
      const row = byUrl.get(artifact.requestedUrl);
      if (!row) throw new Error('page_artifact_requested_url_not_found');
      const result = analyzePageArtifact(scanId, artifact);
      for (const observation of result.observations) {
        const key = `${observation.scanId}\n${observation.requestedUrl}\n${observation.engine}`;
        if (seen.has(key)) continue;
        seen.add(key);
        observations.push({
          selectionRank: row.selectionRank ?? Number.MAX_SAFE_INTEGER,
          engineIndex: engineIndex(observation.engine),
          observation,
        });
      }
      updateFetchState(row, { analysisState: result.analysisState });
    },
    observations() {
      return sortedObservations(observations);
    },
  };
}

export function buildPageAnalysisManifest(rows: InventoryUrl[], observations: PageObservation[]): PageAnalysisManifestBlock {
  const pagesFetched = rows.filter(row => row.fetchState === 'fetched').length;
  const counts = {
    complete: rows.filter(row => row.analysisState === 'complete').length,
    partial: rows.filter(row => row.analysisState === 'partial').length,
    failed: rows.filter(row => row.analysisState === 'failed').length,
    notAttempted: rows.filter(row => (row.analysisState ?? 'not_attempted') === 'not_attempted').length,
  };
  return {
    engine_set_version: PAGE_ENGINE_SET_VERSION,
    engines: PAGE_ENGINES.map(engine => engine.name),
    engine_versions: Object.fromEntries(PAGE_ENGINES.map(engine => [engine.name, engine.engineVersion])),
    pages_fetched: pagesFetched,
    pages_analysis_complete: counts.complete,
    pages_analysis_partial: counts.partial,
    pages_analysis_failed: counts.failed,
    pages_not_attempted: counts.notAttempted,
    observations_recorded: observations.length,
    engine_failures_by_reason: countFailuresByReason(observations),
    network_requests_made: 0,
    stop_reason: pagesFetched === 0 ? 'no_pages_fetched' : 'complete',
  };
}

function sortedObservations(observations: RankedObservation[]): PageObservation[] {
  return [...observations]
    .sort((a, b) => a.selectionRank - b.selectionRank || a.engineIndex - b.engineIndex)
    .map(item => item.observation);
}

function analysisByteLength(artifact: FetchedPageArtifact): number {
  return artifact.contentLength > 0 ? artifact.contentLength : Buffer.byteLength(artifact.html);
}
