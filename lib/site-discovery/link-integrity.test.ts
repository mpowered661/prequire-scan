import dns from 'node:dns';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BudgetTracker } from './fetcher';
import { createHtmlSink, runLinkIntegrity, LINK_INTEGRITY_VERSION } from './link-integrity';

describe('link integrity orchestration', () => {
  beforeEach(() => {
    vi.spyOn(dns.promises, 'resolve4').mockResolvedValue(['93.184.216.34']);
    vi.spyOn(dns.promises, 'resolve6').mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('extracts via the transient sink and builds a complete manifest', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })));
    const sink = createHtmlSink('https://example.com');
    sink.onHtml('https://example.com/', '<nav><a href="/a">A</a></nav><a href="https://example.org/x">X</a>');
    const out = await runLinkIntegrity(sink.links(), {
      pagesSupplyingHtml: sink.pages(),
      scopeOrigin: 'https://example.com',
      robotsTxt: null,
      budgetTracker: new BudgetTracker(),
    });
    expect(LINK_INTEGRITY_VERSION).toBe('li-0.1');
    expect(out.manifest).toMatchObject({
      pages_supplying_html: 1,
      links_observed: 2,
      internal_links_observed: 1,
      external_links_observed: 1,
      unique_internal_targets: 1,
      targets_checked: 1,
      targets_healthy: 1,
      stop_reason: 'complete',
    });
  });

  it('reports no_html_available without checking targets', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const out = await runLinkIntegrity([], {
      pagesSupplyingHtml: 0,
      scopeOrigin: 'https://example.com',
      robotsTxt: null,
      budgetTracker: new BudgetTracker(),
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(out.manifest.stop_reason).toBe('no_html_available');
  });

  it('stops at target budget when global budget is ample', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })));
    const sink = createHtmlSink('https://example.com');
    sink.onHtml('https://example.com/', Array.from({ length: 45 }, (_, index) => `<a href="/${index}">${index}</a>`).join(''));
    const out = await runLinkIntegrity(sink.links(), {
      pagesSupplyingHtml: sink.pages(),
      scopeOrigin: 'https://example.com',
      robotsTxt: null,
      budgetTracker: new BudgetTracker(),
      targetCheckBudget: 99999,
    });
    expect(out.manifest.targets_selected_for_check).toBe(40);
    expect(out.manifest.targets_checked).toBe(40);
    expect(out.manifest.targets_unchecked).toBe(5);
    expect(out.manifest.unchecked_by_reason.target_budget_exhausted).toBe(5);
    expect(out.manifest.stop_reason).toBe('target_budget');
  });

  it('stops at total request ceiling when earlier phases consumed the shared budget', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })));
    const sink = createHtmlSink('https://example.com');
    sink.onHtml('https://example.com/', '<a href="/a">A</a><a href="/b">B</a>');
    const out = await runLinkIntegrity(sink.links(), {
      pagesSupplyingHtml: sink.pages(),
      scopeOrigin: 'https://example.com',
      robotsTxt: null,
      budgetTracker: new BudgetTracker(120, 119),
      targetCheckBudget: 40,
    });
    expect(out.manifest.target_check_requests_made).toBe(1);
    expect(out.manifest.stop_reason).toBe('total_request_ceiling');
    expect(out.targets.some(target => target.checkState === 'unchecked' && target.classification === null)).toBe(true);
  });
});
