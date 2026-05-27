import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkRobotsTxt } from './robots-parser';

function fixture(name: string): string {
  return readFileSync(
    resolve(process.cwd(), 'lib/aeo-readiness/__fixtures__', name),
    'utf8',
  );
}

const URL = 'https://example.com/page';
const ROOT_URL = 'https://example.com/';

describe('checkRobotsTxt', () => {
  describe('empty / missing robots.txt', () => {
    it('treats empty string as all-allowed', async () => {
      const { result } = await checkRobotsTxt(URL, 'GPTBot', '');
      expect(result.status).toBe('allowed');
    });

    it('treats whitespace-only content as all-allowed', async () => {
      const { result } = await checkRobotsTxt(URL, 'GPTBot', '   \n\n  ');
      expect(result.status).toBe('allowed');
    });
  });

  describe('standard Allow / Disallow rules', () => {
    it('disallows a bot blocked by its specific rule', async () => {
      // robots-standard.txt: GPTBot is blocked with Disallow: /
      const { result } = await checkRobotsTxt(URL, 'GPTBot', fixture('robots-standard.txt'));
      expect(result.status).toBe('disallowed');
      expect(result.matched_rule).toMatch(/Disallow/);
    });

    it('allows a bot explicitly permitted by its specific rule', async () => {
      // robots-standard.txt: ClaudeBot has Allow: /
      const { result } = await checkRobotsTxt(URL, 'ClaudeBot', fixture('robots-standard.txt'));
      expect(result.status).toBe('allowed');
    });

    it('applies wildcard rule to a bot with no specific block', async () => {
      // robots-standard.txt: wildcard blocks /admin/ — PerplexityBot has no specific rule
      const { result } = await checkRobotsTxt('https://example.com/admin/', 'PerplexityBot', fixture('robots-standard.txt'));
      expect(result.status).toBe('disallowed');
    });
  });

  describe('wildcard user-agent', () => {
    it('disallows all bots when wildcard Disallow: / is set', async () => {
      const txt = fixture('robots-wildcard.txt'); // User-agent: * \n Disallow: /
      const bots = ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Googlebot'];
      for (const bot of bots) {
        const { result } = await checkRobotsTxt(URL, bot, txt);
        expect(result.status, `${bot} should be disallowed`).toBe('disallowed');
      }
    });
  });

  describe('specific bot overrides wildcard (RFC 9309)', () => {
    it('allows a bot with a specific Allow rule even when wildcard blocks everything', async () => {
      const txt = `User-agent: *\nDisallow: /\n\nUser-agent: GPTBot\nAllow: /`;
      const { result } = await checkRobotsTxt(URL, 'GPTBot', txt);
      expect(result.status).toBe('allowed');
    });

    it('blocks a bot with a specific Disallow even when wildcard allows everything', async () => {
      const txt = `User-agent: *\nAllow: /\n\nUser-agent: ClaudeBot\nDisallow: /`;
      const { result } = await checkRobotsTxt(URL, 'ClaudeBot', txt);
      expect(result.status).toBe('disallowed');
    });

    it('uses specific rule exclusively — does not fall through to wildcard', async () => {
      // Specific rule: only blocks /secret/. Wildcard: blocks everything.
      // For a request to /page, specific rule has no match → allowed (not blocked by wildcard)
      const txt = `User-agent: *\nDisallow: /\n\nUser-agent: GPTBot\nDisallow: /secret/`;
      const { result } = await checkRobotsTxt('https://example.com/page', 'GPTBot', txt);
      expect(result.status).toBe('allowed');
    });
  });

  describe('longest-match rule (RFC 9309)', () => {
    it('more specific Allow wins over less specific Disallow', async () => {
      const txt = `User-agent: *\nDisallow: /\nAllow: /page`;
      const { result } = await checkRobotsTxt('https://example.com/page', 'GPTBot', txt);
      expect(result.status).toBe('allowed');
    });

    it('more specific Disallow wins over less specific Allow', async () => {
      const txt = `User-agent: *\nAllow: /\nDisallow: /private/secret`;
      const { result } = await checkRobotsTxt('https://example.com/private/secret', 'GPTBot', txt);
      expect(result.status).toBe('disallowed');
    });
  });

  describe('malformed robots.txt', () => {
    it('does not throw on malformed content', async () => {
      await expect(checkRobotsTxt(URL, 'GPTBot', fixture('robots-malformed.txt'))).resolves.toBeDefined();
    });

    it('sets malformed flag on malformed content', async () => {
      const { result } = await checkRobotsTxt(URL, 'GPTBot', fixture('robots-malformed.txt'));
      expect(result.malformed).toBe(true);
    });

    it('still applies valid rules from a malformed file', async () => {
      // robots-malformed.txt: GPTBot has Disallow: /private/ despite malformed lines
      const { result } = await checkRobotsTxt('https://example.com/private/', 'GPTBot', fixture('robots-malformed.txt'));
      expect(result.status).toBe('disallowed');
    });
  });

  describe('Crawl-delay and Sitemap directives', () => {
    it('parses Crawl-delay and Sitemap without breaking rule evaluation', async () => {
      const txt = fixture('robots-crawl-delay.txt');
      // /private/ is disallowed, /public/ is allowed
      const blocked = await checkRobotsTxt('https://example.com/private/', 'GPTBot', txt);
      const allowed = await checkRobotsTxt('https://example.com/about/', 'GPTBot', txt);
      expect(blocked.result.status).toBe('disallowed');
      expect(allowed.result.status).toBe('allowed');
    });
  });

  describe('case insensitivity', () => {
    it('matches user-agent case-insensitively', async () => {
      const txt = 'User-agent: gptbot\nDisallow: /';
      const { result } = await checkRobotsTxt(URL, 'GPTBot', txt);
      expect(result.status).toBe('disallowed');
    });
  });

  describe('grouped user-agent blocks', () => {
    it('applies the same rule to multiple agents listed in a single block', async () => {
      const txt = `User-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /`;
      const gpt = await checkRobotsTxt(URL, 'GPTBot', txt);
      const claude = await checkRobotsTxt(URL, 'ClaudeBot', txt);
      expect(gpt.result.status).toBe('disallowed');
      expect(claude.result.status).toBe('disallowed');
    });
  });
});
