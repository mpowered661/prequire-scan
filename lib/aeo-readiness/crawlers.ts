import type { CrawlerDefinition, CrawlerTier } from './types';

// Fixed, versioned crawler registry. Bump the version whenever an entry is
// added, removed, or its check_type/purpose changes — stored reports stamp this
// value so a result can always say which registry produced it.
// v2026-08 (per scanner-audit-addendum-2026-08-06):
//   - removed Claude-Web (deprecated; Anthropic's current crawlers are
//     ClaudeBot, Claude-User, Claude-SearchBot)
//   - added Claude-SearchBot and Claude-User
//   - Applebot-Extended corrected to robots_only (Apple documents it does not
//     crawl — it is a robots.txt token, same class as Google-Extended)
//   - every entry carries a purpose (training / search_index / user_fetch / seo)
export const REGISTRY_VERSION = '2026-08';

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export const PREQUIRE_SUFFIX = ' Prequire-AEO-Check/1.0';

export const CRAWLERS: CrawlerDefinition[] = [
  {
    name: 'GPTBot',
    user_agent:
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)',
    tier: 'critical',
    purpose: 'training',
  },
  {
    name: 'ChatGPT-User',
    user_agent:
      'Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/bot)',
    tier: 'important',
    purpose: 'user_fetch',
  },
  {
    name: 'OAI-SearchBot',
    user_agent:
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)',
    tier: 'important',
    purpose: 'search_index',
  },
  {
    name: 'ClaudeBot',
    user_agent:
      'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
    tier: 'critical',
    purpose: 'training',
  },
  {
    // Indexes content for Claude's search results. The robots.txt token
    // ('Claude-SearchBot') is the load-bearing identifier; the UA string
    // mirrors Anthropic's documented ClaudeBot format.
    name: 'Claude-SearchBot',
    user_agent:
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-SearchBot/1.0; +Claude-SearchBot@anthropic.com)',
    tier: 'important',
    purpose: 'search_index',
  },
  {
    // Fetches pages when a Claude user asks about a site.
    name: 'Claude-User',
    user_agent:
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)',
    tier: 'important',
    purpose: 'user_fetch',
  },
  {
    name: 'PerplexityBot',
    user_agent:
      'Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)',
    tier: 'critical',
    purpose: 'search_index',
  },
  {
    name: 'Perplexity-User',
    user_agent:
      'Mozilla/5.0 (compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)',
    tier: 'other',
    purpose: 'user_fetch',
  },
  {
    // Google-Extended is a robots.txt directive token, not a fetching crawler.
    // It must never be probed over HTTP (previously it was fetched with a
    // Googlebot UA, which sites treat as impersonation).
    name: 'Google-Extended',
    user_agent: 'robots.txt token (not fetched)',
    tier: 'critical',
    purpose: 'training',
    check_type: 'robots_only',
  },
  {
    // Applebot-Extended does not crawl webpages (per Apple's documentation) —
    // it is a robots.txt token governing whether Applebot-crawled data may be
    // used for AI training. Same class as Google-Extended: never HTTP-probed.
    name: 'Applebot-Extended',
    user_agent: 'robots.txt token (not fetched)',
    tier: 'important',
    purpose: 'training',
    check_type: 'robots_only',
  },
  {
    name: 'CCBot',
    user_agent: 'CCBot/2.0 (https://commoncrawl.org/faq/)',
    tier: 'other',
    purpose: 'training',
  },
  {
    name: 'Bytespider',
    user_agent:
      'Mozilla/5.0 (compatible; Bytespider; spider-feedback@bytedance.com)',
    tier: 'important',
    purpose: 'training',
  },
  {
    name: 'Meta-ExternalAgent',
    user_agent:
      'Meta-ExternalAgent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)',
    tier: 'other',
    purpose: 'training',
  },
  {
    name: 'Amazonbot',
    user_agent:
      'Mozilla/5.0 (compatible; Amazonbot/0.1; +developer.amazon.com/support/amazonbot)',
    tier: 'other',
    purpose: 'search_index',
  },
  {
    name: 'Googlebot',
    user_agent:
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    tier: 'seo',
    purpose: 'seo',
  },
  {
    name: 'Bingbot',
    user_agent:
      'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingcrawler.html)',
    tier: 'seo',
    purpose: 'seo',
  },
];

export const TIER_ORDER: CrawlerTier[] = ['critical', 'important', 'other', 'seo'];

export function getCrawlersByTier(tier: CrawlerTier): CrawlerDefinition[] {
  return CRAWLERS.filter((c) => c.tier === tier);
}

export function getActiveCrawlers(includeSeo: boolean): CrawlerDefinition[] {
  if (includeSeo) return CRAWLERS;
  return CRAWLERS.filter((c) => c.tier !== 'seo');
}
