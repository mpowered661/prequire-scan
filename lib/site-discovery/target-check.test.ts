import dns from 'node:dns';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BudgetTracker } from './fetcher';
import { checkTargets, TARGET_CHECK_VERSION } from './target-check';
import type { LinkTargetCandidate } from './link-targets';

describe('target checks', () => {
  beforeEach(() => {
    vi.spyOn(dns.promises, 'resolve4').mockResolvedValue(['93.184.216.34']);
    vi.spyOn(dns.promises, 'resolve6').mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('exports the frozen version and checks healthy targets with HEAD', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    const out = await checkTargets([target('/ok')], { scopeOrigin: 'https://example.com', robotsTxt: null, budgetTracker: new BudgetTracker() });
    expect(TARGET_CHECK_VERSION).toBe('tcheck-0.1');
    expect(out.observations[0]).toMatchObject({ checkState: 'checked', classification: 'healthy', methodUsed: 'HEAD', httpStatus: 204 });
    expect(out.stats).toMatchObject({ headRequests: 1, targetCheckRequestsMade: 1 });
  });

  it('uses GET fallback only for 405/501 and discards the body', async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => new Response(init?.method === 'HEAD' ? null : '<a href="/escape">escape</a>', { status: init?.method === 'HEAD' ? 405 : 200 }));
    vi.stubGlobal('fetch', fetch);
    const out = await checkTargets([target('/needs-get')], { scopeOrigin: 'https://example.com', robotsTxt: null, budgetTracker: new BudgetTracker() });
    expect(fetch.mock.calls.map(call => call[1]?.method)).toEqual(['HEAD', 'GET']);
    expect(out.observations[0]).toMatchObject({ classification: 'healthy', methodUsed: 'GET' });
    expect(out.stats.getFallbacks).toBe(1);
  });

  it('does not use GET fallback for ordinary 4xx', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetch);
    const out = await checkTargets([target('/missing')], { scopeOrigin: 'https://example.com', robotsTxt: null, budgetTracker: new BudgetTracker() });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(out.observations[0]).toMatchObject({ classification: 'broken_4xx', methodUsed: 'HEAD' });
  });

  it('retries a permanent 5xx once', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 500 }));
    vi.stubGlobal('fetch', fetch);
    const out = await checkTargets([target('/err')], { scopeOrigin: 'https://example.com', robotsTxt: null, budgetTracker: new BudgetTracker() });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(out.stats.retriesUsed).toBe(1);
    expect(out.observations[0].classification).toBe('server_failure_5xx');
  });

  it('records off-origin redirects as redirected and does not follow them', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://example.org/x' } }));
    vi.stubGlobal('fetch', fetch);
    const out = await checkTargets([target('/out')], { scopeOrigin: 'https://example.com', robotsTxt: null, budgetTracker: new BudgetTracker() });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(out.observations[0]).toMatchObject({ classification: 'redirected', redirectLeftOrigin: true, redirectTargetUrl: 'https://example.org/x' });
  });

  it('blocks unsafe redirects before following them', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } }));
    vi.stubGlobal('fetch', fetch);
    const out = await checkTargets([target('/bad')], { scopeOrigin: 'https://example.com', robotsTxt: null, budgetTracker: new BudgetTracker() });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(out.observations[0]).toMatchObject({ classification: 'blocked', uncheckedReason: 'egress_rejected' });
  });

  it('stops honestly at global budget exhaustion and unchecked targets are not healthy', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const out = await checkTargets([target('/a'), target('/b')], { scopeOrigin: 'https://example.com', robotsTxt: null, budgetTracker: new BudgetTracker(120, 120) });
    expect(fetch).not.toHaveBeenCalled();
    expect(out.stats.stopReason).toBe('total_request_ceiling');
    expect(out.observations.every(obs => obs.checkState === 'unchecked' && obs.classification === null)).toBe(true);
  });

  it('records robots-disallowed targets as unchecked without a request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const out = await checkTargets([target('/private')], { scopeOrigin: 'https://example.com', robotsTxt: 'User-agent: *\nDisallow: /private', budgetTracker: new BudgetTracker() });
    expect(fetch).not.toHaveBeenCalled();
    expect(out.observations[0]).toMatchObject({ checkState: 'unchecked', uncheckedReason: 'robots_disallowed', classification: null });
  });
});

function target(path: string): LinkTargetCandidate {
  return {
    targetUrlNormalized: `https://example.com${path}`,
    sourceLinkCount: 1,
    placements: new Set(['body']),
  };
}
