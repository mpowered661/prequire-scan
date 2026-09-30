import dns from 'node:dns';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDiscovery } from './discover';
import { MAX_DISCOVERY_REQUESTS } from './versions';

function urlset(urls: string[]): string {
  return `<urlset>${urls.map(url => `<url><loc>${url}</loc></url>`).join('')}</urlset>`;
}

function index(urls: string[]): string {
  return `<sitemapindex>${urls.map(url => `<sitemap><loc>${url}</loc></sitemap>`).join('')}</sitemapindex>`;
}

function response(body: string, status = 200, headers?: HeadersInit): Response {
  return new Response(body, { status, headers });
}

function installFetch(routes: Record<string, Response | (() => Response)>) {
  const calls: string[] = [];
  const mock = vi.fn(async (raw: string) => {
    calls.push(raw);
    const found = routes[raw];
    if (!found) return response('missing', 404);
    return typeof found === 'function' ? found() : found;
  });
  vi.stubGlobal('fetch', mock);
  return calls;
}

beforeEach(() => {
  vi.spyOn(dns.promises, 'resolve4').mockResolvedValue(['93.184.216.34']);
  vi.spyOn(dns.promises, 'resolve6').mockRejectedValue(new Error('none'));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('runDiscovery', () => {
  it('parses two robots Sitemap directives', async () => {
    installFetch({
      'https://example.com/robots.txt': response('Sitemap: https://example.com/a.xml\nSitemap: https://example.com/b.xml'),
      'https://example.com/a.xml': response(urlset(['https://example.com/a'])),
      'https://example.com/b.xml': response(urlset(['https://example.com/b'])),
    });

    const result = await runDiscovery({ seedUrl: 'https://example.com/', scanId: '00000000-0000-0000-0000-000000000101' });

    expect(result.manifest.discovery.sitemaps_parsed).toBe(2);
    expect(result.urls.map(row => row.urlNormalized)).toEqual([
      'https://example.com/',
      'https://example.com/a',
      'https://example.com/b',
    ]);
  });

  it('falls through to /sitemap.xml when robots is 404', async () => {
    installFetch({
      'https://example.com/robots.txt': response('nope', 404),
      'https://example.com/sitemap.xml': response(urlset(['https://example.com/from-sitemap'])),
    });

    const result = await runDiscovery({ seedUrl: 'https://example.com/', scanId: '00000000-0000-0000-0000-000000000102' });

    expect(result.urls.some(row => row.urlNormalized === 'https://example.com/from-sitemap')).toBe(true);
    expect(result.manifest.discovery.methods_used).toContain('sitemap');
  });

  it('skips off-origin robots Sitemap directives without fetching them', async () => {
    const calls = installFetch({
      'https://example.com/robots.txt': response('Sitemap: https://example.org/evil.xml'),
      'https://example.com/sitemap.xml': response('missing', 404),
      'https://example.com/wp-sitemap.xml': response('missing', 404),
      'https://example.com/sitemap_index.xml': response('missing', 404),
    });

    const result = await runDiscovery({ seedUrl: 'https://example.com/', scanId: '00000000-0000-0000-0000-000000000113' });

    expect(calls).not.toContain('https://example.org/evil.xml');
    expect(result.manifest.discovery.sitemaps_skipped_cross_origin).toBe(1);
    expect(result.manifest.discovery.sitemaps_found).toBe(0);
  });

  it('skips off-origin sitemap index children without fetching them', async () => {
    const calls = installFetch({
      'https://example.com/robots.txt': response('', 404),
      'https://example.com/sitemap.xml': response(index(['https://example.org/child.xml'])),
      'https://example.com/wp-sitemap.xml': response('missing', 404),
      'https://example.com/sitemap_index.xml': response('missing', 404),
    });

    const result = await runDiscovery({ seedUrl: 'https://example.com/', scanId: '00000000-0000-0000-0000-000000000114' });

    expect(calls).not.toContain('https://example.org/child.xml');
    expect(result.manifest.discovery.sitemaps_skipped_cross_origin).toBe(1);
    expect(result.manifest.discovery.sitemaps_found).toBe(1);
  });

  it('traverses a sitemap index with three children', async () => {
    installFetch({
      'https://example.com/robots.txt': response('Sitemap: https://example.com/index.xml'),
      'https://example.com/index.xml': response(index([
        'https://example.com/one.xml',
        'https://example.com/two.xml',
        'https://example.com/three.xml',
      ])),
      'https://example.com/one.xml': response(urlset(['https://example.com/one'])),
      'https://example.com/two.xml': response(urlset(['https://example.com/two'])),
      'https://example.com/three.xml': response(urlset(['https://example.com/three'])),
    });

    const result = await runDiscovery({ seedUrl: 'https://example.com/', scanId: '00000000-0000-0000-0000-000000000103' });

    expect(result.manifest.discovery.methods_used).toContain('sitemap_index');
    expect(result.manifest.discovery.sitemaps_parsed).toBe(4);
    expect(result.urls).toHaveLength(4);
  });

  it('caps index children at 10 even when config asks for 9999', async () => {
    const children = Array.from({ length: 25 }, (_, i) => `https://example.com/${i}.xml`);
    const routes: Record<string, Response> = {
      'https://example.com/robots.txt': response('Sitemap: https://example.com/index.xml'),
      'https://example.com/index.xml': response(index(children)),
    };
    children.slice(0, 10).forEach((child, i) => {
      routes[child] = response(urlset([`https://example.com/page-${i}`]));
    });
    installFetch(routes);

    const result = await runDiscovery({
      seedUrl: 'https://example.com/',
      scanId: '00000000-0000-0000-0000-000000000104',
      config: { maxChildSitemaps: 9999 },
    });

    expect(result.urls.filter(row => row.discoveryMethod === 'sitemap_index')).toHaveLength(10);
    expect(result.manifest.discovery.discovery_complete).toBe(false);
    expect(result.manifest.discovery.truncation_reason).toBe('max_child_sitemaps');
    expect(result.manifest.method.config.max_child_sitemaps).toBe(10);
  });

  it('stops nesting at sitemap depth 3', async () => {
    installFetch({
      'https://example.com/robots.txt': response('Sitemap: https://example.com/d0.xml'),
      'https://example.com/d0.xml': response(index(['https://example.com/d1.xml'])),
      'https://example.com/d1.xml': response(index(['https://example.com/d2.xml'])),
      'https://example.com/d2.xml': response(index(['https://example.com/d3.xml'])),
      'https://example.com/d3.xml': response(index(['https://example.com/d4.xml'])),
      'https://example.com/d4.xml': response(urlset(['https://example.com/too-deep'])),
    });

    const result = await runDiscovery({ seedUrl: 'https://example.com/', scanId: '00000000-0000-0000-0000-000000000105' });

    expect(result.manifest.discovery.discovery_complete).toBe(false);
    expect(result.manifest.discovery.truncation_reason).toBe('max_sitemap_depth');
    expect(result.urls.some(row => row.urlNormalized?.endsWith('/too-deep'))).toBe(false);
  });

  it('records 5000 locs when a 6000-loc sitemap truncates', async () => {
    const locs = Array.from({ length: 6000 }, (_, i) => `https://example.com/p-${i}`);
    installFetch({
      'https://example.com/robots.txt': response('Sitemap: https://example.com/big.xml'),
      'https://example.com/big.xml': response(urlset(locs)),
    });

    const result = await runDiscovery({ seedUrl: 'https://example.com/', scanId: '00000000-0000-0000-0000-000000000106' });

    expect(result.urls).toHaveLength(5001);
    expect(result.manifest.discovery.truncation_reason).toBe('max_loc_entries');
  });

  it('records cross-origin and javascript loc exclusions without fetching pages', async () => {
    installFetch({
      'https://example.com/robots.txt': response('Sitemap: https://example.com/sitemap.xml'),
      'https://example.com/sitemap.xml': response(urlset(['https://example.org/off', 'javascript:alert(1)'])),
    });

    const result = await runDiscovery({ seedUrl: 'https://example.com/', scanId: '00000000-0000-0000-0000-000000000107' });

    expect(result.urls.find(row => row.urlRaw === 'https://example.org/off')).toMatchObject({ inScope: false, excludedReason: 'cross_origin' });
    expect(result.urls.find(row => row.urlRaw === 'javascript:alert(1)')).toMatchObject({
      urlNormalized: null,
      inScope: false,
      excludedReason: 'unsupported_scheme',
      urlRaw: 'javascript:alert(1)',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('returns an aborted manifest when seed validation fails', async () => {
    const result = await runDiscovery({ seedUrl: 'http://127.0.0.1/', scanId: '00000000-0000-0000-0000-000000000108' });

    expect(result.manifest.status).toBe('aborted');
    expect(result.manifest.abort_reason).toBe('ip_not_public');
    expect(result.urls).toEqual([]);
  });

  it('marks partial when a child sitemap returns 500 and continues parsing others', async () => {
    installFetch({
      'https://example.com/robots.txt': response('Sitemap: https://example.com/index.xml'),
      'https://example.com/index.xml': response(index(['https://example.com/good.xml', 'https://example.com/bad.xml'])),
      'https://example.com/good.xml': response(urlset(['https://example.com/good'])),
      'https://example.com/bad.xml': response('bad', 500),
    });

    const result = await runDiscovery({ seedUrl: 'https://example.com/', scanId: '00000000-0000-0000-0000-000000000109' });

    expect(result.manifest.status).toBe('partial');
    expect(result.urls.some(row => row.urlNormalized === 'https://example.com/good')).toBe(true);
  });

  it('refuses a redirect to localhost before following it', async () => {
    const calls = installFetch({
      'https://example.com/robots.txt': response('', 302, { location: 'http://127.0.0.1/sitemap.xml' }),
      'https://example.com/sitemap.xml': response(urlset(['https://example.com/ok'])),
    });

    const result = await runDiscovery({ seedUrl: 'https://example.com/', scanId: '00000000-0000-0000-0000-000000000110' });

    expect(calls).not.toContain('http://127.0.0.1/sitemap.xml');
    expect(result.urls.some(row => row.urlNormalized === 'https://example.com/ok')).toBe(true);
  });

  it('counts redirect hops in requests_made', async () => {
    const calls = installFetch({
      'https://example.com/robots.txt': response('', 302, { location: 'https://example.com/robots-hop.txt' }),
      'https://example.com/robots-hop.txt': response('Sitemap: https://example.com/sitemap.xml'),
      'https://example.com/sitemap.xml': response(urlset(['https://example.com/ok'])),
    });

    const result = await runDiscovery({ seedUrl: 'https://example.com/', scanId: '00000000-0000-0000-0000-000000000115' });

    expect(result.manifest.discovery.requests_made).toBe(calls.length);
    expect(calls).toHaveLength(3);
  });

  it('stops redirect chains when the discovery request budget is exhausted', async () => {
    const calls = installFetch({
      'https://example.com/robots.txt': response('Sitemap: https://example.com/sitemap.xml'),
      'https://example.com/sitemap.xml': response('', 302, { location: 'https://example.com/hop-1.xml' }),
      'https://example.com/hop-1.xml': response('', 302, { location: 'https://example.com/hop-2.xml' }),
      'https://example.com/hop-2.xml': response(urlset(['https://example.com/too-far'])),
    });

    const result = await runDiscovery({
      seedUrl: 'https://example.com/',
      scanId: '00000000-0000-0000-0000-000000000116',
      config: { maxDiscoveryRequests: 3 },
    });

    expect(calls).toHaveLength(3);
    expect(result.manifest.discovery.requests_made).toBe(calls.length);
    expect(result.manifest.discovery.truncation_reason).toBe('max_discovery_requests');
    expect(result.urls.some(row => row.urlNormalized === 'https://example.com/too-far')).toBe(false);
  });

  it('keeps Tranche A rows not_attempted and unanalyzed', async () => {
    installFetch({
      'https://example.com/robots.txt': response('Sitemap: https://example.com/sitemap.xml'),
      'https://example.com/sitemap.xml': response(urlset(['https://example.com/a'])),
    });

    const result = await runDiscovery({ seedUrl: 'https://example.com/', scanId: '00000000-0000-0000-0000-000000000111' });

    expect(result.urls.every(row => row.fetchState === 'not_attempted' && row.analyzed === false)).toBe(true);
  });

  it('does not exceed MAX_DISCOVERY_REQUESTS', async () => {
    const children = Array.from({ length: 30 }, (_, i) => `https://example.com/${i}.xml`);
    const routes: Record<string, Response> = {
      'https://example.com/robots.txt': response('Sitemap: https://example.com/index.xml'),
      'https://example.com/index.xml': response(index(children)),
    };
    children.forEach((child, i) => {
      routes[child] = response(urlset([`https://example.com/p-${i}`]));
    });
    const calls = installFetch(routes);

    const result = await runDiscovery({ seedUrl: 'https://example.com/', scanId: '00000000-0000-0000-0000-000000000112' });

    expect(result.manifest.discovery.requests_made).toBeLessThanOrEqual(MAX_DISCOVERY_REQUESTS);
    expect(calls.length).toBe(result.manifest.discovery.requests_made);
    expect(calls.length).toBeLessThanOrEqual(MAX_DISCOVERY_REQUESTS);
  });

  it('caps child sitemap index entries across the scan', async () => {
    const firstChildren = Array.from({ length: 8 }, (_, i) => `https://example.com/a-${i}.xml`);
    const secondChildren = Array.from({ length: 8 }, (_, i) => `https://example.com/b-${i}.xml`);
    const routes: Record<string, Response> = {
      'https://example.com/robots.txt': response('Sitemap: https://example.com/a-index.xml\nSitemap: https://example.com/b-index.xml'),
      'https://example.com/a-index.xml': response(index(firstChildren)),
      'https://example.com/b-index.xml': response(index(secondChildren)),
    };
    [...firstChildren, ...secondChildren].slice(0, 10).forEach((child, i) => {
      routes[child] = response(urlset([`https://example.com/child-${i}`]));
    });
    const calls = installFetch(routes);

    const result = await runDiscovery({ seedUrl: 'https://example.com/', scanId: '00000000-0000-0000-0000-000000000117' });

    const fetchedChildren = calls.filter(call => /\/[ab]-\d+\.xml$/.test(call));
    expect(fetchedChildren).toHaveLength(10);
    expect(result.manifest.discovery.truncation_reason).toBe('max_child_sitemaps');
    expect(result.urls.filter(row => row.discoveryMethod === 'sitemap_index')).toHaveLength(10);
  });

  it('is not imported from any existing code path', () => {
    const root = process.cwd();
    const files = walk(root).filter(file =>
      file.endsWith('.ts') &&
      !file.includes(`${path.sep}node_modules${path.sep}`) &&
      !file.includes(`${path.sep}lib${path.sep}site-discovery${path.sep}`) &&
      !file.endsWith(`${path.sep}lib${path.sep}supabase${path.sep}siteScans.ts`) &&
      !file.endsWith(`${path.sep}lib${path.sep}supabase${path.sep}siteScans.test.ts`));
    const offenders = files.filter(file => fs.readFileSync(file, 'utf8').includes('lib/site-discovery'));
    expect(offenders).toEqual([]);
  });
});

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.git' || entry.name === '.next') return [];
      return walk(full);
    }
    return entry.isFile() ? [full] : [];
  });
}

// ── Finding 3 regression (Tranche B review) ───────────────────────────────────
// The WordPress fallback was gated on `queuedSitemaps.length === 0`. A valid
// <urlset> contributes URLs but queues nothing, so the fallback fired even when
// normal discovery had already succeeded, costing two needless requests against
// every site with a working sitemap. The gate must express USABLE discovery.
describe('fallback sitemap probing (Finding 3)', () => {
  const FALLBACK = /wp-sitemap\.xml|sitemap_index\.xml/;

  it('does not probe fallback conventions after a valid urlset', async () => {
    const calls = installFetch({
      'https://example.com/robots.txt': response('', 404),
      'https://example.com/sitemap.xml': response(
        urlset(['https://example.com/a', 'https://example.com/b']),
      ),
    });
    const { urls } = await runDiscovery({ seedUrl: 'https://example.com/', scanId: 'f3-a' });
    expect(calls.filter(url => FALLBACK.test(url))).toHaveLength(0);
    // discovered URLs are still retained
    expect(urls.filter(row => row.urlNormalized?.match(/\/(a|b)$/))).toHaveLength(2);
  });

  it('does not probe fallback conventions after a robots Sitemap directive', async () => {
    const calls = installFetch({
      'https://example.com/robots.txt': response('Sitemap: https://example.com/custom.xml\n'),
      'https://example.com/custom.xml': response(urlset(['https://example.com/a'])),
    });
    await runDiscovery({ seedUrl: 'https://example.com/', scanId: 'f3-c' });
    expect(calls.filter(url => FALLBACK.test(url))).toHaveLength(0);
  });

  it('does not probe fallback conventions after a valid sitemap index', async () => {
    const calls = installFetch({
      'https://example.com/robots.txt': response('', 404),
      'https://example.com/sitemap.xml': response(index(['https://example.com/child.xml'])),
      'https://example.com/child.xml': response(urlset(['https://example.com/a'])),
    });
    await runDiscovery({ seedUrl: 'https://example.com/', scanId: 'f3-b' });
    expect(calls.filter(url => FALLBACK.test(url))).toHaveLength(0);
  });

  it('still probes fallback conventions when normal discovery yields nothing', async () => {
    const calls = installFetch({
      'https://example.com/robots.txt': response('', 404),
      'https://example.com/sitemap.xml': response('', 404),
      'https://example.com/wp-sitemap.xml': response(urlset(['https://example.com/a'])),
    });
    await runDiscovery({ seedUrl: 'https://example.com/', scanId: 'f3-d' });
    expect(calls.filter(url => FALLBACK.test(url)).length).toBeGreaterThan(0);
  });

  it('still probes fallback conventions when the sitemap is malformed', async () => {
    const calls = installFetch({
      'https://example.com/robots.txt': response('', 404),
      'https://example.com/sitemap.xml': response('<html><body>nope</body></html>'),
      'https://example.com/wp-sitemap.xml': response(urlset(['https://example.com/a'])),
    });
    await runDiscovery({ seedUrl: 'https://example.com/', scanId: 'f3-e' });
    expect(calls.filter(url => FALLBACK.test(url)).length).toBeGreaterThan(0);
  });
});
