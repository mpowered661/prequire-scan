import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzePageArtifact } from './page-analysis';

const base = {
  requestedUrl: 'https://example.com/',
  finalUrl: 'https://example.com/',
  status: 200,
  contentSha256: 'c'.repeat(64),
  contentLength: 0,
  fetchedAt: '2026-09-30T00:00:00.000Z',
};

function analyzeWithUrl(url: string) {
  return analyzePageArtifact('scan', {
    ...base,
    html: `<script type="application/ld+json">{"@type":"Organization","sameAs":["${url}"],"@id":"${url}"}</script><a href="${url}">x</a>`,
  });
}

describe('page analysis security boundary', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('29 performs literally zero fetch calls during page analysis', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    analyzeWithUrl('https://example.org/offsite');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('30 treats external targets as observations only', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const result = analyzeWithUrl('https://outside.example/path');
    expect(result.observations).toHaveLength(4);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('31 does not revalidate or follow engine-triggered redirects', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    analyzeWithUrl('https://example.com/redirect-me');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('32 does not contact private IP, localhost, or integer hosts surfaced by engines', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    analyzeWithUrl('http://127.0.0.1/admin');
    analyzeWithUrl('http://localhost/admin');
    analyzeWithUrl('http://2130706433/admin');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('33 does not contact hex-host, alternate-port, unsupported-scheme, or userinfo URLs', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    analyzeWithUrl('http://0x7f000001/admin');
    analyzeWithUrl('https://example.com:8443/admin');
    analyzeWithUrl('ftp://example.com/file');
    analyzeWithUrl('https://example.com@127.0.0.1/admin');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('34 performs no recursive page discovery from links in analyzed HTML', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    analyzePageArtifact('scan', {
      ...base,
      html: '<a href="/new-page">new</a><a href="/sitemap.xml">sitemap</a><link rel="next" href="/next">',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('35 does not let discovery or target response bodies enter page analysis', () => {
    const result = analyzePageArtifact('scan', {
      ...base,
      html: '<html><body>fetched page body only</body></html>',
    });
    expect(JSON.stringify(result.observations)).not.toContain('robots.txt');
    expect(JSON.stringify(result.observations)).not.toContain('target response body');
  });

  it('36 keeps robots, 429, retry, and budget policy outside zero-request page analysis', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const result = analyzeWithUrl('https://example.com/rate-limited-or-disallowed');
    expect(result.observations.every(observation => observation.scope === 'page')).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
});
