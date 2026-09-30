import { describe, expect, it } from 'vitest';
import { buildManifest, makeCoverageRatio, type BuildManifestInput } from './coverage-manifest';

const base: BuildManifestInput = {
  scanId: '00000000-0000-0000-0000-000000000001',
  scanMode: 'prospect_observation',
  domain: 'example.com',
  seedUrl: 'https://example.com/',
  startedAt: '2026-09-29T00:00:00.000Z',
  completedAt: '2026-09-29T00:00:01.000Z',
  status: 'complete',
  abortReason: null,
  config: { maxChildSitemaps: 10, maxSitemapDepth: 3, maxLocEntries: 5000, maxDiscoveryRequests: 20 },
  urls: [{
    urlRaw: 'https://example.com/',
    urlNormalized: 'https://example.com/',
    discoveryMethod: 'seed',
    discoveredFromUrl: null,
    sitemapSourceUrl: null,
    linkDepth: 0,
    inScope: true,
    excludedReason: null,
    fetchState: 'not_attempted',
    httpStatus: null,
    analyzed: false,
    firstSeenAt: '2026-09-29T00:00:00.000Z',
  }],
  methodsUsed: ['seed'],
  sitemapsFound: 0,
  sitemapsParsed: 0,
  sitemapsSkippedCrossOrigin: 0,
  sitemapEntriesSeen: 0,
  discoveryComplete: true,
  truncationReason: null,
  requestsMade: 0,
};

describe('buildManifest', () => {
  it.each(['complete', 'partial', 'aborted'] as const)('builds a %s manifest', status => {
    const manifest = buildManifest({
      ...base,
      status,
      abortReason: status === 'aborted' ? 'ip_not_public' : null,
    });
    expect(manifest.status).toBe(status);
    expect(manifest.urls).toMatchObject({ selected: 0, attempted: 0, fetched: 0, analyzed: 0, blocked: 0, failed: 0 });
  });

  it('requires a truncation reason when discovery is incomplete', () => {
    expect(() => buildManifest({ ...base, discoveryComplete: false })).toThrow('truncation_reason_required');
    expect(buildManifest({ ...base, discoveryComplete: false, truncationReason: 'max_child_sitemaps' }).discovery.truncation_reason).toBe('max_child_sitemaps');
  });

  it('emits no percent key and labels include both numbers', () => {
    const manifest = buildManifest(base);
    expect(JSON.stringify(manifest)).not.toMatch(/"percent"/);
    expect(manifest.coverage[0].label).toContain('0');
    expect(manifest.coverage[0].label).toContain('1');
  });

  it('throws for denominator zero ratios', () => {
    expect(() => makeCoverageRatio('x', 0, 0, '0 of 0')).toThrow('coverage_denominator_zero');
  });
});
