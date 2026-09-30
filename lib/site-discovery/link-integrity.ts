import { extractLinks } from './link-extract';
import { selectTargets } from './link-targets';
import { checkTargets, type TargetCheckStats } from './target-check';
import type { BudgetTracker } from './fetcher';
import type { ExtractedLink, FetchedPageArtifact, TargetObservation } from './types';
import {
  LINK_EXTRACT_VERSION,
  LINK_INTEGRITY_VERSION,
  TARGET_CHECK_VERSION,
} from './versions';

export { LINK_INTEGRITY_VERSION };

export interface LinkIntegrityManifestBlock {
  link_extract_version: string;
  target_check_version: string;
  link_integrity_version: string;
  pages_supplying_html: number;
  links_observed: number;
  internal_links_observed: number;
  external_links_observed: number;
  unsupported_links_observed: number;
  unique_internal_targets: number;
  targets_eligible: number;
  targets_selected_for_check: number;
  targets_checked: number;
  targets_unchecked: number;
  unchecked_by_reason: Record<string, number>;
  targets_healthy: number;
  targets_redirected: number;
  targets_broken_4xx: number;
  targets_server_failure_5xx: number;
  targets_blocked: number;
  targets_timeout: number;
  targets_undeterminable: number;
  head_requests: number;
  get_fallbacks: number;
  redirect_hops: number;
  retries_used: number;
  target_check_requests_made: number;
  stop_reason: null | 'complete' | 'target_budget' | 'total_request_ceiling' | 'rate_limited' | 'no_html_available';
}

export interface LinkIntegrityResult {
  links: ExtractedLink[];
  targets: TargetObservation[];
  manifest: LinkIntegrityManifestBlock;
}

export function createHtmlSink(scopeOrigin: string): {
  onPage: (artifact: FetchedPageArtifact) => void;
  onHtml: (sourceUrl: string, html: string) => void;
  pages: () => number;
  links: () => ExtractedLink[];
} {
  const links: ExtractedLink[] = [];
  let pages = 0;
  const ingest = (sourceUrl: string, html: string) => {
    pages += 1;
    links.push(...extractLinks(html, sourceUrl, scopeOrigin));
  };
  return {
    onPage(artifact) {
      ingest(artifact.finalUrl, artifact.html);
    },
    onHtml(sourceUrl, html) {
      ingest(sourceUrl, html);
    },
    pages: () => pages,
    links: () => [...links],
  };
}

export async function runLinkIntegrity(
  links: ExtractedLink[],
  opts: {
    pagesSupplyingHtml: number;
    scopeOrigin: string;
    robotsTxt: string | null;
    budgetTracker: BudgetTracker;
    targetCheckBudget?: number;
  },
): Promise<LinkIntegrityResult> {
  if (opts.pagesSupplyingHtml === 0) {
    return { links, targets: [], manifest: buildBlock(links, [], emptyStats('no_html_available'), 0, 0, 0) };
  }
  const selection = selectTargets(links, opts.targetCheckBudget);
  const checked = await checkTargets(selection.selected, {
    scopeOrigin: opts.scopeOrigin,
    robotsTxt: opts.robotsTxt,
    budgetTracker: opts.budgetTracker,
  });
  const targets = [...checked.observations, ...selection.unselected];
  const targetBudgetHit = selection.unselected.length > 0 && checked.stats.stopReason === 'complete';
  const stopReason = targetBudgetHit ? 'target_budget' : checked.stats.stopReason;
  return {
    links,
    targets,
    manifest: buildBlock(links, targets, { ...checked.stats, stopReason }, selection.candidates.length, selection.selected.length, opts.pagesSupplyingHtml),
  };
}

function buildBlock(
  links: ExtractedLink[],
  targets: TargetObservation[],
  stats: TargetCheckStats | ReturnType<typeof emptyStats>,
  uniqueInternalTargets: number,
  targetsSelectedForCheck: number,
  pagesSupplyingHtml: number,
): LinkIntegrityManifestBlock {
  const unchecked = targets.filter(target => target.checkState === 'unchecked');
  return {
    link_extract_version: LINK_EXTRACT_VERSION,
    target_check_version: TARGET_CHECK_VERSION,
    link_integrity_version: LINK_INTEGRITY_VERSION,
    pages_supplying_html: pagesSupplyingHtml,
    links_observed: links.length,
    internal_links_observed: links.filter(link => link.isInternal).length,
    external_links_observed: links.filter(link => link.exclusionReason === 'external').length,
    unsupported_links_observed: links.filter(link => link.exclusionReason !== null && link.exclusionReason !== 'external').length,
    unique_internal_targets: uniqueInternalTargets,
    targets_eligible: uniqueInternalTargets,
    targets_selected_for_check: targetsSelectedForCheck,
    targets_checked: targets.filter(target => target.checkState === 'checked').length,
    targets_unchecked: unchecked.length,
    unchecked_by_reason: countBy(unchecked.map(target => target.uncheckedReason ?? 'unknown')),
    targets_healthy: countClass(targets, 'healthy'),
    targets_redirected: countClass(targets, 'redirected'),
    targets_broken_4xx: countClass(targets, 'broken_4xx'),
    targets_server_failure_5xx: countClass(targets, 'server_failure_5xx'),
    targets_blocked: countClass(targets, 'blocked'),
    targets_timeout: countClass(targets, 'timeout'),
    targets_undeterminable: countClass(targets, 'undeterminable'),
    head_requests: stats.headRequests,
    get_fallbacks: stats.getFallbacks,
    redirect_hops: stats.redirectHops,
    retries_used: stats.retriesUsed,
    target_check_requests_made: stats.targetCheckRequestsMade,
    stop_reason: stats.stopReason,
  };
}

function emptyStats(stopReason: LinkIntegrityManifestBlock['stop_reason']) {
  return {
    headRequests: 0,
    getFallbacks: 0,
    redirectHops: 0,
    retriesUsed: 0,
    targetCheckRequestsMade: 0,
    stopReason,
  };
}

function countClass(targets: TargetObservation[], classification: NonNullable<TargetObservation['classification']>): number {
  return targets.filter(target => target.classification === classification).length;
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}
