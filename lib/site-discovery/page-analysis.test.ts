import dns from 'node:dns';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BudgetTracker, fetchSelected } from './fetcher';
import { createHtmlSink } from './link-integrity';
import {
  analyzePageArtifact,
  buildPageAnalysisManifest,
  createPageAnalysisSink,
} from './page-analysis';
import type { PageEngine } from './page-engines';
import { analysisStateFor } from './page-evidence';
import type { InventoryUrl } from './types';
import { HARD_MAX_ANALYSIS_BYTES } from './versions';

function row(url: string, rank = 1, overrides: Partial<InventoryUrl> = {}): InventoryUrl {
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
    firstSeenAt: '2026-09-30T00:00:00.000Z',
    selected: true,
    selectionRank: rank,
    ...overrides,
  };
}

const artifact = {
  requestedUrl: 'https://example.com/a',
  finalUrl: 'https://example.com/a',
  status: 200,
  html: '<!doctype html><title>A</title><script type="application/ld+json">{"@type":"Thing"}</script>',
  contentSha256: 'b'.repeat(64),
  contentLength: 91,
  fetchedAt: '2026-09-30T00:00:00.000Z',
};

describe('page analysis', () => {
  beforeEach(() => {
    vi.spyOn(dns.promises, 'resolve4').mockResolvedValue(['93.184.216.34']);
    vi.spyOn(dns.promises, 'resolve6').mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('11 analyzes already-fetched HTML without an additional page fetch', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const result = analyzePageArtifact('scan', artifact);
    expect(fetch).not.toHaveBeenCalled();
    expect(result.observations).toHaveLength(4);
  });

  it('12 emits engines in the frozen order for a single page', () => {
    expect(analyzePageArtifact('scan', artifact).observations.map(item => item.engine)).toEqual([
      'extraction_resilience',
      'structured_data',
      'content_delivery',
      'meta_tags',
    ]);
  });

  it('13 stores the fetcher content hash with every observation', () => {
    expect(analyzePageArtifact('scan', artifact).observations.every(item => item.contentSha256 === artifact.contentSha256)).toBe(true);
  });

  it('14 reports partial when only a subset of the required engines runs', () => {
    const engines: PageEngine[] = [
      { name: 'structured_data', engineVersion: 'v', scope: 'page', networkRequests: 0, run: () => ({ ok: true }) },
    ];
    const result = analyzePageArtifact('scan', artifact, engines);
    expect(result.observations).toHaveLength(1);
    expect(result.analysisState).toBe('partial');
  });

  it('14 captures one engine exception without corrupting other engines', () => {
    const engines: PageEngine[] = [
      { name: 'extraction_resilience', engineVersion: 'v', scope: 'page', networkRequests: 0, run: () => ({ ok: true }) },
      { name: 'structured_data', engineVersion: 'v', scope: 'page', networkRequests: 0, run: () => ({ ok: true }) },
      { name: 'content_delivery', engineVersion: 'v', scope: 'page', networkRequests: 0, run: () => ({ ok: true }) },
      { name: 'meta_tags', engineVersion: 'v', scope: 'page', networkRequests: 0, run: () => { throw new Error('bad_meta'); } },
    ];
    const result = analyzePageArtifact('scan', artifact, engines);
    expect(result.analysisState).toBe('partial');
    expect(result.observations.map(item => item.status)).toEqual(['ok', 'ok', 'ok', 'failed']);
  });

  it('15 reports complete when the full frozen registry succeeds', () => {
    const result = analyzePageArtifact('scan', artifact);
    expect(result.observations).toHaveLength(4);
    expect(result.analysisState).toBe('complete');
  });

  it('15 derives failed when every engine fails', () => {
    const engines: PageEngine[] = [
      { name: 'structured_data', engineVersion: 'v', scope: 'page', networkRequests: 0, run: () => { throw new Error('a'); } },
      { name: 'meta_tags', engineVersion: 'v', scope: 'page', networkRequests: 0, run: () => { throw new Error('b'); } },
    ];
    expect(analyzePageArtifact('scan', artifact, engines).analysisState).toBe('failed');
  });

  it('15A reports 1/4 and 3/4 required successes as partial, not complete', () => {
    const engines: PageEngine[] = [
      { name: 'extraction_resilience', engineVersion: 'v', scope: 'page', networkRequests: 0, run: () => ({ ok: true }) },
      { name: 'structured_data', engineVersion: 'v', scope: 'page', networkRequests: 0, run: () => ({ ok: true }) },
      { name: 'content_delivery', engineVersion: 'v', scope: 'page', networkRequests: 0, run: () => ({ ok: true }) },
    ];
    expect(analyzePageArtifact('scan', artifact, engines.slice(0, 1)).analysisState).toBe('partial');
    expect(analyzePageArtifact('scan', artifact, engines).analysisState).toBe('partial');
  });

  it('15B does not let a failed required engine, duplicates, or unknowns produce complete', () => {
    const threeOkOneFailed: PageEngine[] = [
      { name: 'extraction_resilience', engineVersion: 'v', scope: 'page', networkRequests: 0, run: () => ({ ok: true }) },
      { name: 'structured_data', engineVersion: 'v', scope: 'page', networkRequests: 0, run: () => ({ ok: true }) },
      { name: 'content_delivery', engineVersion: 'v', scope: 'page', networkRequests: 0, run: () => ({ ok: true }) },
      { name: 'meta_tags', engineVersion: 'v', scope: 'page', networkRequests: 0, run: () => { throw new Error('bad_meta'); } },
    ];
    const duplicateInsteadOfMissing = [
      ...threeOkOneFailed.slice(0, 3),
      { name: 'extraction_resilience', engineVersion: 'v2', scope: 'page', networkRequests: 0, run: () => ({ ok: true }) },
    ] as PageEngine[];
    const unknownInsteadOfMissing = [
      ...threeOkOneFailed.slice(0, 3),
      { name: 'unknown_engine', engineVersion: 'v', scope: 'page', networkRequests: 0, run: () => ({ ok: true }) },
    ] as PageEngine[];
    expect(analyzePageArtifact('scan', artifact, threeOkOneFailed).analysisState).toBe('partial');
    expect(analyzePageArtifact('scan', artifact, duplicateInsteadOfMissing).analysisState).toBe('partial');
    // D2 strengthened this: an engine with no registered projector is refused
    // outright rather than being allowed to run and then filtered by state.
    expect(() => analyzePageArtifact('scan', artifact, unknownInsteadOfMissing)).toThrow('no_registered_projector');
    // D1 clause F still holds independently at the state layer.
    expect(analysisStateFor([
      { engine: 'extraction_resilience', status: 'ok' },
      { engine: 'structured_data', status: 'ok' },
      { engine: 'content_delivery', status: 'ok' },
      { engine: 'unknown_engine', status: 'ok' },
    ])).toBe('partial');
  });

  it('16 sets analyzed true only when analysisState is complete', () => {
    const rows = [row('https://example.com/a', 1, { fetchState: 'fetched', httpStatus: 200 })];
    createPageAnalysisSink('scan', rows).onPage(artifact);
    expect(rows[0].analysisState).toBe('complete');
    expect(rows[0].analyzed).toBe(true);
  });

  it('16 leaves analyzed false unless analysisState is complete', () => {
    const rows = [row('https://example.com/a', 1, { fetchState: 'fetched', httpStatus: 200 })];
    createPageAnalysisSink('scan', rows).onPage({
      ...artifact,
      html: '<html><head><title>A',
    });
    if (rows[0].analysisState === 'complete') {
      expect(rows[0].analyzed).toBe(true);
    } else {
      expect(rows[0].analyzed).toBe(false);
    }
  });

  it('17 fetch success alone never sets analyzed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    const rows = [row('https://example.com/a')];
    await fetchSelected(rows, {
      scopeOrigin: 'https://example.com',
      robotsTxt: null,
      robotsDeterminable: true,
      config: {},
      budgetTracker: new BudgetTracker(),
    });
    expect(rows[0].fetchState).toBe('fetched');
    expect(rows[0].analysisState).toBe('not_attempted');
    expect(rows[0].analyzed).toBe(false);
  });

  it('17A does not enter engines when the canonical artifact exceeds 768 KiB', () => {
    const run = vi.fn(() => ({ ok: true }));
    const engines: PageEngine[] = [
      { name: 'extraction_resilience', engineVersion: 'v', scope: 'page', networkRequests: 0, run },
      { name: 'structured_data', engineVersion: 'v', scope: 'page', networkRequests: 0, run },
      { name: 'content_delivery', engineVersion: 'v', scope: 'page', networkRequests: 0, run },
      { name: 'meta_tags', engineVersion: 'v', scope: 'page', networkRequests: 0, run },
    ];
    const result = analyzePageArtifact('scan', {
      ...artifact,
      html: '<html>small decoded body</html>',
      contentLength: HARD_MAX_ANALYSIS_BYTES + 1,
    }, engines);
    expect(run).not.toHaveBeenCalled();
    expect(result.analysisState).toBe('failed');
    expect(result.observations).toHaveLength(4);
    expect(result.observations.every(item => item.status === 'failed')).toBe(true);
    expect(result.observations.every(item => item.errorReason === 'analysis_input_too_large')).toBe(true);
    expect(JSON.stringify(result.observations)).not.toContain('small decoded body');
  });

  it('17B leaves fetched page and link evidence intact for oversize analysis input', () => {
    const rows = [row('https://example.com/a', 1, {
      fetchState: 'fetched',
      httpStatus: 200,
      contentSha256: artifact.contentSha256,
      contentLength: HARD_MAX_ANALYSIS_BYTES + 1,
    })];
    const links = createHtmlSink('https://example.com');
    links.onPage({
      ...artifact,
      html: '<a href="/kept">Kept</a>',
      contentLength: HARD_MAX_ANALYSIS_BYTES + 1,
    });
    const sink = createPageAnalysisSink('scan', rows);
    sink.onPage({ ...artifact, contentLength: HARD_MAX_ANALYSIS_BYTES + 1 });
    expect(rows[0]).toMatchObject({
      fetchState: 'fetched',
      httpStatus: 200,
      contentSha256: artifact.contentSha256,
      contentLength: HARD_MAX_ANALYSIS_BYTES + 1,
      analysisState: 'failed',
      analyzed: false,
    });
    expect(links.links()).toHaveLength(1);
    expect(sink.observations()).toHaveLength(4);
  });

  it('17C keeps oversize analysis zero-network with no refetch and no timeout claim', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const result = analyzePageArtifact('scan', {
      ...artifact,
      contentLength: HARD_MAX_ANALYSIS_BYTES + 1,
    });
    const source = readFileSync(new URL('./page-analysis.ts', import.meta.url), 'utf8');
    expect(fetch).not.toHaveBeenCalled();
    expect(result.observations.every(item => item.errorReason === 'analysis_input_too_large')).toBe(true);
    expect(JSON.stringify(result.observations)).not.toContain('timeout');
    expect(source).not.toContain('setTimeout');
    expect(source).not.toContain('Promise.race');
    expect(source).toContain('no hard wall-clock CPU deadline');
  });

  it('18 sorts observations by selection rank and engine index regardless of callback timing', () => {
    const rows = [
      row('https://example.com/slow', 2, { fetchState: 'fetched', httpStatus: 200 }),
      row('https://example.com/fast', 1, { fetchState: 'fetched', httpStatus: 200 }),
    ];
    const sink = createPageAnalysisSink('scan', rows);
    sink.onPage({ ...artifact, requestedUrl: 'https://example.com/slow', finalUrl: 'https://example.com/slow' });
    sink.onPage({ ...artifact, requestedUrl: 'https://example.com/fast', finalUrl: 'https://example.com/fast' });
    expect(sink.observations().map(item => `${item.requestedUrl}:${item.engine}`)).toEqual([
      'https://example.com/fast:extraction_resilience',
      'https://example.com/fast:structured_data',
      'https://example.com/fast:content_delivery',
      'https://example.com/fast:meta_tags',
      'https://example.com/slow:extraction_resilience',
      'https://example.com/slow:structured_data',
      'https://example.com/slow:content_delivery',
      'https://example.com/slow:meta_tags',
    ]);
  });

  it('19 produces identical observation order under differing page timing', () => {
    const make = (order: string[]) => {
      const rows = [
        row('https://example.com/a', 1, { fetchState: 'fetched', httpStatus: 200 }),
        row('https://example.com/b', 2, { fetchState: 'fetched', httpStatus: 200 }),
      ];
      const sink = createPageAnalysisSink('scan', rows);
      for (const url of order) sink.onPage({ ...artifact, requestedUrl: url, finalUrl: url });
      return sink.observations().map(item => `${item.requestedUrl}:${item.engine}:${item.contentSha256}`);
    };
    expect(make(['https://example.com/a', 'https://example.com/b'])).toEqual(make(['https://example.com/b', 'https://example.com/a']));
  });

  it('20 prevents duplicate page-engine execution records', () => {
    const rows = [row('https://example.com/a', 1, { fetchState: 'fetched', httpStatus: 200 })];
    const sink = createPageAnalysisSink('scan', rows);
    sink.onPage(artifact);
    sink.onPage(artifact);
    expect(sink.observations()).toHaveLength(4);
  });

  it('21 binds redirect artifacts to requestedUrl while carrying finalUrl', async () => {
    const page = '<html>redirected</html>';
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/a')) return new Response(null, { status: 302, headers: { location: '/b' } });
      return new Response(page, { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);
    const rows = [row('https://example.com/a')];
    const seen: string[] = [];
    await fetchSelected(rows, {
      scopeOrigin: 'https://example.com',
      robotsTxt: null,
      robotsDeterminable: true,
      config: {},
      budgetTracker: new BudgetTracker(),
      onPage: artifact => {
        seen.push(`${artifact.requestedUrl} -> ${artifact.finalUrl}`);
        createPageAnalysisSink('scan', rows).onPage(artifact);
      },
    });
    expect(seen).toEqual(['https://example.com/a -> https://example.com/b']);
    expect(rows[0].analysisState).toBe('complete');
  });

  it('22 fires onPage only for final 2xx page responses', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/redirect')) return new Response(null, { status: 302, headers: { location: '/ok' } });
      if (url.endsWith('/missing')) return new Response('missing', { status: 404 });
      return new Response('ok', { status: 200 });
    }));
    await fetchSelected([row('https://example.com/redirect'), row('https://example.com/missing', 2)], {
      scopeOrigin: 'https://example.com',
      robotsTxt: null,
      robotsDeterminable: true,
      config: {},
      budgetTracker: new BudgetTracker(),
      onPage: artifact => calls.push(artifact.finalUrl),
    });
    expect(calls).toEqual(['https://example.com/ok']);
  });

  it('23 uses the fetcher raw-byte hash, not a decoded-string rehash', async () => {
    const bytes = new Uint8Array([0xc3, 0x28]);
    const rawHash = createHash('sha256').update(bytes).digest('hex');
    const decodedHash = createHash('sha256').update(new TextEncoder().encode(new TextDecoder().decode(bytes))).digest('hex');
    const hashes: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes, { status: 200 })));
    await fetchSelected([row('https://example.com/a')], {
      scopeOrigin: 'https://example.com',
      robotsTxt: null,
      robotsDeterminable: true,
      config: {},
      budgetTracker: new BudgetTracker(),
      onPage: artifact => hashes.push(artifact.contentSha256),
    });
    expect(rawHash).not.toBe(decodedHash);
    expect(hashes).toEqual([rawHash]);
  });

  it('24 handles malformed HTML without propagating parser exceptions', () => {
    const result = analyzePageArtifact('scan', { ...artifact, html: '<main><p><div>open' });
    expect(result.observations).toHaveLength(4);
    expect(['complete', 'partial', 'failed']).toContain(result.analysisState);
  });

  it('24A handles pathological small markup without false complete when an engine fails', () => {
    const deeplyNested = `${'<main>'.repeat(3000)}<script type="application/ld+json">{bad</script>${'</main>'.repeat(3000)}`;
    const engines: PageEngine[] = [
      { name: 'extraction_resilience', engineVersion: 'v', scope: 'page', networkRequests: 0, run: () => ({ ok: true }) },
      { name: 'structured_data', engineVersion: 'v', scope: 'page', networkRequests: 0, run: () => ({ ok: true }) },
      { name: 'content_delivery', engineVersion: 'v', scope: 'page', networkRequests: 0, run: () => ({ ok: true }) },
      { name: 'meta_tags', engineVersion: 'v', scope: 'page', networkRequests: 0, run: () => { throw new Error('pathological_regression'); } },
    ];
    const result = analyzePageArtifact('scan', {
      ...artifact,
      html: deeplyNested,
      contentLength: Buffer.byteLength(deeplyNested),
    }, engines);
    expect(result.observations).toHaveLength(4);
    expect(result.analysisState).toBe('partial');
    expect(result.observations.find(item => item.engine === 'meta_tags')).toMatchObject({
      status: 'failed',
      errorReason: 'pathological_regression',
    });
  });

  it('25 handles a MAX_PAGE_BYTES-sized page without crashing', () => {
    const html = '<p>x</p>'.repeat(262144);
    const result = analyzePageArtifact('scan', { ...artifact, html, contentLength: Buffer.byteLength(html) });
    expect(result.observations).toHaveLength(4);
  });

  it('26 reports coverage counts and zero page-analysis network requests', () => {
    const rows = [
      row('https://example.com/a', 1, { fetchState: 'fetched', analysisState: 'complete', analyzed: true }),
      row('https://example.com/b', 2, { fetchState: 'fetched', analysisState: 'partial' }),
      row('https://example.com/c', 3, { fetchState: 'fetched', analysisState: 'failed' }),
      row('https://example.com/d', 4),
    ];
    const manifest = buildPageAnalysisManifest(rows, [
      { ...analyzePageArtifact('scan', artifact).observations[0] },
      { ...analyzePageArtifact('scan', artifact).observations[0], status: 'failed', errorReason: 'boom' },
    ]);
    expect(manifest).toMatchObject({
      pages_fetched: 3,
      pages_analysis_complete: 1,
      pages_analysis_partial: 1,
      pages_analysis_failed: 1,
      pages_not_attempted: 1,
      network_requests_made: 0,
      engine_failures_by_reason: { boom: 1 },
    });
  });

  it('27 does not turn page score into site coverage', () => {
    const observations = analyzePageArtifact('scan', artifact).observations;
    expect(observations.every(item => item.scope === 'page')).toBe(true);
    expect(JSON.stringify(observations)).not.toContain('"scope":"site"');
  });

  it('28 preserves link extraction behavior after widening onHtml to onPage', () => {
    const html = '<nav><a href="/a">A</a></nav><a href="https://example.org/x">X</a>';
    const oldSink = createHtmlSink('https://example.com');
    oldSink.onHtml('https://example.com/', html);
    const newSink = createHtmlSink('https://example.com');
    newSink.onPage({ ...artifact, requestedUrl: 'https://example.com/', finalUrl: 'https://example.com/', html });
    expect(newSink.links()).toEqual(oldSink.links());
  });
});
