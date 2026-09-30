import { describe, expect, it } from 'vitest';
import { extractLinks, LINK_EXTRACT_VERSION } from './link-extract';
import { MAX_LINKS_PER_PAGE } from './versions';

describe('extractLinks', () => {
  it('exports the frozen version and extracts anchors in document order', () => {
    const links = extractLinks('<main><a href="/a"> A <b>one</b></a><a>Nope</a><a href="/b#x"><img></a></main>', 'https://example.com/', 'https://example.com');
    expect(LINK_EXTRACT_VERSION).toBe('linkx-0.1');
    expect(links.map(link => [link.hrefRaw, link.targetUrlNormalized, link.anchorText, link.placement])).toEqual([
      ['/a', 'https://example.com/a', 'A one', 'body'],
      ['/b#x', 'https://example.com/b', '', 'body'],
    ]);
  });

  it('uses footer-over-nav placement precedence across all ancestors', () => {
    const [link] = extractLinks('<footer><nav><a href="/x">x</a></nav></footer>', 'https://example.com/', 'https://example.com');
    expect(link.placement).toBe('footer');
  });

  it('records base tag links but marks every one ineligible', () => {
    const links = extractLinks('<base href="https://other.test/"><a href="/x">x</a>', 'https://example.com/', 'https://example.com');
    expect(links[0]).toMatchObject({ targetUrlNormalized: 'https://example.com/x', eligibleForCheck: false, exclusionReason: 'base_tag_present' });
  });

  it('classifies unsupported, external, fragment, malformed, and long hrefs without throwing', () => {
    const links = extractLinks('<a href="mailto:a@example.com">m</a><a href="//example.org/x">e</a><a href="#x">f</a><a href="ht!tp://bad">b</a><a href="/x y">s</a><a href="/' + 'x'.repeat(2050) + '">l</a>', 'https://example.com/', 'https://example.com');
    expect(links.map(link => link.exclusionReason)).toEqual(['unsupported_scheme', 'external', 'fragment_only', 'unparseable', 'unparseable', 'href_too_long']);
    expect(links.every(link => !link.eligibleForCheck)).toBe(true);
  });

  it('caps link bombs', () => {
    const html = Array.from({ length: 5000 }, (_, index) => `<a href="/${index}">${index}</a>`).join('');
    expect(extractLinks(html, 'https://example.com/', 'https://example.com')).toHaveLength(MAX_LINKS_PER_PAGE);
  });
});
