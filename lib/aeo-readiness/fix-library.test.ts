import { describe, it, expect } from 'vitest';
import { generateFixes } from './fix-library';
import type { CrawlerResult, DetectedStack, CrawlerTests } from './types';

const EMPTY_STACK: DetectedStack = {
  web_server: null, cdn: null, waf: null, cms: null, cms_theme: null,
};

function baseFetch(): CrawlerTests {
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
  };
}

function robotsBlocked(name: string): CrawlerResult {
  return {
    crawler_name: name, user_agent: 'Test/1.0',
    overall_status: 'blocked', blocker_layer: 'robots_txt', blocker_detail: 'Disallow: /',
    tests: { ...baseFetch(), robots_txt: { status: 'disallowed', matched_rule: 'Disallow: /', details: 'Blocked' } },
  };
}

function httpRefused(name: string, statusCode = 403, waf: string | null = null): CrawlerResult {
  return {
    crawler_name: name, user_agent: 'Test/1.0',
    overall_status: 'undeterminable', blocker_layer: waf ? 'waf' : 'unknown',
    blocker_detail: `HTTP ${statusCode} refusal — undeterminable via UA simulation`,
    tests: {
      ...baseFetch(),
      http_response: { status_code: statusCode, response_time_ms: 100, server: null, waf_detected: waf, status: 'refused' },
    },
  };
}

function jsChallenged(name: string): CrawlerResult {
  return {
    crawler_name: name, user_agent: 'Test/1.0',
    overall_status: 'undeterminable', blocker_layer: 'cdn', blocker_detail: 'Browser challenge — undeterminable via UA simulation',
    tests: {
      ...baseFetch(),
      http_response: { status_code: 200, response_time_ms: 100, server: null, waf_detected: null, status: 'challenged' },
      content_delivery: {
        html_bytes: 2000, text_bytes: 50, text_html_ratio: 0.025,
        js_challenge_detected: true, challenge_indicators: ['just a moment', '_cf_chl'],
        content_appears_rendered: false, status: 'js_challenge',
      },
    },
  };
}

function metaBlocked(name: string): CrawlerResult {
  return {
    crawler_name: name, user_agent: 'Test/1.0',
    overall_status: 'blocked', blocker_layer: 'meta_tags', blocker_detail: 'Meta robots: noai',
    tests: {
      ...baseFetch(),
      meta_tags: { robots_directive: 'noai', ai_blocking_directives: ['noai'], canonical: null, status: 'blocked_via_meta' },
    },
  };
}

function csrPartial(name: string): CrawlerResult {
  return {
    crawler_name: name, user_agent: 'Test/1.0',
    overall_status: 'partial', blocker_layer: 'client_render', blocker_detail: 'Low text/HTML ratio',
    tests: {
      ...baseFetch(),
      content_delivery: {
        html_bytes: 500, text_bytes: 5, text_html_ratio: 0.01,
        js_challenge_detected: false, challenge_indicators: [],
        content_appears_rendered: false, status: 'client_side_rendered',
      },
    },
  };
}

function cloakingPartial(name: string): CrawlerResult {
  return {
    crawler_name: name, user_agent: 'Test/1.0',
    overall_status: 'partial', blocker_layer: 'none', blocker_detail: 'Cloaking 40%',
    tests: { ...baseFetch(), cloaking: { divergence_pct: 0.4, status: 'potential_cloaking' } },
  };
}

function serverError(name: string): CrawlerResult {
  return {
    crawler_name: name, user_agent: 'Test/1.0',
    overall_status: 'blocked', blocker_layer: 'server_error', blocker_detail: 'Connection error',
    tests: {
      ...baseFetch(),
      http_response: { status_code: 0, response_time_ms: 10000, server: null, waf_detected: null, status: 'error' },
    },
  };
}

describe('generateFixes — robots.txt blocking', () => {
  it('generates a fix when a bot is disallowed', () => {
    const fixes = generateFixes([robotsBlocked('GPTBot')], EMPTY_STACK);
    expect(fixes.some((f) => f.issue.toLowerCase().includes('robots'))).toBe(true);
  });

  it('marks priority critical when a critical bot (GPTBot) is blocked', () => {
    const fixes = generateFixes([robotsBlocked('GPTBot')], EMPTY_STACK);
    const fix = fixes.find((f) => f.issue.toLowerCase().includes('robots'))!;
    expect(fix.priority).toBe('critical');
  });

  it('marks priority high when only a non-critical bot (Amazonbot) is blocked', () => {
    const fixes = generateFixes([robotsBlocked('Amazonbot')], EMPTY_STACK);
    const fix = fixes.find((f) => f.issue.toLowerCase().includes('robots'))!;
    expect(fix.priority).toBe('high');
  });

  it('sets fix_platform to WordPress / Yoast SEO when CMS is WordPress', () => {
    const fixes = generateFixes([robotsBlocked('GPTBot')], { ...EMPTY_STACK, cms: 'WordPress' });
    const fix = fixes.find((f) => f.issue.toLowerCase().includes('robots'))!;
    expect(fix.fix_platform).toBe('WordPress / Yoast SEO');
  });

  it('fix_platform is null for non-WordPress sites', () => {
    const fixes = generateFixes([robotsBlocked('GPTBot')], EMPTY_STACK);
    const fix = fixes.find((f) => f.issue.toLowerCase().includes('robots'))!;
    expect(fix.fix_platform).toBeNull();
  });

  it('mentions Yoast SEO in fix steps for WordPress sites', () => {
    const fixes = generateFixes([robotsBlocked('GPTBot')], { ...EMPTY_STACK, cms: 'WordPress' });
    const fix = fixes.find((f) => f.issue.toLowerCase().includes('robots'))!;
    const steps = fix.fix_steps.join(' ');
    expect(steps.toLowerCase()).toMatch(/yoast/);
  });
});

describe('generateFixes — HTTP refusals (undeterminable)', () => {
  it('generates a fix for HTTP 403 refusals', () => {
    const fixes = generateFixes([httpRefused('GPTBot', 403, null)], EMPTY_STACK);
    expect(fixes.some((f) => f.issue.includes('403'))).toBe(true);
  });

  it('keeps the fix copy tentative — never claims the real crawler is blocked', () => {
    const fixes = generateFixes([httpRefused('GPTBot', 403, null)], EMPTY_STACK);
    const fix = fixes.find((f) => f.issue.includes('403'))!;
    expect(fix.issue.toLowerCase()).toMatch(/undeterminable/);
    expect(fix.fix_summary.toLowerCase()).toMatch(/cannot determine/);
  });

  it('caps priority at high (not critical) even for critical bots', () => {
    const fixes = generateFixes([httpRefused('GPTBot', 403, null)], EMPTY_STACK);
    const fix = fixes.find((f) => f.issue.includes('403'))!;
    expect(fix.priority).toBe('high');
  });

  it('uses medium priority when only non-critical bots are refused', () => {
    const fixes = generateFixes([httpRefused('Amazonbot', 403, null)], EMPTY_STACK);
    const fix = fixes.find((f) => f.issue.includes('403'))!;
    expect(fix.priority).toBe('medium');
  });

  it('generates Cloudflare-specific steps when Cloudflare WAF detected in stack', () => {
    const fixes = generateFixes([httpRefused('GPTBot', 403, 'Cloudflare')], { ...EMPTY_STACK, waf: 'Cloudflare' });
    const fix = fixes.find((f) => f.issue.includes('403'))!;
    const steps = fix.fix_steps.join(' ').toLowerCase();
    expect(steps).toMatch(/cloudflare/);
    expect(steps).toMatch(/waf|security|dashboard/);
  });

  it('generates Wordfence-specific steps when Wordfence WAF detected', () => {
    const fixes = generateFixes([httpRefused('GPTBot', 403, 'Wordfence')], { ...EMPTY_STACK, waf: 'Wordfence' });
    const fix = fixes.find((f) => f.issue.includes('403'))!;
    const steps = fix.fix_steps.join(' ').toLowerCase();
    expect(steps).toMatch(/wordfence/);
  });

  it('generates generic steps and null fix_platform when WAF is unknown', () => {
    const fixes = generateFixes([httpRefused('GPTBot', 403, null)], EMPTY_STACK);
    const fix = fixes.find((f) => f.issue.includes('403'))!;
    expect(fix.fix_steps.length).toBeGreaterThan(0);
    expect(fix.fix_platform).toBeNull();
  });
});

describe('generateFixes — interstitial bodies are not trusted', () => {
  it('does not raise a meta-tag fix when the meta came from a challenged response', () => {
    const r = jsChallenged('GPTBot');
    r.tests.meta_tags = { robots_directive: 'noindex,nofollow', ai_blocking_directives: [], canonical: null, status: 'blocked_via_meta' };
    const fixes = generateFixes([r], EMPTY_STACK);
    expect(fixes.some((f) => f.issue.toLowerCase().includes('meta'))).toBe(false);
  });

  it('does not raise a cloaking fix when the bot body was a refusal page', () => {
    const r = httpRefused('GPTBot', 403, 'Cloudflare');
    r.tests.cloaking = { divergence_pct: 0.9, status: 'potential_cloaking' };
    const fixes = generateFixes([r], EMPTY_STACK);
    expect(fixes.some((f) => f.issue.toLowerCase().includes('cloaking'))).toBe(false);
  });
});

describe('generateFixes — JS challenge', () => {
  it('generates a JS challenge fix', () => {
    const fixes = generateFixes([jsChallenged('GPTBot')], EMPTY_STACK);
    expect(fixes.some((f) => f.issue.toLowerCase().includes('challenge'))).toBe(true);
  });

  it('generates Cloudflare-specific steps when Cloudflare CDN is detected', () => {
    const fixes = generateFixes([jsChallenged('GPTBot')], { ...EMPTY_STACK, cdn: 'Cloudflare' });
    const fix = fixes.find((f) => f.issue.toLowerCase().includes('challenge'))!;
    const steps = fix.fix_steps.join(' ').toLowerCase();
    expect(steps).toMatch(/bot fight mode|verified bots/);
  });

  it('generates Cloudflare-specific steps when Cloudflare WAF is detected', () => {
    const fixes = generateFixes([jsChallenged('GPTBot')], { ...EMPTY_STACK, waf: 'Cloudflare' });
    const fix = fixes.find((f) => f.issue.toLowerCase().includes('challenge'))!;
    const steps = fix.fix_steps.join(' ').toLowerCase();
    expect(steps).toMatch(/cloudflare/);
  });

  it('generates generic steps when no CDN or WAF is detected', () => {
    const fixes = generateFixes([jsChallenged('GPTBot')], EMPTY_STACK);
    const fix = fixes.find((f) => f.issue.toLowerCase().includes('challenge'))!;
    expect(fix.fix_steps.length).toBeGreaterThan(0);
  });
});

describe('generateFixes — meta tag blocking', () => {
  it('generates a meta tag fix', () => {
    const fixes = generateFixes([metaBlocked('GPTBot')], EMPTY_STACK);
    expect(fixes.some((f) => f.issue.toLowerCase().includes('meta'))).toBe(true);
  });

  it('mentions Yoast SEO in steps for WordPress sites', () => {
    const fixes = generateFixes([metaBlocked('GPTBot')], { ...EMPTY_STACK, cms: 'WordPress' });
    const fix = fixes.find((f) => f.issue.toLowerCase().includes('meta'))!;
    expect(fix.fix_steps.join(' ').toLowerCase()).toMatch(/yoast/);
  });
});

describe('generateFixes — priority ordering', () => {
  it('returns fixes sorted critical → high → medium → low', () => {
    const results = [
      robotsBlocked('GPTBot'),       // critical priority
      cloakingPartial('Amazonbot'),  // medium priority
      serverError('ClaudeBot'),      // high (critical bot in server error)
    ];
    const fixes = generateFixes(results, EMPTY_STACK);
    const ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    for (let i = 1; i < fixes.length; i++) {
      expect(ORDER[fixes[i].priority]).toBeGreaterThanOrEqual(ORDER[fixes[i - 1].priority]);
    }
  });

  it('generates multiple distinct fixes for multiple blocker types', () => {
    const results = [
      robotsBlocked('GPTBot'),
      jsChallenged('ClaudeBot'),
      cloakingPartial('Amazonbot'),
    ];
    const fixes = generateFixes(results, EMPTY_STACK);
    expect(fixes.length).toBeGreaterThanOrEqual(3);
  });

  it('produces no fixes when all crawlers are accessible', () => {
    const result: CrawlerResult = {
      crawler_name: 'GPTBot', user_agent: 'Test/1.0',
      overall_status: 'accessible', blocker_layer: 'none', blocker_detail: '',
      tests: baseFetch(),
    };
    expect(generateFixes([result], EMPTY_STACK)).toHaveLength(0);
  });
});

describe('generateFixes — CSR and cloaking', () => {
  it('generates a CSR fix for client-side rendered pages', () => {
    const fixes = generateFixes([csrPartial('GPTBot')], EMPTY_STACK);
    expect(fixes.some((f) => f.issue.toLowerCase().includes('client-side'))).toBe(true);
  });

  it('generates a cloaking fix when content divergence is detected', () => {
    const fixes = generateFixes([cloakingPartial('GPTBot')], EMPTY_STACK);
    expect(fixes.some((f) => f.issue.toLowerCase().includes('cloaking'))).toBe(true);
  });

  it('cloaking fix is always medium priority regardless of crawler tier', () => {
    const fixes = generateFixes([cloakingPartial('GPTBot')], EMPTY_STACK);
    const fix = fixes.find((f) => f.issue.toLowerCase().includes('cloaking'))!;
    expect(fix.priority).toBe('medium');
  });
});

describe('generateFixes — server errors', () => {
  it('generates a server error fix', () => {
    const fixes = generateFixes([serverError('GPTBot')], EMPTY_STACK);
    expect(fixes.some((f) => f.issue.toLowerCase().includes('error') || f.issue.toLowerCase().includes('timeout'))).toBe(true);
  });

  it('marks server error fix critical when a critical bot is affected', () => {
    const fixes = generateFixes([serverError('GPTBot')], EMPTY_STACK);
    const fix = fixes.find((f) => f.issue.toLowerCase().includes('error') || f.issue.toLowerCase().includes('timeout'))!;
    expect(fix.priority).toBe('critical');
  });
});
