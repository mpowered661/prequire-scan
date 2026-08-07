import { describe, it, expect } from 'vitest';
import { computeScore, computePurposeBreakdown } from './scoring';
import type { CrawlerResult, CrawlerDefinition, CrawlerTier, CrawlerPurpose, OverallStatus, CrawlerTests } from './types';

function def(name: string, tier: CrawlerTier, purpose: CrawlerPurpose = 'training'): CrawlerDefinition {
  return { name, tier, purpose, user_agent: 'Test/1.0' };
}

function result(name: string, status: OverallStatus): CrawlerResult {
  return {
    crawler_name: name,
    user_agent: 'Test/1.0',
    overall_status: status,
    blocker_layer: 'none',
    blocker_detail: '',
    tests: {} as CrawlerTests,
  };
}

describe('computeScore', () => {
  it('returns 100 when all crawlers are accessible', () => {
    const crawlers = [def('GPTBot', 'critical'), def('ClaudeBot', 'important')];
    const results = crawlers.map((c) => result(c.name, 'accessible'));
    expect(computeScore(results, crawlers)).toBe(100);
  });

  it('returns 0 when all crawlers are blocked', () => {
    const crawlers = [def('GPTBot', 'critical'), def('ClaudeBot', 'critical')];
    const results = crawlers.map((c) => result(c.name, 'blocked'));
    expect(computeScore(results, crawlers)).toBe(0);
  });

  it('returns 0 for empty input', () => {
    expect(computeScore([], [])).toBe(0);
  });

  it('weights critical tier (4x) heavier than other tier (1x)', () => {
    const crawlers = [
      def('GPTBot', 'critical'),   // weight 4
      def('Amazonbot', 'other'),   // weight 1
    ];
    // GPTBot blocked, Amazonbot accessible → earned = 0*4 + 1*1 = 1 of 5 → 20
    expect(computeScore(
      [result('GPTBot', 'blocked'), result('Amazonbot', 'accessible')],
      crawlers,
    )).toBe(20);

    // GPTBot accessible, Amazonbot blocked → earned = 1*4 + 0*1 = 4 of 5 → 80
    expect(computeScore(
      [result('GPTBot', 'accessible'), result('Amazonbot', 'blocked')],
      crawlers,
    )).toBe(80);
  });

  it('weights important tier (2x) correctly', () => {
    const crawlers = [
      def('A', 'important'),  // weight 2
      def('B', 'other'),      // weight 1
    ];
    // A blocked (0*2=0), B accessible (1*1=1) → 1/3 → 33
    expect(computeScore(
      [result('A', 'blocked'), result('B', 'accessible')],
      crawlers,
    )).toBe(33);
  });

  it('gives partial access exactly half the score weight', () => {
    const crawlers = [def('GPTBot', 'critical')];  // weight 4
    // earned = 0.5 * 4 = 2 of 4 → 50
    expect(computeScore([result('GPTBot', 'partial')], crawlers)).toBe(50);
  });

  it('stacks deductions correctly across mixed tiers and statuses', () => {
    const crawlers = [
      def('A', 'critical'),   // weight 4
      def('B', 'important'),  // weight 2
      def('C', 'other'),      // weight 1
    ];
    // A=blocked(0), B=partial(0.5), C=accessible(1)
    // earned = 0*4 + 0.5*2 + 1*1 = 2, total = 7 → round(2/7 * 100) = 29
    expect(computeScore(
      [result('A', 'blocked'), result('B', 'partial'), result('C', 'accessible')],
      crawlers,
    )).toBe(29);
  });

  it('is deterministic: same input always produces same output', () => {
    const crawlers = [def('GPTBot', 'critical'), def('ClaudeBot', 'critical')];
    const results = [result('GPTBot', 'partial'), result('ClaudeBot', 'blocked')];
    const scores = Array.from({ length: 5 }, () => computeScore(results, crawlers));
    expect(new Set(scores).size).toBe(1);
  });

  it('excludes undeterminable from the denominator entirely', () => {
    const crawlers = [def('GPTBot', 'critical'), def('Amazonbot', 'other')];
    // GPTBot undeterminable (excluded) + Amazonbot accessible → 1/1 → 100
    expect(computeScore(
      [result('GPTBot', 'undeterminable'), result('Amazonbot', 'accessible')],
      crawlers,
    )).toBe(100);
    // GPTBot undeterminable (excluded) + Amazonbot blocked → 0/1 → 0
    expect(computeScore(
      [result('GPTBot', 'undeterminable'), result('Amazonbot', 'blocked')],
      crawlers,
    )).toBe(0);
  });

  it('returns 0 when every crawler is undeterminable (no determinable signals)', () => {
    const crawlers = [def('GPTBot', 'critical'), def('ClaudeBot', 'critical')];
    const results = crawlers.map((c) => result(c.name, 'undeterminable'));
    expect(computeScore(results, crawlers)).toBe(0);
  });

  it('ignores crawlers in results that have no matching definition', () => {
    const crawlers = [def('GPTBot', 'critical')];
    const results = [
      result('GPTBot', 'accessible'),
      result('UnknownBot', 'blocked'), // not in crawlers — uses fallback weight 1
    ];
    // GPTBot: 1*4=4, UnknownBot: 0*1=0 → earned=4, total=5 → 80
    expect(computeScore(results, crawlers)).toBe(80);
  });
});

describe('computePurposeBreakdown', () => {
  it('groups results by registry purpose', () => {
    const crawlers = [
      def('GPTBot', 'critical', 'training'),
      def('OAI-SearchBot', 'important', 'search_index'),
      def('ChatGPT-User', 'important', 'user_fetch'),
      def('Googlebot', 'seo', 'seo'),
    ];
    const results = [
      result('GPTBot', 'blocked'),
      result('OAI-SearchBot', 'accessible'),
      result('ChatGPT-User', 'undeterminable'),
      result('Googlebot', 'partial'),
    ];
    const bd = computePurposeBreakdown(results, crawlers);
    expect(bd.training).toEqual({ accessible: 0, partial: 0, blocked: 1, undeterminable: 0 });
    expect(bd.search_index).toEqual({ accessible: 1, partial: 0, blocked: 0, undeterminable: 0 });
    expect(bd.user_fetch).toEqual({ accessible: 0, partial: 0, blocked: 0, undeterminable: 1 });
    expect(bd.seo).toEqual({ accessible: 0, partial: 1, blocked: 0, undeterminable: 0 });
  });

  it('does not change computeScore — training and retrieval remain blended in the headline (informational separation only)', () => {
    const crawlers = [
      def('GPTBot', 'critical', 'training'),
      def('PerplexityBot', 'critical', 'search_index'),
    ];
    const results = [result('GPTBot', 'blocked'), result('PerplexityBot', 'accessible')];
    // Existing headline semantics preserved: 4 of 8 weight earned → 50
    expect(computeScore(results, crawlers)).toBe(50);
  });

  it('skips results with no registry definition', () => {
    const bd = computePurposeBreakdown([result('GhostBot', 'blocked')], []);
    expect(bd.training.blocked + bd.search_index.blocked + bd.user_fetch.blocked + bd.seo.blocked).toBe(0);
  });

  it('all four purposes are always present with zeroed counters', () => {
    const bd = computePurposeBreakdown([], []);
    expect(Object.keys(bd).sort()).toEqual(['search_index', 'seo', 'training', 'user_fetch']);
  });
});
