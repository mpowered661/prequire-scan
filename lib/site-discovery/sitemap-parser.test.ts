import { describe, expect, it } from 'vitest';
import { parseSitemap } from './sitemap-parser';
import { MAX_LOC_ENTRIES, MAX_SITEMAP_BYTES } from './versions';

describe('parseSitemap', () => {
  it.each([
    ['doctype', '<!DOCTYPE foo><urlset></urlset>'],
    ['entity', '<!ENTITY foo "bar"><urlset></urlset>'],
    ['billion laughs', '<!DOCTYPE lolz [<!ENTITY lol "lol">]><urlset><url><loc>&lol;</loc></url></urlset>'],
  ])('safely rejects unsafe XML: %s', (_name, xml) => {
    expect(parseSitemap(xml, 'https://example.com/sitemap.xml')).toEqual({ ok: false, reason: 'unsafe_xml' });
  });

  it('rejects oversize documents before parsing', () => {
    expect(parseSitemap('x'.repeat(MAX_SITEMAP_BYTES + 1), 'https://example.com/sitemap.xml')).toEqual({ ok: false, reason: 'oversize' });
  });

  it('rejects non-sitemap bodies', () => {
    expect(parseSitemap('<html><h1>404</h1></html>', 'https://example.com/sitemap.xml')).toEqual({ ok: false, reason: 'not_a_sitemap' });
  });

  it('accepts an empty urlset', () => {
    expect(parseSitemap('<urlset></urlset>', 'https://example.com/sitemap.xml')).toEqual({
      ok: true,
      kind: 'urlset',
      locs: [],
      truncated: false,
    });
  });

  it('truncates at exactly MAX_LOC_ENTRIES', () => {
    const locs = Array.from({ length: MAX_LOC_ENTRIES + 5 }, (_, i) => `<url><loc>https://example.com/${i}</loc></url>`).join('');
    const parsed = parseSitemap(`<urlset>${locs}</urlset>`, 'https://example.com/sitemap.xml');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.locs).toHaveLength(MAX_LOC_ENTRIES);
      expect(parsed.truncated).toBe(true);
    }
  });

  it('decodes only predefined XML entities and BMP numeric references', () => {
    const parsed = parseSitemap('<urlset><url><loc>https://example.com/a&amp;b&#x41;&#65;&quot;&apos;&nbsp;</loc></url></urlset>', 'https://example.com/sitemap.xml');
    expect(parsed).toMatchObject({
      ok: true,
      locs: ['https://example.com/a&bAA"\'&nbsp;'],
    });
  });

  it('returns javascript and cross-origin locs for later filtering', () => {
    const parsed = parseSitemap('<urlset><url><loc>javascript:alert(1)</loc></url><url><loc>https://example.org/x</loc></url></urlset>', 'https://example.com/sitemap.xml');
    expect(parsed).toMatchObject({
      ok: true,
      locs: ['javascript:alert(1)', 'https://example.org/x'],
    });
  });
});
