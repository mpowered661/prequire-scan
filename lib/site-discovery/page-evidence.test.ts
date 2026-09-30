import { describe, expect, it } from 'vitest';
import { analysisStateFor, countFailuresByReason, failedObservation, okObservation } from './page-evidence';
import type { FetchedPageArtifact } from './types';

const artifact: FetchedPageArtifact = {
  requestedUrl: 'https://example.com/a',
  finalUrl: 'https://example.com/b',
  status: 200,
  html: '<html>secret</html>',
  contentSha256: 'a'.repeat(64),
  contentLength: 19,
  fetchedAt: '2026-09-30T00:00:00.000Z',
};

function obs(engine: string, status: 'ok' | 'failed') {
  return { engine, status };
}

describe('page evidence', () => {
  it('5 records every required observation identity field and page scope', () => {
    const observation = okObservation({
      scanId: 'scan',
      artifact,
      engine: 'structured_data',
      engineVersion: '2026-08',
      observation: { hasSchema: false },
      observedAt: artifact.fetchedAt,
    });
    expect(observation).toMatchObject({
      scanId: 'scan',
      requestedUrl: 'https://example.com/a',
      finalUrl: 'https://example.com/b',
      engine: 'structured_data',
      engineVersion: '2026-08',
      contentSha256: 'a'.repeat(64),
      status: 'ok',
      errorReason: null,
      scope: 'page',
    });
  });

  it('6 never persists raw HTML in an observation', () => {
    const observation = okObservation({
      scanId: 'scan',
      artifact,
      engine: 'structured_data',
      engineVersion: '2026-08',
      observation: { hasSchema: false },
      observedAt: artifact.fetchedAt,
    });
    expect(JSON.stringify(observation)).not.toContain('<html>secret</html>');
  });

  it('7 converts engine exceptions into failed observations', () => {
    const observation = failedObservation({
      scanId: 'scan',
      artifact,
      engine: 'meta_tags',
      engineVersion: '2026-08',
      error: new Error('boom'),
      observedAt: artifact.fetchedAt,
    });
    expect(observation).toMatchObject({ status: 'failed', errorReason: 'boom', observation: null, scope: 'page' });
  });

  it('8 derives complete only when every required engine has exactly one success', () => {
    expect(analysisStateFor([
      obs('extraction_resilience', 'ok'),
    ])).toBe('partial');
    expect(analysisStateFor([
      obs('extraction_resilience', 'ok'),
      obs('structured_data', 'ok'),
      obs('content_delivery', 'ok'),
    ])).toBe('partial');
    expect(analysisStateFor([
      obs('extraction_resilience', 'ok'),
      obs('structured_data', 'ok'),
      obs('content_delivery', 'ok'),
      obs('meta_tags', 'ok'),
    ])).toBe('complete');
  });

  it('9 derives partial, failed, and not_attempted honestly from the required set', () => {
    expect(analysisStateFor([
      obs('extraction_resilience', 'ok'),
      obs('structured_data', 'ok'),
      obs('content_delivery', 'ok'),
      obs('meta_tags', 'failed'),
    ])).toBe('partial');
    expect(analysisStateFor([
      obs('extraction_resilience', 'failed'),
      obs('structured_data', 'failed'),
      obs('content_delivery', 'failed'),
      obs('meta_tags', 'failed'),
    ])).toBe('failed');
    expect(analysisStateFor([])).toBe('not_attempted');
    expect(analysisStateFor([obs('unknown_engine', 'ok')])).toBe('not_attempted');
  });

  it('9A does not let duplicates or unknown engines satisfy completeness', () => {
    expect(analysisStateFor([
      obs('extraction_resilience', 'ok'),
      obs('extraction_resilience', 'ok'),
      obs('structured_data', 'ok'),
      obs('content_delivery', 'ok'),
    ])).toBe('partial');
    expect(analysisStateFor([
      obs('extraction_resilience', 'ok'),
      obs('structured_data', 'ok'),
      obs('content_delivery', 'ok'),
      obs('unknown_engine', 'ok'),
    ])).toBe('partial');
  });

  it('10 counts engine failures by reason without inventing percentages', () => {
    expect(countFailuresByReason([
      { status: 'failed', errorReason: 'boom' },
      { status: 'failed', errorReason: 'boom' },
      { status: 'failed', errorReason: null },
      { status: 'ok', errorReason: null },
    ])).toEqual({ boom: 2, unknown: 1 });
  });
});
