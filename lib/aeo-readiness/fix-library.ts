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

const SIMULATION_LIMIT =
  'Simulated requests use crawler user-agents, not verified crawler IP addresses, so they cannot show how your security treats the real crawlers.';

// Evidence first, then the narrowest change. Never a User-Agent-only exception:
// anyone can send a crawler's user-agent, so such a rule weakens protection for
// every impersonator. Re-running this check cannot confirm a fix — our simulated
// requests are not verified crawlers — so confirmation comes from security logs.
export function verifiedTrafficSteps(provider: string | null): string[] {
  const noUaRule =
    'Do not add rules that skip, bypass, or allowlist security based on the User-Agent alone — a user-agent can be faked by anyone';
  const confirm =
    'Confirm any change in your security logs (real crawler requests now allowed). Re-running this check will not confirm it, because our simulated requests are not verified crawlers';
  const intentional =
    'If you block AI crawlers on purpose, that is a business decision, not a defect — leave it in place';

  if (provider === 'Cloudflare') {
    return [
      'In the Cloudflare dashboard, open Security → Events and filter for the affected crawlers to see how their real requests were handled',
      'Look for requests Cloudflare identifies as verified bots (confirmed by IP address, not by the name a request claims). Requests that only claim a crawler name are not evidence about the real crawler',
      'Only if verified crawler requests are being challenged or blocked: review your bot settings and allow verified bots (for example the "Allow verified bots" option where your plan offers it)',
      intentional,
      noUaRule,
      confirm,
    ];
  }
  if (provider === 'Wordfence') {
    return [
      'In WordPress, open Wordfence → Tools → Live Traffic and filter for the affected crawlers to see whether their requests were blocked',
      'Check that a blocked request really came from the crawler, using the operator\'s published IP ranges or verification method where available',
      'Only if verified crawler requests are blocked: add an exception for the operator\'s published IP ranges',
      intentional,
      noUaRule,
      confirm,
    ];
  }
  if (provider === 'Sucuri') {
    return [
      'In the Sucuri WAF dashboard (https://waf.sucuri.net), review the blocked-request logs for the affected crawlers',
      'Check that a blocked request really came from the crawler, using the operator\'s published IP ranges (for example openai.com/gptbot for GPTBot)',
      'Only if verified crawler requests are blocked: add the operator\'s published IP ranges to the IP Allowlist',
      'If you also run the Sucuri WordPress plugin, it keeps a separate allowlist from the cloud WAF — check both',
      intentional,
      noUaRule,
      confirm,
    ];
  }
  return [
    `Open the security or firewall logs for your ${provider ?? 'hosting, CDN, or security plugin'} and filter for the affected crawlers`,
    'Check that a blocked or challenged request really came from the crawler, using the operator\'s published IP ranges or verification method where available',
    'Only if verified crawler requests are blocked: use your provider\'s verified-bot setting or an exception for the operator\'s published IP ranges',
    intentional,
    noUaRule,
    confirm,
  ];
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

  // 2. HTTP refusals (403 / 429 / other 4xx) — undeterminable via UA simulation.
  // The refusal is observed; whether real, IP-verified crawlers are also refused
  // cannot be determined from this check, so the copy stays tentative.
  const httpRefused = results.filter(
    (r) =>
      r.tests.http_response.status === 'refused' &&
      r.tests.robots_txt.status !== 'disallowed',
  );
  if (httpRefused.length > 0) {
    const affected = crawlerNames(httpRefused);
    const statusCode = httpRefused[0].tests.http_response.status_code;
    const waf = stack.waf ?? httpRefused[0].tests.http_response.waf_detected;
    const wafPhrase = waf ? `Traffic filtering consistent with ${waf}` : 'Traffic filtering on your site';
    fixes.push({
      priority: hasCritical(affected) ? 'high' : 'medium',
      issue: `HTTP ${statusCode} refusals to AI crawler user-agents (undeterminable)`,
      affected_crawlers: affected,
      fix_summary: `${wafPhrase} returned HTTP ${statusCode} to ${affected.length} AI crawler user-agent simulation${affected.length > 1 ? 's' : ''}. This check cannot present verified crawler IP addresses, so it cannot determine whether the real crawlers are blocked — sites that verify crawler IPs may be filtering only impersonators. ${SIMULATION_LIMIT} Check how your firewall handled the real crawlers before changing anything.`,
      fix_steps: verifiedTrafficSteps(stack.waf),
      fix_platform: stack.waf,
    });
  }

  // 3. JavaScript browser challenge — also undeterminable for real crawlers:
  // providers with verified-bots programs may exempt the real crawler from the
  // challenge that our simulation received.
  const jsChallenged = results.filter(
    (r) =>
      (r.tests.http_response.status === 'challenged' ||
        r.tests.content_delivery.js_challenge_detected) &&
      r.tests.http_response.status !== 'refused' &&
      r.tests.robots_txt.status !== 'disallowed',
  );
  if (jsChallenged.length > 0) {
    const affected = crawlerNames(jsChallenged);
    fixes.push({
      priority: hasCritical(affected) ? 'high' : 'medium',
      issue: 'Browser challenge served to AI crawler user-agents (undeterminable)',
      affected_crawlers: affected,
      fix_summary:
        `AI crawler user-agent simulations received a browser-verification challenge page. Whether real, IP-verified crawlers receive the same challenge is undeterminable from this check — many bot-protection services let verified crawlers through while challenging requests that only claim a crawler's name. ${SIMULATION_LIMIT} Check how the real crawlers were handled before changing anything.`,
      fix_steps: verifiedTrafficSteps(
        stack.waf === 'Cloudflare' || stack.cdn === 'Cloudflare' ? 'Cloudflare' : stack.waf ?? stack.cdn,
      ),
      fix_platform: stack.waf ?? stack.cdn,
    });
  }

  // 4. Meta tag blocking
  const metaBlocked = results.filter(
    (r) =>
      r.tests.meta_tags.status === 'blocked_via_meta' &&
      r.tests.robots_txt.status !== 'disallowed' &&
      // Only trust meta tags from a normally-served page: the meta tags of a
      // challenge or refusal page belong to the interstitial, not the site.
      r.tests.http_response.status === 'ok' &&
      !r.tests.content_delivery.js_challenge_detected,
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
    const sample = csrPartial[0].tests.content_delivery;
    const htmlDesc =
      sample.html_bytes >= 1024
        ? `${Math.round(sample.html_bytes / 1024)} KB`
        : `${sample.html_bytes} bytes`;
    const textDesc =
      sample.text_bytes < 100
        ? `only ${sample.text_bytes} bytes`
        : `only ${Math.round(sample.text_bytes / 1024)} KB`;
    const ratioStr = (sample.text_html_ratio * 100).toFixed(1);

    const genericSteps: string[] = [
      `▸ Next.js App Router: Content pages use Server Components by default — ensure data fetching happens in async server components, not inside client components with useEffect. Remove "use client" from components that hold your main content and move state down to leaf components only.`,
      `▸ Next.js App Router (static): Add export const revalidate = 3600 or use generateStaticParams() + export const dynamic = "force-static" to build pages at deploy time. Bots receive pre-rendered HTML on every request.`,
      `▸ Next.js Pages Router: Replace client-side useEffect data fetching with getServerSideProps (SSR, per request) or getStaticProps (SSG, build time). All content must exist in the returned props — nothing fetched after the page loads.`,
      `▸ React SPA (Vite / Create React App): Add a prerender layer — options: (1) migrate to Next.js for full SSR, (2) add Prerender.io or Rendertron as a CDN middleware that serves rendered HTML to bot User-Agents, (3) for static sites, use react-snap or vite-plugin-prerender to generate HTML at build time.`,
      `▸ Vue / Nuxt: Use Nuxt.js for SSR. In Nuxt 3, useFetch() and useAsyncData() run server-side and content appears in the initial HTML. For fully static output, run nuxt generate and deploy the dist/ directory.`,
    ];

    const wordpressSteps: string[] = [
      `▸ WordPress: Your theme is rendering content via JavaScript. Identify the page builder in use (Elementor, Divi, Beaver Builder) and check if it offers a "server-side rendering" or "static HTML fallback" option in its settings.`,
      `▸ WordPress: For crawlable landing pages and content pages, switch from your JS page builder to the native block editor (Gutenberg). Gutenberg pages serve full HTML with no JavaScript dependency — content is readable by any bot.`,
      `▸ WordPress: Install LiteSpeed Cache or WP Super Cache — both support a bot prerender mode that delivers a cached static HTML snapshot to crawlers while humans receive the full JS experience. Enable "Cache for bots" or equivalent option.`,
    ];

    const platformSteps = stack.cms === 'WordPress' ? wordpressSteps : genericSteps;

    fixes.push({
      priority: topPriority(affected, 'medium'),
      issue: 'Content invisible to AI crawlers — page is client-side rendered',
      affected_crawlers: affected,
      fix_summary: `When a human visits this page, their browser downloads ${htmlDesc} of HTML and then executes JavaScript to load the actual content. AI crawlers do not execute JavaScript — they only read the initial HTML response. Right now they see ${textDesc} of readable text (${ratioStr}% of the page), primarily <script> and <link> tags pointing to JavaScript bundles. Everything humans see after page load — headings, body copy, FAQs, structured data — is invisible to AI engines.`,
      fix_steps: [
        `Verify the problem: curl -sA "GPTBot/1.2" https://yourdomain.com and compare what you see to your browser view. If the output has no <h1>, <p>, or article text in the HTML source, bots are receiving an empty shell.`,
        `Check your ratio: curl -s https://yourdomain.com | wc -c gives total bytes. If the response is mostly <script src="..."> tags with little readable text, that confirms client-side rendering.`,
        ...platformSteps,
        `Interim fix — add JSON-LD structured data: Even a near-empty page can include <script type="application/ld+json"> in the server-rendered <head>. AI crawlers extract JSON-LD schema (Article, Person, Organization, FAQPage) and use it for citations even when the visible body is empty. Use schema.org/Article for content pages, schema.org/Person or Organization for brand pages.`,
        `Interim fix — add a <noscript> block: Place a concise summary of your page's key content inside <noscript>...</noscript> in your HTML template. AI crawlers read noscript content. Include your core value proposition, main topics, and one call to action (under 400 words).`,
        `After deploying SSR: run curl -sA "GPTBot/1.2" https://yourdomain.com and confirm that <h1>, <p> tags, and your main content appear directly in the HTML source — not behind script tags.`,
        'Re-run this AEO check to confirm the fix — the text/HTML ratio should rise above 5% and your score will increase',
      ],
      fix_platform: stack.cms,
    });
  }

  // 6. Potential cloaking
  const cloakingPartial = results.filter(
    (r) =>
      r.tests.cloaking.status === 'potential_cloaking' &&
      // A challenge or refusal body always diverges from the browser view —
      // that is the interstitial, not cloaking.
      r.tests.http_response.status === 'ok' &&
      !r.tests.content_delivery.js_challenge_detected,
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
      // Undeterminable, like refusals: one failed simulated request is not
      // evidence of blocking, so it never outranks a declared block.
      priority: hasCritical(affected) ? 'high' : 'medium',
      issue: 'Server errors or timeouts on simulated crawler requests (undeterminable)',
      affected_crawlers: affected,
      fix_summary: `${affected.length} simulated AI crawler request${affected.length > 1 ? 's' : ''} got a server error or timed out. This can be temporary and is not evidence that the real crawlers are blocked.`,
      fix_steps: [
        'Run this check again later — a temporary server or network error usually clears',
        'If errors recur, check your server error logs around the time of the check',
        'Check your hosting or CDN status and any rate limits applied to crawler traffic',
        'Review your security logs to see whether the real, verified crawlers are receiving errors',
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
