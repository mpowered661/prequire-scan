import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoverageManifest, InventoryUrl } from '@/lib/site-discovery/types';

const { insertMock, fromMock } = vi.hoisted(() => {
  const insertMock = vi.fn();
  const fromMock = vi.fn(() => ({ insert: insertMock }));
  return { insertMock, fromMock };
});

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: fromMock }),
}));

import { insertScanUrls, insertSiteScan } from './siteScans';

const manifest: CoverageManifest = {
  manifest_version: 'cm-0.1',
  scan_id: '00000000-0000-0000-0000-000000000201',
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
    config: {
      max_child_sitemaps: 10,
      max_sitemap_depth: 3,
      max_loc_entries: 5000,
      max_discovery_requests: 20,
    },
  },
  discovery: {
    methods_used: ['seed'],
    sitemaps_found: 0,
    sitemaps_parsed: 0,
    sitemaps_skipped_cross_origin: 0,
    sitemap_entries_seen: 0,
    discovery_complete: true,
    truncation_reason: null,
    requests_made: 0,
  },
  urls: {
    discovered: 1,
    in_scope: 1,
    excluded: 0,
    selected: 0,
    attempted: 0,
    fetched: 0,
    analyzed: 0,
    skipped: 0,
    blocked: 0,
    failed: 0,
  },
  coverage: [{ key: 'analyzed_discovered', numerator: 0, denominator: 1, label: '0 of 1 discovered URLs analyzed' }],
};

const inventoryUrl: InventoryUrl = {
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
};

beforeEach(() => {
  insertMock.mockReset();
  fromMock.mockClear();
});

describe('site scan persistence', () => {
  it('inserts a site_scans row from the manifest', async () => {
    insertMock.mockResolvedValue({ error: null });

    await expect(insertSiteScan(manifest)).resolves.toEqual({ ok: true });

    expect(fromMock).toHaveBeenCalledWith('site_scans');
    expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({
      scan_id: manifest.scan_id,
      manifest,
      discovery_version: 'sd-0.1',
      normalization_version: 'norm-0.1',
    }));
  });

  it('inserts scan_urls rows without violating the honesty invariant', async () => {
    insertMock.mockResolvedValue({ error: null });

    await expect(insertScanUrls(manifest.scan_id, [inventoryUrl])).resolves.toEqual({ ok: true });

    expect(fromMock).toHaveBeenCalledWith('scan_urls');
    expect(insertMock.mock.calls[0][0][0]).toMatchObject({
      fetch_state: 'not_attempted',
      analyzed: false,
    });
  });

  it('refuses invariant-violating rows before insert', async () => {
    await expect(insertScanUrls(manifest.scan_id, [{ ...inventoryUrl, analyzed: true }])).resolves.toEqual({
      ok: false,
      code: 'invariant_violation',
    });
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('returns database error codes safely', async () => {
    insertMock.mockResolvedValue({ error: { code: '23505' } });

    await expect(insertSiteScan(manifest)).resolves.toEqual({ ok: false, code: '23505' });
  });
});
