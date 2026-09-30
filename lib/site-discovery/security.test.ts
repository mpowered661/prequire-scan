import dns from 'node:dns';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateUrl } from './egress-policy';
import { evaluateExclusion } from './exclusions';
import { BudgetTracker, fetchSelected } from './fetcher';
import type { InventoryUrl } from './inventory';
import { selectUrls } from './select';
import { HARD_MAX_SELECTED_PAGES, HARD_MAX_TOTAL_REQUESTS, MAX_REDIRECTS } from './versions';

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

async function run(rows: InventoryUrl[], fetchImpl: typeof fetch = (async () => new Response('ok', { status: 200 })) as typeof fetch) {
  vi.stubGlobal('fetch', vi.fn(fetchImpl));
  return fetchSelected(rows, {
    scopeOrigin: 'https://example.com',
    robotsTxt: null,
    robotsDeterminable: true,
    config: {},
    budgetTracker: new BudgetTracker(),
  });
}

describe('Tranche B security', () => {
  beforeEach(() => {
    vi.spyOn(dns.promises, 'resolve4').mockResolvedValue(['93.184.216.34']);
    vi.spyOn(dns.promises, 'resolve6').mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. off-origin selected URL is rejected by origin before fetch', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const rows = [row('https://example.org/', { inScope: true })];
    await fetchSelected(rows, { scopeOrigin: 'https://example.com', robotsTxt: null, robotsDeterminable: true, config: {}, budgetTracker: new BudgetTracker() });
    expect(fetch).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ fetchState: 'blocked', skipReason: 'off_origin' });
  });

  it('2. same-origin to off-origin redirect is not followed and records redirected', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://example.org/' } }));
    vi.stubGlobal('fetch', fetch);
    const rows = [row('https://example.com/')];
    await fetchSelected(rows, { scopeOrigin: 'https://example.com', robotsTxt: null, robotsDeterminable: true, config: {}, budgetTracker: new BudgetTracker() });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(rows[0]).toMatchObject({ fetchState: 'redirected', skipReason: 'off_origin_redirect', redirectTargetUrl: 'https://example.org/' });
  });

  it('3. redirect to 127.0.0.1 is blocked by egress', async () => {
    await run([row('https://example.com/')], async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } }));
    expect((globalThis.fetch as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it('4. redirect to 169.254.169.254 is blocked by egress', async () => {
    const rows = [row('https://example.com/')];
    await run(rows, async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }));
    expect(rows[0]).toMatchObject({ fetchState: 'blocked', skipReason: 'egress_rejected' });
  });

  it('5. redirect loop terminates within MAX_REDIRECTS and budget', async () => {
    const rows = [row('https://example.com/')];
    await run(rows, async () => new Response(null, { status: 302, headers: { location: 'https://example.com/' } }));
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(MAX_REDIRECTS + 1);
    expect(rows[0]).toMatchObject({ fetchState: 'failed', skipReason: 'max_redirects' });
  });

  it.each([
    ['6. integer host', 'http://2130706433/', 'ip_not_public'],
    ['7. hex host', 'http://0x7f000001/', 'ip_not_public'],
    ['8. loopback IPv6', 'http://[::1]/', 'ip_not_public'],
    ['9. javascript scheme', 'javascript:alert(1)', 'unsupported_scheme'],
    ['9. data scheme', 'data:text/plain,hi', 'unsupported_scheme'],
    ['9. file scheme', 'file:///etc/passwd', 'unsupported_scheme'],
    ['13. port trick', 'https://example.com:8080/', 'port_not_allowed'],
  ])('%s is rejected as %s', async (_name, url, reason) => {
    expect(await validateUrl(url)).toMatchObject({ ok: false, reason });
  });

  it('10. userinfo trick resolves to example.org and is out of scope', async () => {
    const rows = [row('https://example.com@example.org/')];
    await run(rows);
    expect(rows[0]).toMatchObject({ fetchState: 'blocked', skipReason: 'off_origin' });
  });

  it('11. mixed-case host is same-origin, not a false rejection', async () => {
    const rows = [row('HTTPS://EXAMPLE.COM/')];
    await run(rows);
    expect(rows[0].fetchState).toBe('fetched');
  });

  it('12. trailing-dot host frozen behavior is exact-origin mismatch', async () => {
    const rows = [row('https://example.com./')];
    await run(rows);
    expect(rows[0]).toMatchObject({ fetchState: 'blocked', skipReason: 'egress_rejected' });
  });

  it('14. punycode subdomain is exact-origin mismatch, not suffix-matched', async () => {
    const rows = [row('https://xn--e1afmkfd.example.com/')];
    await run(rows);
    expect(rows[0]).toMatchObject({ fetchState: 'blocked', skipReason: 'off_origin' });
  });

  it('15. robots Disallow / fetches zero and marks robots_disallowed', async () => {
    const rows = [row('https://example.com/'), row('https://example.com/a/', { selectionRank: 2 })];
    const out = await fetchSelected(rows, { scopeOrigin: 'https://example.com', robotsTxt: 'User-agent: *\nDisallow: /', robotsDeterminable: true, config: {}, budgetTracker: new BudgetTracker() });
    expect(out.fetched).toBe(0);
    expect(rows.every(item => item.fetchState === 'skipped' && item.skipReason === 'robots_disallowed')).toBe(true);
  });

  it('16. robots undeterminable fetches zero and stops partial', async () => {
    const rows = [row('https://example.com/')];
    const out = await fetchSelected(rows, { scopeOrigin: 'https://example.com', robotsTxt: '<html>bad</html>', robotsDeterminable: false, config: {}, budgetTracker: new BudgetTracker() });
    expect(out).toMatchObject({ fetched: 0, stop_reason: 'robots_undeterminable' });
  });

  it('17. 429 on first page blocks host and skips remaining', async () => {
    const rows = [row('https://example.com/'), row('https://example.com/a/', { selectionRank: 2 })];
    const out = await run(rows, async () => new Response('no', { status: 429 }));
    expect(out.stop_reason).toBe('rate_limited');
    expect(rows[0]).toMatchObject({ fetchState: 'blocked', skipReason: 'rate_limited' });
    expect(rows[1]).toMatchObject({ fetchState: 'skipped', skipReason: 'host_rate_limited' });
  });

  it('18. retry amplification is exactly two requests for permanent 500', async () => {
    const rows = [row('https://example.com/')];
    await run(rows, async () => new Response('err', { status: 500 }));
    expect((globalThis.fetch as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
  });

  it('19. oversized response is failed oversize and raw body not persisted', async () => {
    const rows = [row('https://example.com/huge/')];
    await run(rows, async () => new Response('x'.repeat(2 * 1024 * 1024 + 1), { status: 200 }));
    expect(rows[0]).toMatchObject({ fetchState: 'failed', skipReason: 'oversize', contentSha256: null });
    expect(JSON.stringify(rows)).not.toContain('xxxxx');
  });

  it('20. timeout is retried exactly once', async () => {
    const rows = [row('https://example.com/slow/')];
    await run(rows, async () => { throw new Error('TimeoutError'); });
    expect((globalThis.fetch as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
    expect(rows[0]).toMatchObject({ fetchState: 'failed', skipReason: 'timeout' });
  });

  it('21. query explosion is excluded before selection', () => {
    const urls = Array.from({ length: 500 }, (_, index) => `https://example.com/p${index}/?a=1&b=2&c=3`);
    expect(urls.every(url => evaluateExclusion(url).reason === 'faceted_navigation')).toBe(true);
    const selected = selectUrls(urls.map(url => row(url)), { scopeOrigin: 'https://example.com', budget: 50 });
    expect(selected.decisions).toHaveLength(0);
  });

  it('22. path explosion is excluded with the deterministic reason', () => {
    expect(evaluateExclusion('https://example.com/a/b/a/c/a/d/e/f/g/').reason).toBe('repeated_path_segments');
  });

  it('23. budget bypass cannot select more than 50', () => {
    const rows = Array.from({ length: 100 }, (_, index) => row(`https://example.com/${index}/`, { discoveryMethod: index === 0 ? 'seed' : 'sitemap' }));
    expect(selectUrls(rows, { scopeOrigin: 'https://example.com', budget: 99999 }).decisions.length).toBeLessThanOrEqual(HARD_MAX_SELECTED_PAGES);
  });

  it('24. config bypass cannot raise total HTTP calls over 120', async () => {
    const rows = Array.from({ length: 200 }, (_, index) => row(`https://example.com/${index}/`, { selectionRank: index + 1 }));
    const out = await fetchSelected(rows, { scopeOrigin: 'https://example.com', robotsTxt: null, robotsDeterminable: true, config: { maxTotalRequests: 99999 }, budgetTracker: new BudgetTracker(99999) });
    expect(out.total_requests_made).toBeLessThanOrEqual(HARD_MAX_TOTAL_REQUESTS);
  });

  it('25. concurrency never exceeds two in-flight requests', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const rows = [row('https://example.com/1/'), row('https://example.com/2/', { selectionRank: 2 }), row('https://example.com/3/', { selectionRank: 3 })];
    await run(rows, async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return new Response('ok', { status: 200 });
    });
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });
});
