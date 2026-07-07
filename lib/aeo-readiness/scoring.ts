import type { CrawlerResult, CrawlerDefinition } from './types';

const TIER_WEIGHTS: Record<string, number> = {
  critical: 4,
  important: 2,
  other: 1,
  seo: 1,
};

const STATUS_SCORE: Record<string, number> = {
  accessible: 1.0,
  partial: 0.5,
  blocked: 0.0,
};

// Undeterminable verdicts carry no information about real-crawler access, so they
// contribute nothing to either side of the score — the score reflects only
// determinable signals. The summary reports the undeterminable count separately.

export function computeScore(
  results: CrawlerResult[],
  activeCrawlers: CrawlerDefinition[],
): number {
  const weightMap = new Map(activeCrawlers.map((c) => [c.name, TIER_WEIGHTS[c.tier] ?? 1]));

  let totalWeight = 0;
  let earnedWeight = 0;

  for (const r of results) {
    if (r.overall_status === 'undeterminable') continue; // excluded from denominator
    const weight = weightMap.get(r.crawler_name) ?? 1;
    totalWeight += weight;
    earnedWeight += weight * (STATUS_SCORE[r.overall_status] ?? 0);
  }

  if (totalWeight === 0) return 0;
  return Math.round((earnedWeight / totalWeight) * 100);
}
