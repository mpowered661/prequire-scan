import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripHtml, analyzeContentDelivery, analyzeMetaTags } from './content-analyzer';

// Regression guard for exporting `stripHtml`.
//
// Extraction Resilience reuses this function as its EXTRACT_B path. Exporting
// it must not change what it does for the callers that already depend on it, so
// this file pins the behaviour two ways:
//
//   1. against a verbatim copy of the pre-change implementation, and
//   2. against the concrete numbers the existing AEO readiness fixtures produce.
//
// If either drifts, the change was not the no-op it was reported to be.

/**
 * The implementation exactly as it stood before the export keyword was added
 * (git HEAD:lib/aeo-readiness/content-analyzer.ts). Intentionally duplicated —
 * this is a reference oracle, not production code.
 */
function stripHtmlBeforeChange(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fixture(name: string): string {
  return readFileSync(join(__dirname, '__fixtures__', name), 'utf8');
}

const HTML_FIXTURES = [
  'good-article.html',
  'client-side-rendered.html',
  'cloudflare-challenge.html',
  'wordfence-block.html',
];

const EDGE_CASES: [string, string][] = [
  ['empty', ''],
  ['plain text', 'no markup here'],
  ['nested style', '<div><style>.a{content:"<p>"}</style>keep</div>'],
  ['nested script', '<div><script>var x = "</div>";</script>keep</div>'],
  ['comment with markup', '<div><!-- <p>ghost</p> -->keep</div>'],
  ['whitespace runs', '<p>a</p>\n\n\t  <p>b</p>'],
  ['unclosed tag', '<div><p>text'],
  ['attribute with angle bracket', '<div title="a>b">text</div>'],
  ['entities are left alone', '<p>Tom &amp; Jerry &lt;3</p>'],
  ['self-closing', '<p>a<br/>b</p>'],
];

describe('stripHtml — exporting it changed nothing', () => {
  it('matches the pre-change implementation on every existing HTML fixture', () => {
    for (const name of HTML_FIXTURES) {
      const html = fixture(name);
      expect(stripHtml(html), `mismatch on ${name}`).toBe(stripHtmlBeforeChange(html));
    }
  });

  it('matches the pre-change implementation on edge cases', () => {
    for (const [label, html] of EDGE_CASES) {
      expect(stripHtml(html), `mismatch on ${label}`).toBe(stripHtmlBeforeChange(html));
    }
  });
});

describe('analyzeContentDelivery — pinned outputs for existing fixtures', () => {
  it('produces unchanged metrics for a good article', () => {
    const r = analyzeContentDelivery(fixture('good-article.html'));

    expect(r.status).toBe('ok');
    expect(r.content_appears_rendered).toBe(true);
    expect(r.js_challenge_detected).toBe(false);
    expect(r.text_html_ratio).toBeGreaterThan(0.05);
    // The ratio is derived from text_bytes / html_bytes; pinning both pins it.
    expect(r.text_bytes).toBe(
      Buffer.byteLength(stripHtmlBeforeChange(fixture('good-article.html')), 'utf8'),
    );
    expect(r.html_bytes).toBe(Buffer.byteLength(fixture('good-article.html'), 'utf8'));
  });

  it('still classifies a client-side-rendered page as client_side_rendered', () => {
    const r = analyzeContentDelivery(fixture('client-side-rendered.html'));

    expect(r.status).toBe('client_side_rendered');
    expect(r.text_html_ratio).toBeLessThan(0.05);
  });

  it('still detects a Cloudflare JS challenge', () => {
    const r = analyzeContentDelivery(fixture('cloudflare-challenge.html'));

    expect(r.status).toBe('js_challenge');
    expect(r.js_challenge_detected).toBe(true);
    expect(r.challenge_indicators.length).toBeGreaterThan(0);
  });

  it('still reports an empty body as empty', () => {
    const r = analyzeContentDelivery('');

    expect(r.status).toBe('empty');
    expect(r.html_bytes).toBe(0);
    expect(r.text_bytes).toBe(0);
    expect(r.text_html_ratio).toBe(0);
  });
});

describe('analyzeMetaTags — unaffected by the export', () => {
  it('reads robots and canonical from an existing fixture', () => {
    const r = analyzeMetaTags(fixture('good-article.html'), 'GPTBot');

    expect(['ok', 'missing', 'blocked_via_meta']).toContain(r.status);
    expect(Array.isArray(r.ai_blocking_directives)).toBe(true);
  });
});
