import { ROBOTS_RULES_VERSION } from './versions';

export { ROBOTS_RULES_VERSION };

interface Rule {
  type: 'allow' | 'disallow';
  pattern: string;
}

interface Group {
  agents: string[];
  rules: Rule[];
  crawlDelayMs: number | null;
}

export function evaluateRobots(robotsTxt: string | null, path: string, ua: string):
  { allowed: boolean; matchedRule: string | null; determinable: boolean } {
  if (robotsTxt === null) return { allowed: true, matchedRule: null, determinable: true };
  if (looksHtml(robotsTxt)) return { allowed: false, matchedRule: null, determinable: false };
  const group = selectGroup(parseGroups(robotsTxt), ua);
  if (!group) return { allowed: true, matchedRule: null, determinable: true };
  let winner: { rule: Rule; length: number } | null = null;
  for (const rule of group.rules) {
    if (rule.pattern === '' && rule.type === 'disallow') continue;
    if (!matchesRule(rule.pattern, path)) continue;
    const length = rule.pattern.length;
    if (!winner || length > winner.length || (length === winner.length && rule.type === 'allow')) {
      winner = { rule, length };
    }
  }
  if (!winner) return { allowed: true, matchedRule: null, determinable: true };
  return {
    allowed: winner.rule.type === 'allow',
    matchedRule: `${winner.rule.type === 'allow' ? 'Allow' : 'Disallow'}: ${winner.rule.pattern}`,
    determinable: true,
  };
}

export function getCrawlDelayMs(robotsTxt: string | null, ua: string): number | null {
  if (robotsTxt === null || looksHtml(robotsTxt)) return null;
  return selectGroup(parseGroups(robotsTxt), ua)?.crawlDelayMs ?? null;
}

function parseGroups(robotsTxt: string): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;
    const index = line.indexOf(':');
    if (index < 0) continue;
    const field = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    if (field === 'user-agent') {
      if (!current || current.rules.length > 0 || current.crawlDelayMs !== null) {
        current = { agents: [], rules: [], crawlDelayMs: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (current && (field === 'allow' || field === 'disallow')) {
      current.rules.push({ type: field, pattern: value });
    } else if (current && field === 'crawl-delay') {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) current.crawlDelayMs = Math.max(0, seconds * 1000);
    }
  }
  return groups;
}

function selectGroup(groups: Group[], ua: string): Group | null {
  const token = ua.toLowerCase();
  const matches = groups
    .map(group => ({ group, agent: group.agents.filter(agent => agent === '*' || token.includes(agent)).sort((a, b) => b.length - a.length)[0] }))
    .filter((entry): entry is { group: Group; agent: string } => entry.agent !== undefined)
    .sort((a, b) => b.agent.length - a.agent.length);
  return matches[0]?.group ?? null;
}

function matchesRule(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const source = pattern.replace(/\$$/, '').split('').map(char => {
    if (char === '*') return '.*';
    return char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }).join('');
  return new RegExp(`^${source}${anchored ? '$' : ''}`).test(path);
}

function looksHtml(value: string): boolean {
  return /<!doctype html|<html[\s>]/i.test(value);
}
