import type { RobotsTxtResult } from './types';

interface ParsedRobotsTxt {
  raw: string;
  malformed: boolean;
  // Map of lowercased user-agent → { allows: string[], disallows: string[] }
  rules: Map<string, { allows: string[]; disallows: string[] }>;
}

function parseRobotsTxt(raw: string): ParsedRobotsTxt {
  const rules = new Map<string, { allows: string[]; disallows: string[] }>();
  let malformed = false;
  let currentAgents: string[] = [];
  let inBlock = false;

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();

    if (!line || line.startsWith('#')) continue;

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) {
      malformed = true;
      continue;
    }

    const field = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    if (field === 'user-agent') {
      // Starting a new user-agent block resets the current agent list
      // only if the previous line was NOT also a user-agent directive.
      // Consecutive User-agent lines are grouped (standard behaviour).
      if (inBlock) {
        currentAgents = [];
      }
      currentAgents.push(value.toLowerCase());
      inBlock = false;
    } else if (field === 'allow' || field === 'disallow') {
      inBlock = true;
      for (const agent of currentAgents) {
        if (!rules.has(agent)) {
          rules.set(agent, { allows: [], disallows: [] });
        }
        const entry = rules.get(agent)!;
        if (field === 'allow') {
          entry.allows.push(value);
        } else {
          entry.disallows.push(value);
        }
      }
    }
    // Silently skip unknown directives (Sitemap, Crawl-delay, etc.)
  }

  return { raw, malformed, rules };
}

function pathMatches(pattern: string, urlPath: string): boolean {
  if (!pattern) return false;

  // Robots.txt patterns support only * and $ wildcards. A literal regex
  // conversion is the most interoperable approach for these two characters.
  const regexStr =
    pattern
      .replace(/[.+?^{}()|[\]\\]/g, '\\$&') // escape regex specials except * and $
      .replace(/\*/g, '.*') +
    (pattern.endsWith('$') ? '' : '');

  // $ at the end of a robots.txt pattern anchors to end-of-path, not end-of-regex
  const anchored = pattern.endsWith('$');
  const regex = new RegExp(
    '^' + regexStr.replace(/\$$/, '') + (anchored ? '$' : ''),
    'i',
  );
  return regex.test(urlPath);
}

function isDisallowed(
  parsed: ParsedRobotsTxt,
  botName: string,
  urlPath: string,
): { disallowed: boolean; matchedRule: string | null; source: 'specific' | 'wildcard' | 'none' } {
  const specific = parsed.rules.get(botName.toLowerCase());
  const wildcard = parsed.rules.get('*');

  // Specific bot rule takes precedence over wildcard
  const candidates: Array<{ entry: typeof specific; source: 'specific' | 'wildcard' }> = [];
  if (specific) candidates.push({ entry: specific, source: 'specific' });
  if (wildcard) candidates.push({ entry: wildcard, source: 'wildcard' });

  for (const { entry, source } of candidates) {
    if (!entry) continue;

    // Per RFC 9309, longer (more specific) matching rule wins.
    // Collect all matching allow and disallow patterns, pick longest match.
    let longestAllow = '';
    let longestDisallow = '';

    for (const pattern of entry.allows) {
      if (pathMatches(pattern, urlPath) && pattern.length > longestAllow.length) {
        longestAllow = pattern;
      }
    }
    for (const pattern of entry.disallows) {
      if (pathMatches(pattern, urlPath) && pattern.length > longestDisallow.length) {
        longestDisallow = pattern;
      }
    }

    // Allow wins on equal length (per Google's interpretation)
    if (longestDisallow && longestDisallow.length > longestAllow.length) {
      return { disallowed: true, matchedRule: `Disallow: ${longestDisallow}`, source };
    }

    if (source === 'specific') {
      // Specific block found and it either allows or has no matching rule — stop here,
      // do not fall through to wildcard (specific always wins)
      return { disallowed: false, matchedRule: null, source: 'none' };
    }
  }

  return { disallowed: false, matchedRule: null, source: 'none' };
}

export async function checkRobotsTxt(
  siteUrl: string,
  botName: string,
  cachedRobotsTxt: string | null,
): Promise<{ result: RobotsTxtResult; fetchedContent: string | null }> {
  let robotsContent: string | null = cachedRobotsTxt;
  let fetchedContent: string | null = null;

  if (robotsContent === null) {
    try {
      const base = new URL(siteUrl);
      const robotsUrl = `${base.protocol}//${base.host}/robots.txt`;
      const res = await fetch(robotsUrl, {
        signal: AbortSignal.timeout(10000),
        headers: { 'User-Agent': 'Prequire-AEO-Check/1.0' },
      });

      if (res.status === 404) {
        return {
          result: {
            status: 'no_robots_txt',
            matched_rule: null,
            details: 'No robots.txt found (404)',
          },
          fetchedContent: null,
        };
      }

      robotsContent = await res.text();
      fetchedContent = robotsContent;
    } catch {
      return {
        result: {
          status: 'error',
          matched_rule: null,
          details: 'Failed to fetch robots.txt',
        },
        fetchedContent: null,
      };
    }
  }

  const parsed = parseRobotsTxt(robotsContent);
  const urlPath = (() => {
    try {
      return new URL(siteUrl).pathname || '/';
    } catch {
      return '/';
    }
  })();

  const { disallowed, matchedRule } = isDisallowed(parsed, botName, urlPath);

  const result: RobotsTxtResult = {
    status: disallowed ? 'disallowed' : 'allowed',
    matched_rule: matchedRule,
    details: disallowed
      ? `Bot is blocked by rule: ${matchedRule}`
      : 'Bot is permitted by robots.txt',
    ...(parsed.malformed ? { malformed: true } : {}),
  };

  return { result, fetchedContent };
}
