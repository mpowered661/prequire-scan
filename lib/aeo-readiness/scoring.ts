import type { CrawlerResult, CrawlerDefinition, CrawlerPurpose, OverallStatus, PurposeBreakdown } from './types';

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

/**
 * The verdict a result supports about access. A simulated request that hit a
 * server error or timeout (stored before 2026-11 as 'blocked') proves nothing
 * about blocking, so it reads as undeterminable.
 */
export function effectiveStatus(r: CrawlerResult): OverallStatus {
  if (r.overall_status === 'blocked' && r.tests?.http_response?.status === 'error') {
    return 'undeterminable';
  }
  return r.overall_status;
}

/**
 * Robots.txt directive tokens (Google-Extended, Applebot-Extended) are never
 * requested, so their verdict is a permission, not observed access. Identified by
 * the registry, or — for stored results — by the not-applicable HTTP test.
 */
export function isRobotsToken(r: CrawlerResult, def?: CrawlerDefinition): boolean {
  return def?.check_type === 'robots_only' || r.tests?.http_response?.status === 'not_applicable';
}

export function computeScore(
  results: CrawlerResult[],
  activeCrawlers: CrawlerDefinition[],
): number {
  const defMap = new Map(activeCrawlers.map((c) => [c.name, c]));
  const weightMap = new Map(activeCrawlers.map((c) => [c.name, TIER_WEIGHTS[c.tier] ?? 1]));

  let totalWeight = 0;
  let earnedWeight = 0;

  for (const r of results) {
    // Only simulated requests measure access; a robots.txt permission does not.
    if (isRobotsToken(r, defMap.get(r.crawler_name))) continue;
    const status = effectiveStatus(r);
    if (status === 'undeterminable') continue; // excluded from denominator
    const weight = weightMap.get(r.crawler_name) ?? 1;
    totalWeight += weight;
    earnedWeight += weight * (STATUS_SCORE[status] ?? 0);
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
    breakdown[purpose][effectiveStatus(r)] += 1;
  }

  return breakdown;
}
