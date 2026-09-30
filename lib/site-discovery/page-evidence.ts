import { REQUIRED_PAGE_ENGINE_NAMES } from './page-engines';
import type { AnalysisState, FetchedPageArtifact, PageObservation } from './types';

export function okObservation(input: {
  scanId: string;
  artifact: FetchedPageArtifact;
  engine: PageObservation['engine'];
  engineVersion: string;
  observation: unknown;
  observedAt: string;
}): PageObservation {
  return baseObservation(input, {
    observation: input.observation,
    status: 'ok',
    errorReason: null,
  });
}

export function failedObservation(input: {
  scanId: string;
  artifact: FetchedPageArtifact;
  engine: PageObservation['engine'];
  engineVersion: string;
  error: unknown;
  observedAt: string;
}): PageObservation {
  return baseObservation(input, {
    observation: null,
    status: 'failed',
    errorReason: errorReason(input.error),
  });
}

export function analysisStateFor(
  observations: { engine: string; status: PageObservation['status'] }[],
  requiredEngines: readonly string[] = REQUIRED_PAGE_ENGINE_NAMES,
): AnalysisState {
  const required = new Set(requiredEngines);
  const requiredObservations = observations.filter(observation => required.has(observation.engine));
  if (requiredObservations.length === 0) return 'not_attempted';

  const okByEngine = new Map<string, number>();
  const failedByEngine = new Map<string, number>();
  for (const observation of requiredObservations) {
    const counts = observation.status === 'ok' ? okByEngine : failedByEngine;
    counts.set(observation.engine, (counts.get(observation.engine) ?? 0) + 1);
  }

  const complete = requiredEngines.every(engine =>
    (okByEngine.get(engine) ?? 0) === 1 && (failedByEngine.get(engine) ?? 0) === 0,
  );
  if (complete) return 'complete';
  if (okByEngine.size > 0) return 'partial';
  if (failedByEngine.size > 0) return 'failed';
  return 'not_attempted';
}

export function countFailuresByReason(observations: Pick<PageObservation, 'status' | 'errorReason'>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const observation of observations) {
    if (observation.status !== 'failed') continue;
    const reason = observation.errorReason ?? 'unknown';
    out[reason] = (out[reason] ?? 0) + 1;
  }
  return out;
}

function baseObservation(
  input: {
    scanId: string;
    artifact: FetchedPageArtifact;
    engine: PageObservation['engine'];
    engineVersion: string;
    observedAt: string;
  },
  result: Pick<PageObservation, 'observation' | 'status' | 'errorReason'>,
): PageObservation {
  return {
    scanId: input.scanId,
    requestedUrl: input.artifact.requestedUrl,
    finalUrl: input.artifact.finalUrl,
    engine: input.engine,
    engineVersion: input.engineVersion,
    contentSha256: input.artifact.contentSha256,
    observation: result.observation,
    status: result.status,
    errorReason: result.errorReason,
    observedAt: input.observedAt,
    scope: 'page',
  };
}

function errorReason(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'unknown';
}
