import { describe, expect, it } from 'vitest';
import type { InventoryUrl } from './inventory';
import { selectUrls, SELECTOR_VERSION } from './select';

function row(url: string, overrides: Partial<InventoryUrl> = {}): InventoryUrl {
  return {
    urlRaw: url,
    urlNormalized: url,
    discoveryMethod: 'sitemap',
    discoveredFromUrl: null,
    sitemapSourceUrl: 'https://example.com/sitemap.xml',
    linkDepth: null,
    inScope: true,
    excludedReason: null,
    fetchState: 'not_attempted',
    httpStatus: null,
    analyzed: false,
    firstSeenAt: '2026-09-29T00:00:00.000Z',
    ...overrides,
  };
}

describe('selectUrls', () => {
  it('exports the frozen version and never mutates rows', () => {
    const rows = [row('https://example.com/', { discoveryMethod: 'seed' })];
    const before = JSON.stringify(rows);
    expect(selectUrls(rows, { scopeOrigin: 'https://example.com', budget: 25 }).version).toBe(SELECTOR_VERSION);
    expect(JSON.stringify(rows)).toBe(before);
  });

  it('selects seed, nav, one per role, then deterministic sitemap sample', () => {
    const rows = [
      row('https://example.com/', { discoveryMethod: 'seed' }),
      row('https://example.com/contact/'),
      row('https://example.com/about-us/'),
      row('https://example.com/about-us/history/'),
      row('https://example.com/z/'),
    ];
    const out = selectUrls(rows, { scopeOrigin: 'https://example.com', budget: 4, navUrls: ['https://example.com/contact/'] });
    expect(out.decisions).toEqual([
      { urlNormalized: 'https://example.com/', reason: 'seed', rank: 1 },
      { urlNormalized: 'https://example.com/contact/', reason: 'nav_footer', rank: 2 },
      { urlNormalized: 'https://example.com/about-us/', reason: 'role:about', rank: 3 },
      { urlNormalized: 'https://example.com/about-us/history/', reason: 'sitemap_sample', rank: 4 },
    ]);
  });

  it('is deterministic for shuffled input and clamps impossible budgets', () => {
    const rows = Array.from({ length: 80 }, (_, index) => row(`https://example.com/p${index}/`, { discoveryMethod: index === 0 ? 'seed' : 'sitemap' }));
    const a = selectUrls(rows, { scopeOrigin: 'https://example.com', budget: 99999 }).decisions;
    const b = selectUrls([...rows].reverse(), { scopeOrigin: 'https://example.com', budget: 99999 }).decisions;
    expect(a).toEqual(b);
    expect(a).toHaveLength(50);
  });

  it('excludes out-of-scope, normalized-null, and excluded rows', () => {
    const out = selectUrls([
      row('https://example.com/', { discoveryMethod: 'seed' }),
      row('https://blog.example.com/', { inScope: false, excludedReason: 'cross_origin' }),
      row('raw', { urlNormalized: null }),
      row('https://example.com/login/'),
    ], { scopeOrigin: 'https://example.com', budget: 10 });
    expect(out.decisions.map(decision => decision.urlNormalized)).toEqual(['https://example.com/']);
  });
});
