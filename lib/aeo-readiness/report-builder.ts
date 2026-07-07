import type {
  AeoReadinessReport,
  CrawlerResult,
  CrawlerTests,
  HttpResponseResult,
  HttpResponseStatus,
  OverallStatus,
  BlockerLayer,
  LlmsTxt,
  ReportSummary,
  RawCrawlerFetch,
} from './types';
import { getActiveCrawlers } from './crawlers';
import { runHttpTests } from './http-tester';
import { checkRobotsTxt } from './robots-parser';
import { analyzeContentDelivery, analyzeMetaTags, analyzeCloaking } from './content-analyzer';
import { buildDetectedStack, detectWaf } from './waf-fingerprinter';
import { computeScore } from './scoring';
import { generateFixes } from './fix-library';

async function checkLlmsTxt(url: string): Promise<LlmsTxt> {
  try {
    const base = new URL(url);
    const llmsUrl = `${base.protocol}//${base.host}/llms.txt`;
    const res = await fetch(llmsUrl, {
      method: 'HEAD',
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Prequire-AEO-Check/1.0' },
    });
    if (res.ok) return { present: true, url: llmsUrl };
  } catch { /* ignore */ }
  return { present: false, url: null };
}

// Fetches robots.txt once. Returns the raw content on a clean 200, '' on 404
// (no robots.txt = permissive, per RFC 9309), and null when the response cannot
// be trusted as robots.txt — non-200, an HTML body (challenge interstitial or
// error page), or a network failure. null makes every robots verdict 'error',
// which surfaces as 'undeterminable' rather than a false 'allowed'.
async function fetchRobotsTxtContent(url: string): Promise<string | null> {
  try {
    const base = new URL(url);
    const robotsUrl = `${base.protocol}//${base.host}/robots.txt`;
    const res = await fetch(robotsUrl, {
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'Prequire-AEO-Check/1.0' },
    });
    if (res.status === 404) return '';
    if (res.status !== 200) return null;
    const text = await res.text();
    // Authenticity guard: an HTML body is an interstitial, not robots.txt
    if (/<html|<!doctype/i.test(text.slice(0, 500))) return null;
    return text;
  } catch {
    return null;
  }
}

function buildHttpResponse(
  rawFetch: RawCrawlerFetch,
  jsChallengeDetected: boolean,
): HttpResponseResult {
  const wafDetected = detectWaf(rawFetch.headers, rawFetch.body);

  let status: HttpResponseStatus;
  if (rawFetch.error || rawFetch.status_code === 0) {
    status = 'error';
  } else if (rawFetch.status_code >= 500) {
    status = 'error';
  } else if (jsChallengeDetected) {
    // Challenge pages can arrive with 200, 403, or 503
    status = 'challenged';
  } else if (rawFetch.status_code >= 400) {
    // 403/429/other 4xx: a refusal to this UA simulation — not proof the real,
    // IP-verified crawler is blocked. Verdict becomes 'undeterminable'.
    status = 'refused';
  } else {
    status = 'ok';
  }

  return {
    status_code: rawFetch.status_code,
    response_time_ms: rawFetch.response_time_ms,
    server: rawFetch.headers['server'] ?? null,
    waf_detected: wafDetected,
    status,
  };
}

function determineOverallStatus(tests: CrawlerTests): {
  overall_status: OverallStatus;
  blocker_layer: BlockerLayer;
  blocker_detail: string;
} {
  if (tests.robots_txt.status === 'disallowed') {
    return {
      overall_status: 'blocked',
      blocker_layer: 'robots_txt',
      blocker_detail: tests.robots_txt.matched_rule ?? 'Disallowed by robots.txt',
    };
  }

  if (tests.http_response.status === 'refused') {
    const waf = tests.http_response.waf_detected;
    return {
      overall_status: 'undeterminable',
      blocker_layer: waf ? 'waf' : 'unknown',
      blocker_detail: `HTTP ${tests.http_response.status_code} refusal — undeterminable via UA simulation${
        waf
          ? ` (consistent with ${waf} filtering)`
          : ' (cannot distinguish a real crawler block from anti-impersonation filtering)'
      }`,
    };
  }

  // Challenges are checked before meta tags: the meta tags of a challenge page
  // belong to the challenge interstitial, not to the site.
  if (tests.http_response.status === 'challenged') {
    const waf = tests.http_response.waf_detected;
    return {
      overall_status: 'undeterminable',
      blocker_layer: waf ? 'waf' : 'cdn',
      blocker_detail: `Browser challenge — undeterminable via UA simulation${
        waf ? ` (consistent with a ${waf} challenge)` : ''
      }`,
    };
  }

  if (tests.content_delivery.status === 'js_challenge') {
    return {
      overall_status: 'undeterminable',
      blocker_layer: 'cdn',
      blocker_detail: `JavaScript challenge in page body (${tests.content_delivery.challenge_indicators.slice(0, 2).join(', ')}) — undeterminable via UA simulation`,
    };
  }

  if (tests.meta_tags.status === 'blocked_via_meta') {
    return {
      overall_status: 'blocked',
      blocker_layer: 'meta_tags',
      blocker_detail: `Meta robots: ${tests.meta_tags.robots_directive ?? 'blocking directive'}`,
    };
  }

  // Transport failures are checked before the empty-body check: a failed fetch
  // also has an empty body, but "Connection error or timeout" is the truthful detail.
  if (tests.http_response.status === 'error') {
    return {
      overall_status: 'blocked',
      blocker_layer: 'server_error',
      blocker_detail: 'Connection error or timeout',
    };
  }

  if (tests.content_delivery.status === 'empty') {
    return {
      overall_status: 'blocked',
      blocker_layer: 'server_error',
      blocker_detail: 'Empty response body',
    };
  }

  // robots.txt unreadable or inauthentic: permission cannot be verified, so no
  // stronger claim than 'undeterminable' is defensible for this crawler.
  if (tests.robots_txt.status === 'error') {
    return {
      overall_status: 'undeterminable',
      blocker_layer: 'unknown',
      blocker_detail: 'robots.txt could not be verified — permission status undeterminable',
    };
  }

  if (tests.content_delivery.status === 'client_side_rendered') {
    return {
      overall_status: 'partial',
      blocker_layer: 'client_render',
      blocker_detail: `Low text/HTML ratio (${tests.content_delivery.text_html_ratio})`,
    };
  }

  if (tests.cloaking.status === 'potential_cloaking') {
    return {
      overall_status: 'partial',
      blocker_layer: 'none',
      blocker_detail: `Content divergence ${Math.round(tests.cloaking.divergence_pct * 100)}% vs browser`,
    };
  }

  return {
    overall_status: 'accessible',
    blocker_layer: 'none',
    blocker_detail: 'No blockers detected',
  };
}

function getPrimaryBlocker(results: CrawlerResult[]): string | null {
  const counts = new Map<string, number>();
  for (const r of results) {
    if (r.blocker_layer !== 'none') {
      counts.set(r.blocker_layer, (counts.get(r.blocker_layer) ?? 0) + 1);
    }
  }
  let maxCount = 0;
  let primary: string | null = null;
  for (const [layer, count] of counts) {
    if (count > maxCount) {
      maxCount = count;
      primary = layer;
    }
  }
  return primary;
}

export async function buildReport(
  url: string,
  options: { include_seo_bots?: boolean } = {},
): Promise<AeoReadinessReport> {
  const { include_seo_bots = false } = options;
  const testedAt = new Date().toISOString();
  const activeCrawlers = getActiveCrawlers(include_seo_bots);

  // All network work in parallel: HTTP tests for all bots, llms.txt, robots.txt
  const [httpResults, llmsTxt, robotsContent] = await Promise.all([
    runHttpTests(url, { include_seo_bots }),
    checkLlmsTxt(url),
    fetchRobotsTxtContent(url),
  ]);

  const { crawler_fetches, browser_fetch } = httpResults;

  // Per-crawler analysis runs in parallel across all bots
  const fetchedResults: CrawlerResult[] = await Promise.all(
    crawler_fetches.map(async (rawFetch) => {
      const crawler = activeCrawlers.find((c) => c.name === rawFetch.crawler_name)!;
      const { result: robotsTxt } = await checkRobotsTxt(url, rawFetch.crawler_name, robotsContent);
      const contentDelivery = analyzeContentDelivery(rawFetch.body);
      const httpResponse = buildHttpResponse(rawFetch, contentDelivery.js_challenge_detected);
      const metaTags = analyzeMetaTags(rawFetch.body, rawFetch.crawler_name);
      const cloaking = analyzeCloaking(rawFetch.body, browser_fetch.body);

      const tests: CrawlerTests = {
        robots_txt: robotsTxt,
        http_response: httpResponse,
        content_delivery: contentDelivery,
        meta_tags: metaTags,
        cloaking,
      };

      const { overall_status, blocker_layer, blocker_detail } = determineOverallStatus(tests);

      return {
        crawler_name: rawFetch.crawler_name,
        user_agent: crawler.user_agent,
        tests,
        overall_status,
        blocker_layer,
        blocker_detail,
      };
    }),
  );

  // robots_only crawlers (Google-Extended) are never fetched — their verdict comes
  // from the robots.txt token check alone; every other test is not applicable.
  const robotsOnlyResults: CrawlerResult[] = await Promise.all(
    activeCrawlers
      .filter((c) => c.check_type === 'robots_only')
      .map(async (crawler) => {
        const { result: robotsTxt } = await checkRobotsTxt(url, crawler.name, robotsContent);
        const tests: CrawlerTests = {
          robots_txt: robotsTxt,
          http_response: { status_code: 0, response_time_ms: 0, server: null, waf_detected: null, status: 'not_applicable' },
          content_delivery: { html_bytes: 0, text_bytes: 0, text_html_ratio: 0, js_challenge_detected: false, challenge_indicators: [], content_appears_rendered: false, status: 'not_applicable' },
          meta_tags: { robots_directive: null, ai_blocking_directives: [], canonical: null, status: 'not_applicable' },
          cloaking: { divergence_pct: 0, status: 'not_applicable' },
        };
        if (robotsTxt.status === 'disallowed') {
          return {
            crawler_name: crawler.name, user_agent: crawler.user_agent, tests,
            overall_status: 'blocked' as const, blocker_layer: 'robots_txt' as const,
            blocker_detail: robotsTxt.matched_rule ?? 'Disallowed by robots.txt',
          };
        }
        if (robotsTxt.status === 'error') {
          return {
            crawler_name: crawler.name, user_agent: crawler.user_agent, tests,
            overall_status: 'undeterminable' as const, blocker_layer: 'unknown' as const,
            blocker_detail: 'robots.txt could not be verified — token status undeterminable',
          };
        }
        return {
          crawler_name: crawler.name, user_agent: crawler.user_agent, tests,
          overall_status: 'accessible' as const, blocker_layer: 'none' as const,
          blocker_detail: 'Permitted by robots.txt (directive token — robots-only check)',
        };
      }),
  );

  // Present results in the canonical crawler order
  const orderIndex = new Map(activeCrawlers.map((c, i) => [c.name, i]));
  const crawlerResults: CrawlerResult[] = [...fetchedResults, ...robotsOnlyResults].sort(
    (a, b) => (orderIndex.get(a.crawler_name) ?? 99) - (orderIndex.get(b.crawler_name) ?? 99),
  );

  const detectedStack = buildDetectedStack(browser_fetch.headers, browser_fetch.body);
  const score = computeScore(crawlerResults, activeCrawlers);
  const fixes = generateFixes(crawlerResults, detectedStack);

  const summary: ReportSummary = {
    total_crawlers_tested: crawlerResults.length,
    accessible: crawlerResults.filter((r) => r.overall_status === 'accessible').length,
    partial: crawlerResults.filter((r) => r.overall_status === 'partial').length,
    blocked: crawlerResults.filter((r) => r.overall_status === 'blocked').length,
    undeterminable: crawlerResults.filter((r) => r.overall_status === 'undeterminable').length,
    primary_blocker: getPrimaryBlocker(crawlerResults),
  };

  return {
    url,
    tested_at: testedAt,
    aeo_readiness_score: score,
    summary,
    crawler_results: crawlerResults,
    detected_stack: detectedStack,
    fixes,
    llms_txt: llmsTxt,
  };
}
