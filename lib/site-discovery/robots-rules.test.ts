import { describe, expect, it } from 'vitest';
import { evaluateRobots, getCrawlDelayMs, ROBOTS_RULES_VERSION } from './robots-rules';

describe('robots rules', () => {
  it('exports the frozen version', () => {
    expect(ROBOTS_RULES_VERSION).toBe('robots-0.1');
  });

  it('uses longest match and lets Allow win equal-length ties', () => {
    const robots = [
      'User-agent: *',
      'Disallow: /private',
      'Allow: /private/public',
      'Disallow: /tie',
      'Allow: /tie',
    ].join('\n');
    expect(evaluateRobots(robots, '/private/x', 'bot').allowed).toBe(false);
    expect(evaluateRobots(robots, '/private/public', 'bot').allowed).toBe(true);
    expect(evaluateRobots(robots, '/tie', 'bot').allowed).toBe(true);
  });

  it('supports wildcards and end anchors', () => {
    expect(evaluateRobots('User-agent: *\nDisallow: /*.pdf$', '/x/file.pdf', 'bot').allowed).toBe(false);
    expect(evaluateRobots('User-agent: *\nDisallow: /*.pdf$', '/x/file.pdf?ok=1', 'bot').allowed).toBe(true);
  });

  it('treats null robots as permissive and html robots as undeterminable', () => {
    expect(evaluateRobots(null, '/', 'bot')).toEqual({ allowed: true, matchedRule: null, determinable: true });
    expect(evaluateRobots('<html>login</html>', '/', 'bot').determinable).toBe(false);
  });

  it('reads crawl delay for the selected user-agent group', () => {
    expect(getCrawlDelayMs('User-agent: *\nCrawl-delay: 3', 'Prequire-SiteDiscovery/0.1')).toBe(3000);
  });
});
