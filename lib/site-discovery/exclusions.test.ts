import { describe, expect, it } from 'vitest';
import { evaluateExclusion, EXCLUSIONS_VERSION } from './exclusions';

describe('evaluateExclusion', () => {
  it('exports the frozen version', () => {
    expect(EXCLUSIONS_VERSION).toBe('excl-0.1');
  });

  it.each([
    ['https://example.com/wp-admin/', 'admin_path'],
    ['https://example.com/login/', 'auth_path'],
    ['https://example.com/logout/', 'logout_path'],
    ['https://example.com/cart/', 'cart_checkout'],
    ['https://example.com/account/', 'account_area'],
    ['https://example.com/?q=abc', 'search_space'],
    ['https://example.com/?add-to-cart=1', 'cart_action'],
    ['https://example.com/?replytocom=1', 'comment_action'],
    ['https://example.com/feed/', 'feed_variant'],
    ['https://example.com/2024/09/', 'calendar_archive'],
    ['https://example.com/page/3/', 'pagination_deep'],
    ['https://example.com/?a=1&b=2&c=3', 'faceted_navigation'],
    ['https://example.com/file.pdf', 'non_html_asset'],
    ['https://example.com/a/b/a/c/a/', 'repeated_path_segments'],
    ['https://example.com/a/b/c/d/e/f/g/h/i/', 'path_too_deep'],
  ])('excludes %s as %s', (url, reason) => {
    expect(evaluateExclusion(url)).toEqual({ excluded: true, reason });
  });

  it('uses the first matching reason deterministically', () => {
    expect(evaluateExclusion('https://example.com/login/?q=x').reason).toBe('auth_path');
  });
});
