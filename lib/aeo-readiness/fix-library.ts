import type { CrawlerResult, Fix, DetectedStack, FixPriority } from './types';

const CRITICAL_BOTS = new Set(['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended']);

function hasCritical(names: string[]): boolean {
  return names.some((n) => CRITICAL_BOTS.has(n));
}

function topPriority(names: string[], fallback: FixPriority = 'high'): FixPriority {
  return hasCritical(names) ? 'critical' : fallback;
}

function crawlerNames(results: CrawlerResult[]): string[] {
  return results.map((r) => r.crawler_name);
}

export function generateFixes(results: CrawlerResult[], stack: DetectedStack): Fix[] {
  const fixes: Fix[] = [];

  // 1. robots.txt blocking
  const robotsBlocked = results.filter((r) => r.tests.robots_txt.status === 'disallowed');
  if (robotsBlocked.length > 0) {
    const affected = crawlerNames(robotsBlocked);
    fixes.push({
      priority: topPriority(affected),
      issue: 'AI crawlers blocked by robots.txt',
      affected_crawlers: affected,
      fix_summary: `Your robots.txt is blocking ${affected.length} AI crawler${affected.length > 1 ? 's' : ''}. These bots cannot read your content and AI engines will not cite you.`,
      fix_steps: [
        'Open your robots.txt file (yourdomain.com/robots.txt)',
        'Locate any Disallow rules that apply to these bots or a wildcard (*) Disallow: / rule',
        'Add an explicit Allow block for each affected bot, placed before any wildcard rule',
        'Example — User-agent: GPTBot  then on the next line  Allow: /',
        stack.cms === 'WordPress'
          ? 'In WordPress, edit via Yoast SEO → Tools → File Editor, or use the WPCode plugin'
          : 'Save the file and verify the change is live at yourdomain.com/robots.txt',
        'Re-run this check to confirm the crawlers are now allowed',
      ],
      fix_platform: stack.cms === 'WordPress' ? 'WordPress / Yoast SEO' : null,
    });
  }

  // 2. Hard HTTP blocks (403 / 429) — robots.txt is not the primary cause
  const httpBlocked = results.filter(
    (r) =>
      r.tests.http_response.status === 'blocked' &&
      r.tests.robots_txt.status !== 'disallowed',
  );
  if (httpBlocked.length > 0) {
    const affected = crawlerNames(httpBlocked);
    const statusCode = httpBlocked[0].tests.http_response.status_code;
    const waf = stack.waf ?? httpBlocked[0].tests.http_response.waf_detected ?? 'your firewall';
    fixes.push({
      priority: topPriority(affected),
      issue: `HTTP ${statusCode} response blocking AI crawlers`,
      affected_crawlers: affected,
      fix_summary: `${waf} is returning HTTP ${statusCode} to ${affected.length} AI crawler${affected.length > 1 ? 's' : ''}. This is a hard block — these bots receive no content from your site.`,
      fix_steps:
        stack.waf === 'Cloudflare'
          ? [
              'Log in to the Cloudflare dashboard → Security → WAF',
              'Create a Custom Rule: Field = User Agent, Operator = contains, add each bot name',
              'Set the rule action to: Skip → WAF managed rules',
              'Or go to Bots → Bot Fight Mode and enable "Allow Verified Bots"',
              'Re-run this check to confirm bots are no longer blocked',
            ]
          : stack.waf === 'Wordfence'
          ? [
              'In WordPress, go to Wordfence → All Options → Rate Limiting',
              'Add the affected bot User-Agent strings to the Allowlist',
              'Or go to Wordfence → Firewall → Allowlisted IPs for known bot IP ranges',
              'Re-run this check to confirm bots are no longer blocked',
            ]
          : [
              `Locate where ${waf} is configured to block bot traffic`,
              'Add exceptions for the affected crawler User-Agent strings',
              'Consult your WAF or security plugin documentation for bot allowlist configuration',
              'Re-run this check to confirm bots are no longer blocked',
            ],
      fix_platform: stack.waf,
    });
  }

  // 3. JavaScript browser challenge
  const jsChallenged = results.filter(
    (r) =>
      (r.tests.http_response.status === 'challenged' ||
        r.tests.content_delivery.js_challenge_detected) &&
      r.tests.http_response.status !== 'blocked' &&
      r.tests.robots_txt.status !== 'disallowed',
  );
  if (jsChallenged.length > 0) {
    const affected = crawlerNames(jsChallenged);
    fixes.push({
      priority: topPriority(affected, 'high'),
      issue: 'JavaScript browser challenge served to AI crawlers',
      affected_crawlers: affected,
      fix_summary:
        'AI crawlers are receiving a browser-verification challenge page. These bots cannot execute JavaScript and will never pass the challenge — your content is invisible to them.',
      fix_steps:
        stack.waf === 'Cloudflare' || stack.cdn === 'Cloudflare'
          ? [
              'Go to Cloudflare dashboard → Security → Bots',
              'Enable Bot Fight Mode with "Allow Verified Bots" turned on',
              'Or go to Security → WAF → Create Rule',
              'Set: User Agent contains GPTBot → Action: Bypass → Browser Integrity Check',
              'Repeat for ClaudeBot, PerplexityBot, and other affected bots',
              'Re-run this check to confirm bots receive real page content',
            ]
          : [
              'Identify what is serving the browser challenge (CDN, security plugin, or hosting)',
              'Add exemptions for AI crawler User-Agent strings in your challenge rules',
              'Verified AI crawlers like GPTBot and ClaudeBot should bypass JS challenges',
              'Re-run this check to confirm bots receive real page content',
            ],
      fix_platform: stack.waf ?? stack.cdn,
    });
  }

  // 4. Meta tag blocking
  const metaBlocked = results.filter(
    (r) =>
      r.tests.meta_tags.status === 'blocked_via_meta' &&
      r.tests.robots_txt.status !== 'disallowed' &&
      r.tests.http_response.status !== 'blocked',
  );
  if (metaBlocked.length > 0) {
    const affected = crawlerNames(metaBlocked);
    const directive = metaBlocked[0].tests.meta_tags.robots_directive ?? 'noindex or noai';
    fixes.push({
      priority: topPriority(affected),
      issue: 'AI crawlers blocked by meta robots tag',
      affected_crawlers: affected,
      fix_summary: `Your page contains a meta robots tag (${directive}) that signals AI crawlers not to index or use this content.`,
      fix_steps: [
        "Find the <meta name=\"robots\"> tag in your page's <head> section",
        'Remove or replace directives such as "noindex", "none", "noai", or "nofollow"',
        'The correct tag for full AI crawler access is: <meta name="robots" content="index, follow">',
        stack.cms === 'WordPress'
          ? 'In WordPress, check the Yoast SEO → Advanced tab in the page editor for noindex settings'
          : 'Check any SEO plugins or CMS settings that may be injecting this meta tag',
        'Re-run this check to confirm the tag is no longer blocking crawlers',
      ],
      fix_platform: stack.cms === 'WordPress' ? 'WordPress / Yoast SEO' : null,
    });
  }

  // 5. Client-side rendering
  const csrPartial = results.filter(
    (r) =>
      r.tests.content_delivery.status === 'client_side_rendered' &&
      r.overall_status !== 'blocked',
  );
  if (csrPartial.length > 0) {
    const affected = crawlerNames(csrPartial);
    fixes.push({
      priority: topPriority(affected, 'medium'),
      issue: 'Content not accessible — page appears client-side rendered',
      affected_crawlers: affected,
      fix_summary:
        'The HTML returned to crawlers contains very little text. Your page likely relies on JavaScript to render content, which AI crawlers cannot execute.',
      fix_steps: [
        'Verify what your server sends to a bot User-Agent: curl -A "GPTBot/1.2" yourdomain.com',
        'Switch to server-side rendering (SSR) or static generation (SSG) for content pages',
        'If using Next.js or Nuxt.js: use getServerSideProps or getStaticProps to pre-render content',
        'If using a SPA: add a prerendering service (Prerender.io, Rendertron) as middleware',
        'Ensure the HTML response includes headings, body copy, and structured data',
        'Re-run this check after SSR or prerendering is deployed',
      ],
      fix_platform: stack.cms,
    });
  }

  // 6. Potential cloaking
  const cloakingPartial = results.filter(
    (r) => r.tests.cloaking.status === 'potential_cloaking',
  );
  if (cloakingPartial.length > 0) {
    const affected = crawlerNames(cloakingPartial);
    fixes.push({
      priority: 'medium',
      issue: 'Potential content cloaking detected',
      affected_crawlers: affected,
      fix_summary:
        'The content served to AI crawlers differs significantly from what a browser receives. AI engines may be indexing an incomplete or misleading version of your page.',
      fix_steps: [
        'Review server-side logic that varies page output based on User-Agent',
        'Check middleware for bot detection that strips or modifies content for non-browser requests',
        'Ensure personalization, geo-targeting, or A/B tests do not alter core content for crawlers',
        "Test by fetching your page with curl -A '<bot-ua>' and comparing the output to a browser view",
        'Re-run this check after eliminating content divergence',
      ],
      fix_platform: null,
    });
  }

  // 7. Server errors / timeouts
  const serverErrors = results.filter(
    (r) =>
      r.tests.http_response.status === 'error' &&
      r.tests.robots_txt.status !== 'disallowed',
  );
  if (serverErrors.length > 0) {
    const affected = crawlerNames(serverErrors);
    fixes.push({
      priority: topPriority(affected, 'high'),
      issue: 'Connection errors or timeouts for AI crawlers',
      affected_crawlers: affected,
      fix_summary: `${affected.length} AI crawler${affected.length > 1 ? 's' : ''} received connection errors or timeouts. Your server may be blocking or throttling these requests at the network level.`,
      fix_steps: [
        'Check your server error logs around the time of this scan',
        'Test directly: curl -A "GPTBot/1.2" https://yourdomain.com and observe the response',
        'Verify your hosting or CDN is not rate-limiting or dropping bot User-Agent traffic',
        'If using Cloudflare, check Security Events for blocked requests from these crawlers',
        'Ensure your server handles concurrent requests without timing out under crawler load',
        'Re-run this check to confirm crawlers receive a valid response',
      ],
      fix_platform: stack.waf ?? stack.cdn,
    });
  }

  const PRIORITY_ORDER: Record<FixPriority, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };
  fixes.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);

  return fixes;
}
