import { describe, expect, it } from 'vitest';
import { normalizeUrl } from './normalize-url';

function ok(raw: string, base?: string) {
  const result = normalizeUrl(raw, base);
  if (!result.ok) throw new Error(result.reason);
  return result.normalized;
}

describe('normalizeUrl', () => {
  it('is idempotent', () => {
    const once = ok('HTTP://EXAMPLE.COM:80/a/../x?b=2&utm_source=x&a=1#frag');
    expect(ok(once)).toBe(once);
  });

  it('removes fragments and tracking parameters', () => {
    expect(ok('https://example.com/p?utm_source=x&a=1#top')).toBe('https://example.com/p?a=1');
  });

  it('sorts query params stably and preserves repeated names', () => {
    expect(ok('https://example.com/p?b=2&a=2&a=1')).toBe('https://example.com/p?a=1&a=2&b=2');
  });

  it('keeps path slash and case distinctions', () => {
    expect(ok('https://example.com/a/')).not.toBe(ok('https://example.com/a'));
    expect(ok('https://example.com/A/')).not.toBe(ok('https://example.com/a/'));
  });

  it('normalizes scheme host port and dot segments', () => {
    expect(ok('HTTP://EXAMPLE.COM:80/a/../x')).toBe('http://example.com/x');
  });

  it.each([
    ['https://EXAMPLE.com/', 'https://example.com/'],
    ['http://example.com:80/x', 'http://example.com/x'],
    ['https://example.com:443/x', 'https://example.com/x'],
    ['https://example.com:444/x', 'https://example.com:444/x'],
    ['https://example.com/x#frag', 'https://example.com/x'],
    ['https://example.com/x?b=2&a=1', 'https://example.com/x?a=1&b=2'],
    ['https://example.com/x?b=&a=', 'https://example.com/x?a=&b='],
    ['https://example.com/x?ref=x&a=1', 'https://example.com/x?a=1'],
    ['https://example.com/x?Ref=x&a=1', 'https://example.com/x?a=1'],
    ['https://example.com/x?mc_cid=x&a=1', 'https://example.com/x?a=1'],
    ['https://example.com/x?mc_eid=x&a=1', 'https://example.com/x?a=1'],
    ['https://example.com/x?gclid=x&a=1', 'https://example.com/x?a=1'],
    ['https://example.com/x?fbclid=x&a=1', 'https://example.com/x?a=1'],
    ['https://example.com/x?msclkid=x&a=1', 'https://example.com/x?a=1'],
    ['https://example.com/a/./b', 'https://example.com/a/b'],
    ['https://example.com/a/b/../c', 'https://example.com/a/c'],
    ['https://example.com/%7Euser', 'https://example.com/%7Euser'],
    ['https://example.com/x?sp=a%20b', 'https://example.com/x?sp=a+b'],
    ['/rel?b=2&a=1', 'https://example.com/rel?a=1&b=2', 'https://example.com/base'],
    ['../up', 'https://example.com/up', 'https://example.com/a/b'],
  ])('normalizes %s', (raw, expected, base) => {
    expect(ok(raw, base)).toBe(expected);
  });

  it('guards expected and unexpected collisions', () => {
    expect(ok('https://example.com/x?a=1&b=2')).toBe(ok('https://example.com/x?b=2&a=1'));
    expect(ok('https://example.com/x?a=1')).not.toBe(ok('https://example.com/x?a=1&a=2'));
  });

  it('rejects non-http schemes', () => {
    expect(normalizeUrl('javascript:alert(1)')).toEqual({ ok: false, reason: 'unsupported_scheme' });
  });
});
