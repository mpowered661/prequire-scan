import type { CrawlerDefinition, CrawlerTier } from './types';

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export const PREQUIRE_SUFFIX = ' Prequire-AEO-Check/1.0';

export const CRAWLERS: CrawlerDefinition[] = [
  {
    name: 'GPTBot',
    user_agent:
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)',
    tier: 'critical',
  },
  {
    name: 'ChatGPT-User',
    user_agent:
      'Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/bot)',
    tier: 'important',
  },
  {
    name: 'OAI-SearchBot',
    user_agent:
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)',
    tier: 'important',
  },
  {
    name: 'ClaudeBot',
    user_agent:
      'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
    tier: 'critical',
  },
  {
    name: 'Claude-Web',
    user_agent:
      'Mozilla/5.0 (compatible; Claude-Web/1.0; +https://anthropic.com/claude-web)',
    tier: 'other',
  },
  {
    name: 'PerplexityBot',
    user_agent:
      'Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)',
    tier: 'critical',
  },
  {
    name: 'Perplexity-User',
    user_agent:
      'Mozilla/5.0 (compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)',
    tier: 'other',
  },
  {
    // Google-Extended is a robots.txt directive token, not a fetching crawler.
    // It must never be probed over HTTP (previously it was fetched with a
    // Googlebot UA, which sites treat as impersonation).
    name: 'Google-Extended',
    user_agent: 'robots.txt token (not fetched)',
    tier: 'critical',
    check_type: 'robots_only',
  },
  {
    name: 'Applebot-Extended',
    user_agent:
      'Mozilla/5.0 (compatible; Applebot-Extended/0.1; +http://www.apple.com/go/applebot)',
    tier: 'important',
  },
  {
    name: 'CCBot',
    user_agent: 'CCBot/2.0 (https://commoncrawl.org/faq/)',
    tier: 'other',
  },
  {
    name: 'Bytespider',
    user_agent:
      'Mozilla/5.0 (compatible; Bytespider; spider-feedback@bytedance.com)',
    tier: 'important',
  },
  {
    name: 'Meta-ExternalAgent',
    user_agent:
      'Meta-ExternalAgent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)',
    tier: 'other',
  },
  {
    name: 'Amazonbot',
    user_agent:
      'Mozilla/5.0 (compatible; Amazonbot/0.1; +developer.amazon.com/support/amazonbot)',
    tier: 'other',
  },
  {
    name: 'Googlebot',
    user_agent:
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    tier: 'seo',
  },
  {
    name: 'Bingbot',
    user_agent:
      'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingcrawler.html)',
    tier: 'seo',
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
