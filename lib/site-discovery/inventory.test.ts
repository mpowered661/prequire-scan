import { describe, expect, it } from 'vitest';
import { Inventory, assertInvariants, type InventoryUrl } from './inventory';

function row(overrides: Partial<InventoryUrl> = {}): InventoryUrl {
  return {
    urlRaw: 'https://example.com/a',
    urlNormalized: 'https://example.com/a',
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

describe('Inventory', () => {
  it('deduplicates by normalized URL and keeps first provenance', () => {
    const inventory = new Inventory();
    expect(inventory.add(row({ discoveryMethod: 'robots_sitemap' }))).toBe(true);
    expect(inventory.add(row({ discoveryMethod: 'sitemap_index' }))).toBe(false);
    expect(inventory.duplicatesSuppressed).toBe(1);
    expect(inventory.list()[0].discoveryMethod).toBe('robots_sitemap');
  });

  it('enforces analyzed requires fetched', () => {
    expect(() => assertInvariants(row({ analyzed: true }))).toThrow('analyzed_requires_fetched');
  });

  it('prevents Tranche A fetch states', () => {
    const inventory = new Inventory();
    expect(() => inventory.add(row({ fetchState: 'fetched' }))).toThrow('tranche_a_fetch_state_violation');
  });
});
