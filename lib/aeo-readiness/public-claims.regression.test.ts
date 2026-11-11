import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { generateFixes } from './fix-library';
import { CATEGORIES } from '../scanUtils';
import type { CrawlerResult, CrawlerTests, DetectedStack } from './types';

// 2026-11-11 regression: the scanner simulates crawler access by user agent and asks an
// LLM to estimate "performance" from page HTML. It never queries an AI assistant, so it
// must not claim citations, visibility in AI answers, or a measured performance score.

const ROOT = path.resolve(__dirname, '..', '..');
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.tsx?$/.test(f) && !/\.test\./.test(f) ? [p] : [];
  });
}
const FILES = ['app', 'components', 'lib'].flatMap((d) => sources(path.join(ROOT, d)));
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

const BANNED: [RegExp, string][] = [
  [/will it cite it/i, 'homepage headline promised a citation answer'],
  [/reach and cite/i, 'homepage claimed the check shows citation'],
  [/will not cite you/i, 'robots fix claimed AI engines will not cite the site'],
  [/invisible to AI engines/i, 'client-render fix claimed content is invisible to AI engines'],
  [/AI crawlers do not execute JavaScript/i, 'stated as universal; some crawlers render JavaScript'],
  [/use it for citations/i, 'claimed crawlers use JSON-LD for citations'],
  [/your score will increase/i, 'promised a score change'],
  [/Can AI engines reach and read/i, 'card subtitle presented simulated access as reading by AI engines'],
  [/citation potential may be limited/i, 'tied crawler access to citation potential'],
  [/across 4 categories/i, 'accessibility is not part of the score'],
];

describe('public claims stay within what the scanner measures', () => {
  for (const [rx, why] of BANNED) {
    it(`no source says ${rx}: ${why}`, () => {
      expect(FILES.filter((f) => rx.test(readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f))).toEqual([]);
    });
  }

  it('the homepage describes a simulated access check and says citations are not measured', () => {
    const page = read('app/page.tsx');
    expect(page).toMatch(/simulated/i);
    expect(page).toMatch(/does not show whether any AI assistant cites or recommends you/);
  });

  it('the overview card says AI answer visibility and accuracy are not measured', () => {
    const page = read('app/overview/page.tsx');
    expect(page).toMatch(/Can AI crawlers fetch your pages\? \(simulated by user agent\)/);
    expect(page).toMatch(/Whether AI assistants mention you, or describe you accurately, is not measured by this scan/);
  });

  it('performance is labelled an estimate, not a measurement', () => {
    const perf = CATEGORIES.find((c) => c.key === 'performance')!;
    expect(perf.label).toMatch(/estimated/i);
    expect(read('app/layout.tsx')).toMatch(/estimated performance/i);
  });
});

const EMPTY_STACK: DetectedStack = { web_server: null, cdn: null, waf: null, cms: null, cms_theme: null };
function base(): CrawlerTests {
  return {
    robots_txt: { status: 'allowed', matched_rule: null, details: 'Allowed' },
    http_response: { status_code: 200, response_time_ms: 100, server: null, waf_detected: null, status: 'ok' },
    content_delivery: { html_bytes: 5000, text_bytes: 2000, text_html_ratio: 0.4, js_challenge_detected: false,
      challenge_indicators: [], content_appears_rendered: true, status: 'ok' },
    meta_tags: { robots_directive: null, ai_blocking_directives: [], canonical: null, status: 'missing' },
    cloaking: { divergence_pct: 0, status: 'ok' },
  };
}

describe('generated fixes describe access, not citation outcomes', () => {
  it('robots.txt fix: says which crawlers are disallowed and separates training from answer crawlers', () => {
    const r: CrawlerResult = { crawler_name: 'GPTBot', user_agent: 'Test/1.0', overall_status: 'blocked',
      blocker_layer: 'robots_txt', blocker_detail: 'Disallow: /',
      tests: { ...base(), robots_txt: { status: 'disallowed', matched_rule: 'Disallow: /', details: 'Blocked' } } };
    const fix = generateFixes([r], EMPTY_STACK).find((f) => /robots/i.test(f.issue))!;
    expect(fix.fix_summary).toMatch(/disallows 1 AI crawler/);
    expect(fix.fix_summary).toMatch(/training/i);
    expect(fix.fix_summary).not.toMatch(/cite/i);
  });

  it('client-render fix: hedges crawler behaviour and promises no citation or score change', () => {
    const r: CrawlerResult = { crawler_name: 'GPTBot', user_agent: 'Test/1.0', overall_status: 'partial',
      blocker_layer: 'client_render', blocker_detail: 'Low text/HTML ratio',
      tests: { ...base(), content_delivery: { html_bytes: 500, text_bytes: 5, text_html_ratio: 0.01,
        js_challenge_detected: false, challenge_indicators: [], content_appears_rendered: false,
        status: 'client_side_rendered' } } };
    const fix = generateFixes([r], EMPTY_STACK).find((f) => /javascript|client/i.test(f.issue))!;
    const text = [fix.issue, fix.fix_summary, ...fix.fix_steps].join(' ');
    expect(text).toMatch(/may not run JavaScript/);
    expect(text).toMatch(/does not guarantee/i);
    expect(text).not.toMatch(/cite|citation|score will/i);
  });
});
