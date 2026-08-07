import type { CrawlerResult, CrawlerDefinition, CrawlerPurpose, PurposeBreakdown } from './types';

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

// Informational separation of crawler purposes (registry v2026-08). Blocking a
// training bot is a rights posture, not an AI-visibility defect, so purposes are
// reported separately. This does NOT feed computeScore — headline scoring is
// unchanged; the breakdown exists so reports and exports can distinguish
// training vs search_index vs user_fetch access.
export function computePurposeBreakdown(
  results: CrawlerResult[],
  activeCrawlers: CrawlerDefinition[],
): Record<CrawlerPurpose, PurposeBreakdown> {
  const purposeMap = new Map(activeCrawlers.map((c) => [c.name, c.purpose]));
  const empty = (): PurposeBreakdown => ({
    accessible: 0,
    partial: 0,
    blocked: 0,
    undeterminable: 0,
  });
  const breakdown: Record<CrawlerPurpose, PurposeBreakdown> = {
    training: empty(),
    search_index: empty(),
    user_fetch: empty(),
    seo: empty(),
  };

  for (const r of results) {
    const purpose = purposeMap.get(r.crawler_name);
    if (!purpose) continue; // result with no registry definition — not classifiable
    breakdown[purpose][r.overall_status] += 1;
  }

  return breakdown;
}
