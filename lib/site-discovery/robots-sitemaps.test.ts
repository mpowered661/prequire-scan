import { describe, expect, it } from 'vitest';
import { extractSitemapDirectives } from './robots-sitemaps';

describe('extractSitemapDirectives', () => {
  it('handles mixed case and leading whitespace', () => {
    expect(extractSitemapDirectives('  SiteMap: https://example.com/sitemap.xml')).toEqual(['https://example.com/sitemap.xml']);
  });

  it('ignores commented-out directives and inline comments', () => {
    expect(extractSitemapDirectives('# Sitemap: https://example.com/no.xml\nSitemap: https://example.com/yes.xml # ok')).toEqual(['https://example.com/yes.xml']);
  });

  it('handles CRLF and zero directives', () => {
    expect(extractSitemapDirectives('User-agent: *\r\nAllow: /')).toEqual([]);
  });

  it('deduplicates in file order and caps at 10', () => {
    const body = Array.from({ length: 12 }, (_, i) => `Sitemap: value-${i}`).join('\n') + '\nSitemap: value-1';
    expect(extractSitemapDirectives(body)).toEqual(Array.from({ length: 10 }, (_, i) => `value-${i}`));
  });

  it('keeps non-URL values as evidence', () => {
    expect(extractSitemapDirectives('Sitemap: not a url')).toEqual(['not a url']);
  });
});
