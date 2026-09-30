import dns from 'node:dns';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BudgetTracker, fetchSelected, FETCHER_VERSION } from './fetcher';
import type { InventoryUrl } from './inventory';
import { HARD_MAX_TOTAL_REQUESTS, MAX_PAGE_BYTES } from './versions';

function row(url: string, overrides: Partial<InventoryUrl> = {}): InventoryUrl {
  return {
    urlRaw: url,
    urlNormalized: url,
    discoveryMethod: 'sitemap',
    discoveredFromUrl: null,
    sitemapSourceUrl: null,
    linkDepth: null,
    inScope: true,
    excludedReason: null,
    fetchState: 'not_attempted',
    httpStatus: null,
    analyzed: false,
    firstSeenAt: '2026-09-29T00:00:00.000Z',
    selected: true,
    selectionReason: 'sitemap_sample',
    selectionRank: 1,
    ...overrides,
  };
}

describe('fetchSelected', () => {
  beforeEach(() => {
    vi.spyOn(dns.promises, 'resolve4').mockResolvedValue(['93.184.216.34']);
    vi.spyOn(dns.promises, 'resolve6').mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exports the frozen version', () => {
    expect(FETCHER_VERSION).toBe('fetch-0.1');
  });

  it('fetches selected pages and persists only hash, length, and metadata', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>secret</html>', { status: 200 })));
    const rows = [row('https://example.com/')];
    const out = await fetchSelected(rows, { scopeOrigin: 'https://example.com', robotsTxt: null, robotsDeterminable: true, config: {}, budgetTracker: new BudgetTracker() });
    expect(out.fetched).toBe(1);
    expect(rows[0]).toMatchObject({ fetchState: 'fetched', contentLength: 19, httpStatus: 200 });
    expect(rows[0].contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(rows)).not.toContain('<html>secret</html>');
  });

  it('skips disallowed robots before any request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const rows = [row('https://example.com/private/')];
    const out = await fetchSelected(rows, { scopeOrigin: 'https://example.com', robotsTxt: 'User-agent: *\nDisallow: /private', robotsDeterminable: true, config: {}, budgetTracker: new BudgetTracker() });
    expect(fetch).not.toHaveBeenCalled();
    expect(out.skipped_robots).toBe(1);
    expect(rows[0].skipReason).toBe('robots_disallowed');
  });

  it('retries a permanent 500 exactly once', async () => {
    const fetch = vi.fn(async () => new Response('err', { status: 500 }));
    vi.stubGlobal('fetch', fetch);
    const rows = [row('https://example.com/')];
    const out = await fetchSelected(rows, { scopeOrigin: 'https://example.com', robotsTxt: null, robotsDeterminable: true, config: {}, budgetTracker: new BudgetTracker() });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(out.retries_used).toBe(1);
    expect(rows[0]).toMatchObject({ fetchState: 'failed', skipReason: 'http_5xx' });
  });

  it('hard-clamps total request budget', async () => {
    const fetch = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const rows = Array.from({ length: 140 }, (_, index) => row(`https://example.com/${index}/`, { selectionRank: index + 1 }));
    const out = await fetchSelected(rows, { scopeOrigin: 'https://example.com', robotsTxt: null, robotsDeterminable: true, config: { maxTotalRequests: 99999 }, budgetTracker: new BudgetTracker(99999) });
    expect(out.total_requests_made).toBeLessThanOrEqual(HARD_MAX_TOTAL_REQUESTS);
    expect(fetch).toHaveBeenCalledTimes(60);
  });

  it('marks oversized responses as failed without storing body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(MAX_PAGE_BYTES + 1), { status: 200 })));
    const rows = [row('https://example.com/huge/')];
    await fetchSelected(rows, { scopeOrigin: 'https://example.com', robotsTxt: null, robotsDeterminable: true, config: {}, budgetTracker: new BudgetTracker() });
    expect(rows[0]).toMatchObject({ fetchState: 'failed', skipReason: 'oversize', contentSha256: null });
  });
});
