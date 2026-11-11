// Page-level regression: server-renders the real readiness and report pages from
// a stored-row fixture shaped like the 2026-11-10 prequire.ai scan (12 crawlers
// Cloudflare-challenged, 2 robots.txt tokens, an old stored fix that told owners
// to add a User-Agent bypass). No network, no Supabase, no model calls.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CRAWLERS } from '@/lib/aeo-readiness/crawlers';
import type { AeoReadinessReport, CrawlerResult, CrawlerTests } from '@/lib/aeo-readiness/types';
import type { ScanResult } from '@/lib/scanPrompt';

const CHECK_ID = 'c2ba6a65-f76f-4c77-bed7-deb28db9f7ed';
const SCAN_ID = '9b498630-31fa-4ab3-bb1f-29545d6ab014';

function tests(over: Partial<CrawlerTests>): CrawlerTests {
  return {
    robots_txt: { status: 'allowed', matched_rule: null, details: 'Allowed' },
    http_response: { status_code: 403, response_time_ms: 120, server: 'cloudflare', waf_detected: 'Cloudflare', status: 'challenged' },
    content_delivery: {
      html_bytes: 5000, text_bytes: 80, text_html_ratio: 0.016,
      js_challenge_detected: true, challenge_indicators: ['just a moment'],
      content_appears_rendered: false, status: 'js_challenge',
    },
    meta_tags: { robots_directive: null, ai_blocking_directives: [], canonical: null, status: 'missing' },
    cloaking: { divergence_pct: 0, status: 'not_tested' },
    ...over,
  };
}

const NA: Partial<CrawlerTests> = {
  http_response: { status_code: 0, response_time_ms: 0, server: null, waf_detected: null, status: 'not_applicable' },
  content_delivery: { html_bytes: 0, text_bytes: 0, text_html_ratio: 0, js_challenge_detected: false, challenge_indicators: [], content_appears_rendered: false, status: 'not_applicable' },
  meta_tags: { robots_directive: null, ai_blocking_directives: [], canonical: null, status: 'not_applicable' },
  cloaking: { divergence_pct: 0, status: 'not_applicable' },
};

const rows: CrawlerResult[] = CRAWLERS.filter((c) => c.tier !== 'seo').map((c) =>
  c.check_type === 'robots_only'
    ? { crawler_name: c.name, user_agent: c.user_agent, overall_status: 'accessible', blocker_layer: 'none', blocker_detail: 'Permitted by robots.txt (directive token — robots-only check)', tests: tests(NA) }
    : { crawler_name: c.name, user_agent: c.user_agent, overall_status: 'undeterminable', blocker_layer: 'waf', blocker_detail: 'Browser challenge — undeterminable via UA simulation (consistent with a Cloudflare challenge)', tests: tests({}) },
);

const STORED_REPORT: AeoReadinessReport = {
  url: 'https://prequire.ai/',
  tested_at: '2026-11-10T03:30:02Z',
  registry_version: '2026-08',
  aeo_readiness_score: 100,
  summary: { total_crawlers_tested: rows.length, accessible: 2, partial: 0, blocked: 0, undeterminable: 12, primary_blocker: 'waf' },
  crawler_results: rows,
  detected_stack: { web_server: 'cloudflare', cdn: 'Cloudflare', waf: 'Cloudflare', cms: null, cms_theme: null },
  // What production stored before this change — must never render again.
  fixes: [{
    priority: 'high',
    issue: 'Browser challenge served to AI crawler user-agents (undeterminable)',
    affected_crawlers: ['GPTBot'],
    fix_summary: 'old',
    fix_steps: ['Set: User Agent contains GPTBot → Action: Bypass → Browser Integrity Check'],
    fix_platform: 'Cloudflare',
  }],
  llms_txt: { present: true, url: 'https://prequire.ai/llms.txt' },
};

const category = (score: number) => ({ score, checks: [{ label: 'c', status: 'pass' as const, detail: 'd' }], recommendations: ['r1', 'r2', 'r3'] });
const SCAN: ScanResult = {
  overallScore: 81,
  summary: 'Strong AEO readiness.',
  categories: {
    contentQuality: category(78),
    schemaMarkup: category(92),
    performance: category(72),
    accessibility: {
      score: null,
      checks: [
        ...['Heading Hierarchy', 'Alt Text', 'ARIA Landmarks', 'Semantic HTML and Form Labels'].map((label) => ({ label, status: 'pass' as const, detail: 'ok' })),
        ...['Color Contrast', 'Keyboard Navigation and Focus Management'].map((label) => ({ label, status: 'not_assessable' as const, detail: 'Not assessable from fetched HTML — requires a rendered-page audit.' })),
      ],
      recommendations: ['Verify contrast'],
    },
  },
};

vi.mock('@/lib/supabase/readinessChecks', () => ({
  getReadinessCheck: async () => ({ check_id: CHECK_ID, url: 'https://prequire.ai/', score: 100, report: STORED_REPORT }),
}));
vi.mock('@/lib/supabase/scanResults', () => ({
  getScanResult: async () => ({ scan_id: SCAN_ID, url: 'https://prequire.ai/', overall_score: 81, result_json: SCAN, created_at: '2026-11-10T03:30:02Z' }),
}));

let readinessHtml = '';
let reportHtml = '';
let readinessMeta: { description?: string | null } = {};

beforeAll(async () => {
  const readiness = await import('./readiness/[check_id]/page');
  const report = await import('./report/[scan_id]/page');
  readinessHtml = renderToStaticMarkup(await readiness.default({ params: Promise.resolve({ check_id: CHECK_ID }) }));
  readinessMeta = await readiness.generateMetadata({ params: Promise.resolve({ check_id: CHECK_ID }) });
  reportHtml = renderToStaticMarkup(await report.default({ params: Promise.resolve({ scan_id: SCAN_ID }) }));
});

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

describe('readiness page — prequire.ai stored report', () => {
  it('headlines "Not verified", not a score', () => {
    const t = text(readinessHtml);
    expect(t).toContain('Not verified — AI Crawler Accessibility');
    expect(t).toContain('12 of 12 simulated crawler requests could not be verified');
    expect(t).toContain('No simulated request was determinable — no score');
    expect(t).not.toMatch(/Excellent|have full access/);
  });

  it('reports robots.txt tokens as permissions, apart from access', () => {
    const t = text(readinessHtml);
    expect(t).toContain('0 of 12 simulated requests received page content');
    expect(t).toContain('robots.txt permits 2 of 2 AI-use tokens');
    expect(t).toContain('Permitted by robots.txt (not requested)');
  });

  it('renders regenerated safe guidance, never the stored bypass step', () => {
    expect(readinessHtml).not.toMatch(/Action: Bypass|User Agent contains/);
    expect(text(readinessHtml)).toContain('Security → Events');
    expect(text(readinessHtml)).toContain('Re-running this check will not confirm it');
  });

  it('every fix button is the contextual email link', () => {
    expect(readinessHtml).not.toContain('#pricing');
    const hrefs = [...readinessHtml.matchAll(/href="(mailto:[^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
    expect(hrefs.length).toBe(2);
    for (const h of hrefs) expect(decodeURIComponent(h)).toContain(`https://scan.prequire.ai/readiness/${CHECK_ID}`);
  });

  it('metadata claims no score', () => {
    expect(readinessMeta.description).toBe('12 of 12 simulated AI crawler requests could not be verified. No accessibility score is claimed.');
  });
});

describe('report page — prequire.ai stored scan', () => {
  it('labels the gauge as citation readiness, not an overall AEO score', () => {
    const t = text(reportHtml);
    expect(t).toContain('81');
    expect(t).toContain('Citation readiness');
    expect(t).not.toMatch(/AEO Score/);
  });

  it('shows accessibility as check counts with the WCAG/ADA disclaimer, no 100 bar', () => {
    const t = text(reportHtml);
    expect(t).toContain('4 of 4 static checks passed · 2 not assessed');
    expect(t).toContain('not a complete WCAG or ADA accessibility assessment');
    expect(reportHtml).not.toContain('width:100%');
  });

  it('fix links carry the report and never point at #pricing', () => {
    expect(reportHtml).not.toContain('#pricing');
    const hrefs = [...reportHtml.matchAll(/href="(mailto:[^"]+)"/g)].map((m) => decodeURIComponent(m[1].replace(/&amp;/g, '&')));
    expect(hrefs.length).toBeGreaterThanOrEqual(2);
    for (const h of hrefs) expect(h).toContain(`https://scan.prequire.ai/report/${SCAN_ID}`);
  });
});
