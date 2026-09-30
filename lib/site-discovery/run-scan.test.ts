import dns from 'node:dns';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveryResult, InventoryUrl } from './types';
import { runScan } from './run-scan';
import { MAX_CONCURRENCY } from './versions';

const { runDiscoveryMock } = vi.hoisted(() => ({
  runDiscoveryMock: vi.fn<() => Promise<DiscoveryResult>>(),
}));

vi.mock('./discover', () => ({
  runDiscovery: runDiscoveryMock,
}));

describe('runScan', () => {
  beforeEach(() => {
    vi.spyOn(dns.promises, 'resolve4').mockResolvedValue(['93.184.216.34']);
    vi.spyOn(dns.promises, 'resolve6').mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('stamps selection, fetch block, and derives analyzed from complete page analysis', async () => {
    mockDiscovery({ robots: { body: null, httpStatus: 404, determinable: true } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    const result = await runScan({ seedUrl: 'https://example.com/', scanId: 'scan' });
    expect(result.urls.every(row => row.analyzed === (row.analysisState === 'complete'))).toBe(true);
    expect(result.manifest.urls).toMatchObject({ selected: 1, fetched: 1, analyzed: 1 });
    expect(result.manifest.page_analysis?.pages_analysis_complete).toBe(1);
    expect(result.manifest.fetch?.stop_reason).toBe('complete');
  });

  it('returns a partial manifest on 429', async () => {
    mockDiscovery({ robots: { body: null, httpStatus: 404, determinable: true } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('slow down', { status: 429 })));
    const result = await runScan({ seedUrl: 'https://example.com/', scanId: 'scan' });
    expect(result.manifest.status).toBe('partial');
    expect(result.manifest.fetch?.stop_reason).toBe('rate_limited');
    expect(result.urls[0].skipReason).toBe('rate_limited');
  });

  it('uses discovery robots by default and skips all pages when robots disallows all crawling', async () => {
    mockDiscovery({
      robots: { body: 'User-agent: *\nDisallow: /', httpStatus: 200, determinable: true },
      paths: ['/', '/a', '/b'],
    });
    const pageFetch = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', pageFetch);

    const result = await runScan({ seedUrl: 'https://example.com/', scanId: 'scan', selection: { budget: 10 } });

    expect(pageFetch).not.toHaveBeenCalled();
    expect(result.urls.filter(row => row.selected).every(row => row.fetchState === 'skipped' && row.skipReason === 'robots_disallowed')).toBe(true);
    expect(result.manifest.fetch?.skipped_robots).toBeGreaterThan(0);
  });

  it('fails closed when discovery robots is not determinable', async () => {
    mockDiscovery({
      robots: { body: 'temporary error', httpStatus: 500, determinable: false },
      paths: ['/', '/a'],
    });
    const pageFetch = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', pageFetch);

    const result = await runScan({ seedUrl: 'https://example.com/', scanId: 'scan', selection: { budget: 10 } });

    expect(pageFetch).not.toHaveBeenCalled();
    expect(result.manifest.status).toBe('partial');
    expect(result.manifest.fetch?.stop_reason).toBe('robots_undeterminable');
    expect(result.urls.filter(row => row.selected).every(row => row.fetchState === 'skipped' && row.skipReason === 'robots_undeterminable')).toBe(true);
  });

  it('treats discovery robots 404 as determinable and permissive', async () => {
    mockDiscovery({
      robots: { body: 'missing', httpStatus: 404, determinable: true },
      paths: ['/', '/a'],
    });
    const pageFetch = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', pageFetch);

    const result = await runScan({ seedUrl: 'https://example.com/', scanId: 'scan', selection: { budget: 10 } });

    expect(pageFetch).toHaveBeenCalledTimes(2);
    expect(result.manifest.fetch?.stop_reason).toBe('complete');
    expect(result.manifest.urls.fetched).toBe(2);
  });

  it('applies path-specific robots rules from discovery robots', async () => {
    mockDiscovery({
      robots: { body: 'User-agent: *\nDisallow: /private/', httpStatus: 200, determinable: true },
      paths: ['/', '/private/x', '/public'],
    });
    const pageFetch = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', pageFetch);

    const result = await runScan({ seedUrl: 'https://example.com/', scanId: 'scan', selection: { budget: 10 } });

    expect(pageFetch).toHaveBeenCalledTimes(2);
    expect(result.urls.find(row => row.urlNormalized === 'https://example.com/private/x')).toMatchObject({
      fetchState: 'skipped',
      skipReason: 'robots_disallowed',
    });
    expect(result.urls.find(row => row.urlNormalized === 'https://example.com/public')).toMatchObject({ fetchState: 'fetched' });
  });

  it('does not dispatch more page requests after a host is rate limited', async () => {
    mockDiscovery({
      robots: { body: null, httpStatus: 404, determinable: true },
      paths: ['/', '/a', '/b', '/c', '/d'],
    });
    const pageFetch = vi.fn(async () => new Response('slow down', { status: 429 }));
    vi.stubGlobal('fetch', pageFetch);

    const result = await runScan({ seedUrl: 'https://example.com/', scanId: 'scan', selection: { budget: 10 } });

    expect(pageFetch.mock.calls.length).toBeLessThanOrEqual(MAX_CONCURRENCY);
    expect(result.manifest.fetch?.stop_reason).toBe('rate_limited');
    expect(result.urls.filter(row => row.selected && row.urlNormalized !== 'https://example.com/').every(row =>
      row.fetchState === 'skipped' && row.skipReason === 'host_rate_limited',
    )).toBe(true);
  });
});

function mockDiscovery(opts: {
  robots: DiscoveryResult['robots'];
  paths?: string[];
}): void {
  const urls = (opts.paths ?? ['/']).map((path, index) => row(`https://example.com${path === '/' ? '/' : path}`, index === 0));
  runDiscoveryMock.mockResolvedValueOnce({
    urls,
    robots: opts.robots,
    manifest: {
      manifest_version: 'cm-0.1',
      scan_id: 'scan',
      scan_mode: 'prospect_observation',
      domain: 'example.com',
      seed_url: 'https://example.com/',
      started_at: '2026-09-29T00:00:00.000Z',
      completed_at: '2026-09-29T00:00:01.000Z',
      status: 'complete',
      abort_reason: null,
      method: {
        discovery_version: 'sd-0.1',
        normalization_version: 'norm-0.1',
        config: { max_child_sitemaps: 10, max_sitemap_depth: 3, max_loc_entries: 5000, max_discovery_requests: 20 },
      },
      discovery: {
        methods_used: ['seed'],
        sitemaps_found: 0,
        sitemaps_parsed: 0,
        sitemaps_skipped_cross_origin: 0,
        sitemap_entries_seen: 0,
        discovery_complete: true,
        truncation_reason: null,
        requests_made: 1,
      },
      urls: { discovered: urls.length, in_scope: urls.length, excluded: 0, selected: 0, attempted: 0, fetched: 0, analyzed: 0, skipped: 0, blocked: 0, failed: 0 },
      coverage: [],
    },
  });
}

function row(url: string, seed: boolean): InventoryUrl {
  return {
    urlRaw: url,
    urlNormalized: url,
    discoveryMethod: seed ? 'seed' : 'sitemap',
    discoveredFromUrl: null,
    sitemapSourceUrl: seed ? null : 'https://example.com/sitemap.xml',
    linkDepth: seed ? 0 : null,
    inScope: true,
    excludedReason: null,
    fetchState: 'not_attempted',
    httpStatus: null,
    analyzed: false,
    firstSeenAt: '2026-09-29T00:00:00.000Z',
  };
}
