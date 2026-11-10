import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { computeScore, effectiveStatus } from './scoring';
import { determineOverallStatus } from './report-builder';
import { visibilityView, overallScore, resultLabel } from './score-surface';
import { generateFixes, verifiedTrafficSteps } from './fix-library';
import { CRAWLERS } from './crawlers';
import type { AeoReadinessReport, CrawlerResult, CrawlerTests, DetectedStack } from './types';

function tests(over: Partial<CrawlerTests> = {}): CrawlerTests {
  return {
    robots_txt: { status: 'allowed', matched_rule: null, details: 'Allowed' },
    http_response: { status_code: 200, response_time_ms: 100, server: null, waf_detected: null, status: 'ok' },
    content_delivery: {
      html_bytes: 5000, text_bytes: 2000, text_html_ratio: 0.4,
      js_challenge_detected: false, challenge_indicators: [],
      content_appears_rendered: true, status: 'ok',
    },
    meta_tags: { robots_directive: null, ai_blocking_directives: [], canonical: null, status: 'missing' },
    cloaking: { divergence_pct: 0, status: 'ok' },
    ...over,
  };
}

const NA: Partial<CrawlerTests> = {
  http_response: { status_code: 0, response_time_ms: 0, server: null, waf_detected: null, status: 'not_applicable' },
};

function row(name: string, status: CrawlerResult['overall_status'], over: Partial<CrawlerTests> = {}): CrawlerResult {
  return { crawler_name: name, user_agent: 'x', overall_status: status, blocker_layer: 'none', blocker_detail: '', tests: tests(over) };
}

const challenged: Partial<CrawlerTests> = {
  http_response: { status_code: 403, response_time_ms: 100, server: 'cloudflare', waf_detected: 'Cloudflare', status: 'challenged' },
};

const SIMULATED = CRAWLERS.filter((c) => c.check_type !== 'robots_only' && c.tier !== 'seo').map((c) => c.name);
const TOKENS = ['Google-Extended', 'Applebot-Extended'];

function report(results: CrawlerResult[], undeterminable: number | null = 0): AeoReadinessReport {
  return {
    url: 'https://example.com/',
    tested_at: '2026-11-10T00:00:00Z',
    aeo_readiness_score: 100,
    summary: { total_crawlers_tested: results.length, accessible: 0, partial: 0, blocked: 0, undeterminable: undeterminable ?? undefined, primary_blocker: null },
    crawler_results: results,
    detected_stack: { web_server: null, cdn: null, waf: null, cms: null, cms_theme: null },
    fixes: [],
    llms_txt: { present: false, url: null },
  };
}

// The prequire.ai scan of 2026-11-10: every requested crawler challenged by
// Cloudflare; only the two robots.txt tokens "accessible".
const PREQUIRE_AI = report([
  ...SIMULATED.map((n) => row(n, 'undeterminable', challenged)),
  ...TOKENS.map((n) => row(n, 'accessible', NA)),
], 12);

describe('score integrity — robots.txt tokens are permissions, not access', () => {
  it('computeScore ignores robots-only tokens (registry)', () => {
    const results = [row('GPTBot', 'blocked'), ...TOKENS.map((n) => row(n, 'accessible', NA))];
    expect(computeScore(results, CRAWLERS)).toBe(0);
  });

  it('computeScore ignores stored token rows even without registry help', () => {
    const results = [row('GPTBot', 'accessible'), row('Unknown-Token', 'blocked', NA)];
    expect(computeScore(results, [])).toBe(100);
  });

  it('the prequire.ai case: no verified coverage → no visibility score, no overall score', () => {
    const view = visibilityView(PREQUIRE_AI);
    expect(view.state).toBe('insufficient');
    if (view.state === 'legacy') throw new Error('unexpected legacy');
    expect(view.score).toBeNull();
    expect(view.simulated).toMatchObject({ total: 12, undeterminable: 12, determinable: 0, accessible: 0 });
    expect(view.robotsTokens).toEqual({ total: 2, permitted: 2, disallowed: 0, unverified: 0 });
    expect(overallScore(view, 81)).toBeNull();
  });

  it('labels a token as a robots.txt permission, never as access', () => {
    const l = resultLabel(row('Google-Extended', 'accessible', NA));
    expect(l.kind).toBe('robots_token');
    expect(l.label).toBe('Permitted by robots.txt (not requested)');
    expect(l.label.toLowerCase()).not.toMatch(/access/);
  });

  it('labels a disallowed token as disallowed', () => {
    const r = row('Google-Extended', 'blocked', { ...NA, robots_txt: { status: 'disallowed', matched_rule: 'Disallow: /', details: '' } });
    expect(resultLabel(r).label).toBe('Disallowed by robots.txt');
  });

  it('labels simulated access as simulated', () => {
    expect(resultLabel(row('GPTBot', 'accessible')).label).toBe('Content received (simulated)');
  });
});

describe('score integrity — overall score needs sufficient verified coverage', () => {
  it('sufficient coverage: overall is the 50/50 average over simulated requests only', () => {
    const view = visibilityView(report([
      ...SIMULATED.map((n) => row(n, 'accessible')),
      ...TOKENS.map((n) => row(n, 'blocked', { ...NA, robots_txt: { status: 'disallowed', matched_rule: 'Disallow: /', details: '' } })),
    ]));
    expect(view.state).toBe('sufficient');
    if (view.state === 'legacy') throw new Error('unexpected legacy');
    expect(view.score).toBe(100); // token disallows do not drag simulated access down
    expect(overallScore(view, 81)).toBe(91);
  });

  it('exactly half determinable is sufficient; below half is not', () => {
    const half = SIMULATED.length / 2;
    const mk = (det: number) =>
      visibilityView(report(SIMULATED.map((n, i) => (i < det ? row(n, 'accessible') : row(n, 'undeterminable', challenged))), SIMULATED.length - det));
    expect(mk(half).state).toBe('sufficient');
    expect(mk(half - 1).state).toBe('insufficient');
  });

  it('insufficient coverage keeps the determinable score as detail only', () => {
    const view = visibilityView(report([
      row('GPTBot', 'accessible'),
      ...SIMULATED.slice(1).map((n) => row(n, 'undeterminable', challenged)),
    ], SIMULATED.length - 1));
    if (view.state === 'legacy') throw new Error('unexpected legacy');
    expect(view.state).toBe('insufficient');
    expect(view.score).toBe(100);
    expect(overallScore(view, 60)).toBeNull();
  });

  it('legacy reports (no undeterminable count) never produce an overall score', () => {
    const view = visibilityView(report([row('GPTBot', 'accessible')], null));
    expect(view.state).toBe('legacy');
    expect(overallScore(view, 90)).toBeNull();
  });
});

describe('score integrity — 5xx and timeouts are not confirmed blocks', () => {
  it('a 503 on the simulated request is undeterminable', () => {
    const v = determineOverallStatus(tests({
      http_response: { status_code: 503, response_time_ms: 100, server: null, waf_detected: null, status: 'error' },
    }));
    expect(v.overall_status).toBe('undeterminable');
    expect(v.blocker_detail).toMatch(/HTTP 503/);
    expect(v.blocker_detail).toMatch(/not evidence of blocking/);
  });

  it('a timeout is undeterminable', () => {
    const v = determineOverallStatus(tests({
      http_response: { status_code: 0, response_time_ms: 10000, server: null, waf_detected: null, status: 'error' },
    }));
    expect(v.overall_status).toBe('undeterminable');
    expect(v.blocker_detail).toMatch(/timeout/i);
  });

  it('a robots.txt disallow is still a block', () => {
    expect(determineOverallStatus(tests({
      robots_txt: { status: 'disallowed', matched_rule: 'Disallow: /', details: '' },
    })).overall_status).toBe('blocked');
  });

  it('stored rows that called a server error "blocked" now read as undeterminable', () => {
    const stored = row('GPTBot', 'blocked', {
      http_response: { status_code: 0, response_time_ms: 10000, server: null, waf_detected: null, status: 'error' },
    });
    expect(effectiveStatus(stored)).toBe('undeterminable');
    expect(computeScore([stored, row('ClaudeBot', 'accessible')], CRAWLERS)).toBe(100);
    const view = visibilityView(report([stored]));
    if (view.state === 'legacy') throw new Error('unexpected legacy');
    expect(view.simulated.blocked).toBe(0);
    expect(view.simulated.undeterminable).toBe(1);
  });
});

describe('safe crawler guidance', () => {
  const stacks: DetectedStack[] = ['Cloudflare', 'Wordfence', 'Sucuri', 'Akamai', null].map((waf) => ({
    web_server: null, cdn: null, waf, cms: null, cms_theme: null,
  }));
  const inputs = [
    row('GPTBot', 'undeterminable', challenged),
    row('ClaudeBot', 'undeterminable', {
      http_response: { status_code: 403, response_time_ms: 100, server: null, waf_detected: null, status: 'refused' },
    }),
  ];

  for (const stack of stacks) {
    it(`never recommends a User-Agent exception or bypass (${stack.waf ?? 'unknown'})`, () => {
      for (const fix of generateFixes(inputs, stack)) {
        const actionable = fix.fix_steps.filter((s) => !s.startsWith('Do not'));
        for (const step of actionable) {
          expect(step).not.toMatch(/user.?agent/i);
          expect(step).not.toMatch(/\bbypass\b|\bskip\b/i);
        }
        expect(fix.fix_steps.join(' ')).not.toMatch(/re-run this check to confirm/i);
      }
    });
  }

  it('explains the simulation limit and checks real traffic first', () => {
    for (const p of ['Cloudflare', 'Wordfence', 'Sucuri', null]) {
      const steps = verifiedTrafficSteps(p);
      expect(steps[0]).toMatch(/log|events|live traffic/i);
      expect(steps.some((s) => /will not confirm/i.test(s))).toBe(true);
      expect(steps.some((s) => /^Do not add rules/.test(s))).toBe(true);
    }
    const fix = generateFixes([inputs[0]], stacks[0]).find((f) => /challenge/i.test(f.issue))!;
    expect(fix.fix_summary).toMatch(/not verified crawler IP addresses/);
  });
});

describe('no dead or misleading destinations in pages', () => {
  const ROOT = path.resolve(__dirname, '..', '..');
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
      const p = path.join(dir, f);
      if (statSync(p).isDirectory()) return sources(p);
      return /\.tsx?$/.test(f) && !/\.test\./.test(f) ? [p] : [];
    });
  }
  const files = [...sources(path.join(ROOT, 'app')), ...sources(path.join(ROOT, 'components'))];

  it('no link points at the removed prequire.ai #pricing section', () => {
    const offenders = files.filter((f) => readFileSync(f, 'utf8').includes('#pricing'));
    expect(offenders).toEqual([]);
  });

  it('no page claims crawlers "have full access"', () => {
    const offenders = files.filter((f) => /have full access/i.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
