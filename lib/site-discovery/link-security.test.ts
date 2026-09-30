import dns from 'node:dns';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BudgetTracker, fetchSelected } from './fetcher';
import type { InventoryUrl } from './inventory';
import { createHtmlSink, runLinkIntegrity } from './link-integrity';
import { extractLinks } from './link-extract';
import { buildManifest } from './coverage-manifest';

describe('Tranche C link security', () => {
  beforeEach(() => {
    vi.spyOn(dns.promises, 'resolve4').mockResolvedValue(['93.184.216.34']);
    vi.spyOn(dns.promises, 'resolve6').mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('records external and protocol-relative links but never checks them', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const links = extractLinks('<a href="https://example.org/x">x</a><a href="//example.org/y">y</a>', 'https://example.com/', 'https://example.com');
    const out = await runLinkIntegrity(links, { pagesSupplyingHtml: 1, scopeOrigin: 'https://example.com', robotsTxt: null, budgetTracker: new BudgetTracker() });
    expect(links.every(link => link.exclusionReason === 'external' && !link.eligibleForCheck)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(out.manifest.external_links_observed).toBe(2);
  });

  it('never checks unsupported schemes or localhost/private literal hosts when off-origin', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const links = extractLinks('<a href="mailto:a@b.test">m</a><a href="tel:123">t</a><a href="javascript:alert(1)">j</a><a href="data:text/plain,x">d</a><a href="file:///x">f</a><a href="http://localhost/">l</a><a href="http://127.0.0.1/">r</a><a href="http://[::1]/">v6</a><a href="http://10.0.0.1/">p</a><a href="http://192.168.1.1/">p</a><a href="http://169.254.169.254/">p</a>', 'https://example.com/', 'https://example.com');
    await runLinkIntegrity(links, { pagesSupplyingHtml: 1, scopeOrigin: 'https://example.com', robotsTxt: null, budgetTracker: new BudgetTracker() });
    expect(fetch).not.toHaveBeenCalled();
    expect(links.every(link => !link.eligibleForCheck)).toBe(true);
  });

  it('uses exact-origin comparison for userinfo, mixed case, trailing dot, IDN, and alternate port', () => {
    const links = extractLinks('<a href="https://example.com@example.org/">u</a><a href="HTTPS://EXAMPLE.COM/x">m</a><a href="https://example.com./x">dot</a><a href="https://xn--e1afmkfd.example.com/">idn</a><a href="https://example.com:8080/x">port</a>', 'https://example.com/', 'https://example.com');
    expect(links[0]).toMatchObject({ isInternal: false, exclusionReason: 'external' });
    expect(links[1]).toMatchObject({ isInternal: true, eligibleForCheck: true });
    expect(links[2].isInternal).toBe(false);
    expect(links[3]).toMatchObject({ isInternal: false, exclusionReason: 'external' });
    expect(links[4]).toMatchObject({ eligibleForCheck: false, exclusionReason: 'port_not_allowed' });
  });

  it('target-check GET fallback does not invoke onHtml and cannot create a crawl frontier', async () => {
    const pageFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init?.method) return new Response('<a href="/needs-get">needs get</a>', { status: 200 });
      return new Response(init.method === 'HEAD' ? null : '<a href="/escape">escape</a>', { status: init.method === 'HEAD' ? 405 : 200 });
    });
    vi.stubGlobal('fetch', pageFetch);
    const sink = createHtmlSink('https://example.com');
    const rows = [row('https://example.com/')];
    const tracker = new BudgetTracker();
    await fetchSelected(rows, { scopeOrigin: 'https://example.com', robotsTxt: null, robotsDeterminable: true, config: {}, budgetTracker: tracker, onHtml: sink.onHtml });
    const out = await runLinkIntegrity(sink.links(), { pagesSupplyingHtml: sink.pages(), scopeOrigin: 'https://example.com', robotsTxt: null, budgetTracker: tracker });
    expect(sink.links().map(link => link.targetUrlNormalized)).toEqual(['https://example.com/needs-get']);
    expect(out.links.map(link => link.targetUrlNormalized)).not.toContain('https://example.com/escape');
  });

  it('raw HTML is not reachable from fetch summary, inventory rows, or manifest', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>secret-link-body</html>', { status: 200 })));
    const rows = [row('https://example.com/')];
    const summary = await fetchSelected(rows, { scopeOrigin: 'https://example.com', robotsTxt: null, robotsDeterminable: true, config: {}, budgetTracker: new BudgetTracker() });
    const manifest = buildManifest({
      scanId: '00000000-0000-0000-0000-000000000001',
      scanMode: 'prospect_observation',
      domain: 'example.com',
      seedUrl: 'https://example.com/',
      startedAt: '2026-09-29T00:00:00.000Z',
      completedAt: '2026-09-29T00:00:01.000Z',
      status: 'complete',
      abortReason: null,
      config: { maxChildSitemaps: 10, maxSitemapDepth: 3, maxLocEntries: 5000, maxDiscoveryRequests: 20 },
      urls: rows,
      methodsUsed: ['seed'],
      sitemapsFound: 0,
      sitemapsParsed: 0,
      sitemapsSkippedCrossOrigin: 0,
      sitemapEntriesSeen: 0,
      discoveryComplete: true,
      truncationReason: null,
      requestsMade: 0,
      fetch: summary,
    });
    expect(JSON.stringify(summary)).not.toContain('secret-link-body');
    expect(JSON.stringify(rows)).not.toContain('secret-link-body');
    expect(JSON.stringify(manifest)).not.toContain('secret-link-body');
  });

  it('redirect loops terminate and budget is respected', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: '/loop' } }));
    vi.stubGlobal('fetch', fetch);
    const sink = createHtmlSink('https://example.com');
    sink.onHtml('https://example.com/', '<a href="/loop">loop</a>');
    const out = await runLinkIntegrity(sink.links(), { pagesSupplyingHtml: 1, scopeOrigin: 'https://example.com', robotsTxt: null, budgetTracker: new BudgetTracker() });
    expect(out.targets[0].classification).toBe('undeterminable');
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('normalization collisions and distinctions are frozen', () => {
    const links = extractLinks('<a href="/a">a</a><a href="/a?utm_source=x">u</a><a href="/a#frag">f</a><a href="/a/">slash</a>', 'https://example.com/', 'https://example.com');
    expect(links.map(link => link.targetUrlNormalized)).toEqual([
      'https://example.com/a',
      'https://example.com/a',
      'https://example.com/a',
      'https://example.com/a/',
    ]);
  });

  it('caps query explosions by target budget while recording all relationships', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })));
    const sink = createHtmlSink('https://example.com');
    sink.onHtml('https://example.com/', Array.from({ length: 400 }, (_, index) => `<a href="/search?q=${index}">${index}</a>`).join(''));
    const out = await runLinkIntegrity(sink.links(), { pagesSupplyingHtml: 1, scopeOrigin: 'https://example.com', robotsTxt: null, budgetTracker: new BudgetTracker(), targetCheckBudget: 99999 });
    expect(out.links).toHaveLength(400);
    expect(out.manifest.targets_selected_for_check).toBe(40);
    expect(out.manifest.targets_unchecked).toBe(360);
  });

  it('unchecked targets never carry a classification', async () => {
    const sink = createHtmlSink('https://example.com');
    sink.onHtml('https://example.com/', '<a href="/a">a</a>');
    const out = await runLinkIntegrity(sink.links(), { pagesSupplyingHtml: 1, scopeOrigin: 'https://example.com', robotsTxt: null, budgetTracker: new BudgetTracker(120, 120) });
    expect(out.targets[0]).toMatchObject({ checkState: 'unchecked', classification: null });
  });
});

function row(url: string): InventoryUrl {
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
  };
}
