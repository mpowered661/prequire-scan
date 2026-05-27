import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { analyzeContentDelivery, analyzeMetaTags, analyzeCloaking } from './content-analyzer';

function fixture(name: string): string {
  return readFileSync(
    resolve(process.cwd(), 'lib/aeo-readiness/__fixtures__', name),
    'utf8',
  );
}

describe('analyzeContentDelivery', () => {
  it('detects Cloudflare-style JS challenge ("Just a moment...")', () => {
    const result = analyzeContentDelivery(fixture('cloudflare-challenge.html'));
    expect(result.js_challenge_detected).toBe(true);
    expect(result.status).toBe('js_challenge');
    expect(result.challenge_indicators.length).toBeGreaterThan(0);
  });

  it('detects Wordfence-style challenge ("Please enable JavaScript")', () => {
    const result = analyzeContentDelivery(fixture('wordfence-block.html'));
    expect(result.js_challenge_detected).toBe(true);
    expect(result.status).toBe('js_challenge');
    expect(result.challenge_indicators).toContain('please enable javascript');
  });

  it('detects client-side rendered page (low text/HTML ratio)', () => {
    const result = analyzeContentDelivery(fixture('client-side-rendered.html'));
    expect(result.text_html_ratio).toBeLessThan(0.05);
    expect(result.status).toBe('client_side_rendered');
  });

  it('classifies well-formed article HTML as "ok"', () => {
    const result = analyzeContentDelivery(fixture('good-article.html'));
    expect(result.status).toBe('ok');
    expect(result.js_challenge_detected).toBe(false);
    expect(result.text_html_ratio).toBeGreaterThan(0.05);
    expect(result.content_appears_rendered).toBe(true);
  });

  it('classifies empty body as "empty"', () => {
    const result = analyzeContentDelivery('');
    expect(result.status).toBe('empty');
    expect(result.html_bytes).toBe(0);
  });

  it('does not crash on binary-like or plain text content', () => {
    const binary = '\x00\x01\x02\x03 some random bytes \xFF\xFE';
    expect(() => analyzeContentDelivery(binary)).not.toThrow();
  });

  it('does not crash on extremely large input', () => {
    const large = '<p>' + 'a'.repeat(500_000) + '</p>';
    expect(() => analyzeContentDelivery(large)).not.toThrow();
  });

  it('reports correct html_bytes and text_bytes for good article', () => {
    const html = '<html><body><p>Hello world</p></body></html>';
    const result = analyzeContentDelivery(html);
    expect(result.html_bytes).toBe(Buffer.byteLength(html, 'utf8'));
    expect(result.text_bytes).toBeGreaterThan(0);
    expect(result.text_bytes).toBeLessThan(result.html_bytes);
  });

  it('does not flag article content as a JS challenge', () => {
    const result = analyzeContentDelivery(fixture('good-article.html'));
    expect(result.js_challenge_detected).toBe(false);
    expect(result.challenge_indicators).toHaveLength(0);
  });
});

describe('analyzeMetaTags', () => {
  it('returns "missing" when no robots meta tag is present', () => {
    const html = '<html><head><title>Page</title></head><body><p>Content</p></body></html>';
    const result = analyzeMetaTags(html, 'GPTBot');
    expect(result.status).toBe('missing');
    expect(result.robots_directive).toBeNull();
  });

  it('returns "ok" for index, follow directive', () => {
    const html = '<html><head><meta name="robots" content="index, follow"></head><body></body></html>';
    const result = analyzeMetaTags(html, 'GPTBot');
    expect(result.status).toBe('ok');
    expect(result.robots_directive).toBe('index, follow');
  });

  it('returns "blocked_via_meta" for noindex directive', () => {
    const html = '<html><head><meta name="robots" content="noindex"></head><body></body></html>';
    const result = analyzeMetaTags(html, 'GPTBot');
    expect(result.status).toBe('blocked_via_meta');
  });

  it('returns "blocked_via_meta" for noai directive', () => {
    const html = '<html><head><meta name="robots" content="noai"></head><body></body></html>';
    const result = analyzeMetaTags(html, 'GPTBot');
    expect(result.status).toBe('blocked_via_meta');
    expect(result.ai_blocking_directives).toContain('noai');
  });

  it('returns "blocked_via_meta" for none directive', () => {
    const html = '<html><head><meta name="robots" content="none"></head><body></body></html>';
    const result = analyzeMetaTags(html, 'GPTBot');
    expect(result.status).toBe('blocked_via_meta');
  });

  it('includes noarchive in ai_blocking_directives but does not hard-block', () => {
    const html = '<html><head><meta name="robots" content="noarchive"></head><body></body></html>';
    const result = analyzeMetaTags(html, 'GPTBot');
    // noarchive is informational — does not constitute a hard block
    expect(result.ai_blocking_directives).toContain('noarchive');
    expect(result.status).toBe('ok');
  });

  it('parses canonical link', () => {
    const html = '<html><head><link rel="canonical" href="https://example.com/canonical"></head><body></body></html>';
    const result = analyzeMetaTags(html, 'GPTBot');
    expect(result.canonical).toBe('https://example.com/canonical');
  });

  it('parses the canonical from the good-article fixture', () => {
    const result = analyzeMetaTags(fixture('good-article.html'), 'GPTBot');
    expect(result.canonical).toBe('https://example.com/article/what-is-aeo');
    expect(result.status).toBe('ok');
  });
});

describe('analyzeCloaking', () => {
  it('returns "not_tested" when either body is empty', () => {
    expect(analyzeCloaking('', 'browser content').status).toBe('not_tested');
    expect(analyzeCloaking('bot content', '').status).toBe('not_tested');
    expect(analyzeCloaking('', '').status).toBe('not_tested');
  });

  it('returns "ok" when bot and browser receive identical content', () => {
    const html = fixture('good-article.html');
    const result = analyzeCloaking(html, html);
    expect(result.status).toBe('ok');
    expect(result.divergence_pct).toBe(0);
  });

  it('returns "ok" when content is very similar (small divergence)', () => {
    const base = fixture('good-article.html');
    // Add a small personalised snippet to the browser version
    const browser = base.replace('</body>', '<p>Welcome back!</p></body>');
    const result = analyzeCloaking(base, browser);
    expect(result.status).toBe('ok');
    expect(result.divergence_pct).toBeLessThanOrEqual(0.3);
  });

  it('returns "potential_cloaking" when content differs significantly', () => {
    const botBody = '<html><body><p>Simple page for bots. No real content here.</p></body></html>';
    const browserBody = fixture('good-article.html'); // full rich article
    const result = analyzeCloaking(botBody, browserBody);
    expect(result.status).toBe('potential_cloaking');
    expect(result.divergence_pct).toBeGreaterThan(0.3);
  });

  it('divergence is between 0 and 1', () => {
    const result = analyzeCloaking('<p>hello world</p>', '<p>completely different text here</p>');
    expect(result.divergence_pct).toBeGreaterThanOrEqual(0);
    expect(result.divergence_pct).toBeLessThanOrEqual(1);
  });
});
