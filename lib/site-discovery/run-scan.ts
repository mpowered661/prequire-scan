import { buildManifest } from './coverage-manifest';
import { runDiscovery } from './discover';
import { BudgetTracker, fetchSelected } from './fetcher';
import { applyTrancheBDefaults } from './inventory';
import { createHtmlSink, runLinkIntegrity } from './link-integrity';
import { buildPageAnalysisManifest, createPageAnalysisSink } from './page-analysis';
import { selectUrls } from './select';
import type { RunScanInput, RunScanResult } from './types';
import { DEFAULT_PAGE_BUDGET, HARD_MAX_SELECTED_PAGES } from './versions';

export async function runScan(input: RunScanInput): Promise<RunScanResult> {
  const discovery = await runDiscovery(input);
  const seed = discovery.urls.find(row => row.discoveryMethod === 'seed' && row.urlNormalized !== null);
  if (!seed?.urlNormalized || discovery.manifest.status === 'aborted') {
    const pageAnalysis = buildPageAnalysisManifest(discovery.urls, []);
    return { ...discovery, manifest: { ...discovery.manifest, page_analysis: pageAnalysis }, pageObservations: [] };
  }
  const scopeOrigin = new URL(seed.urlNormalized).origin;
  const pageBudget = Math.min(input.selection?.budget ?? DEFAULT_PAGE_BUDGET, HARD_MAX_SELECTED_PAGES);
  const selected = selectUrls(discovery.urls, {
    scopeOrigin,
    budget: pageBudget,
    navUrls: input.selection?.navUrls,
  });
  const selectedByUrl = new Map(selected.decisions.map(decision => [decision.urlNormalized, decision]));
  for (const row of discovery.urls) {
    applyTrancheBDefaults(row);
    const decision = row.urlNormalized ? selectedByUrl.get(row.urlNormalized) : undefined;
    row.selected = decision !== undefined;
    row.selectionReason = decision?.reason ?? null;
    row.selectionRank = decision?.rank ?? null;
    row.analysisState = 'not_attempted';
    row.analyzed = false;
  }
  const tracker = new BudgetTracker(input.fetch?.maxTotalRequests, discovery.manifest.discovery.requests_made);
  const htmlSink = createHtmlSink(scopeOrigin);
  const pageAnalysisSink = createPageAnalysisSink(input.scanId, discovery.urls);
  const fetch = await fetchSelected(discovery.urls, {
    scopeOrigin,
    robotsTxt: input.robotsTxt !== undefined ? input.robotsTxt : discovery.robots.body,
    robotsDeterminable: input.robotsDeterminable ?? discovery.robots.determinable,
    config: input.fetch ?? {},
    budgetTracker: tracker,
    onPage: artifact => {
      pageAnalysisSink.onPage(artifact);
      htmlSink.onPage(artifact);
    },
  });
  const pageObservations = pageAnalysisSink.observations();
  const pageAnalysis = buildPageAnalysisManifest(discovery.urls, pageObservations);
  const linkIntegrity = await runLinkIntegrity(htmlSink.links(), {
    pagesSupplyingHtml: htmlSink.pages(),
    scopeOrigin,
    robotsTxt: input.robotsTxt !== undefined ? input.robotsTxt : discovery.robots.body,
    budgetTracker: tracker,
    targetCheckBudget: input.fetch?.targetCheckBudget,
  });
  const manifest = buildManifest({
    scanId: input.scanId,
    scanMode: input.scanMode ?? 'prospect_observation',
    domain: new URL(seed.urlNormalized).hostname,
    seedUrl: seed.urlNormalized,
    startedAt: discovery.manifest.started_at,
    completedAt: new Date().toISOString(),
    status: fetch.stop_reason === 'complete' ? discovery.manifest.status : 'partial',
    abortReason: null,
    config: {
      maxChildSitemaps: discovery.manifest.method.config.max_child_sitemaps,
      maxSitemapDepth: discovery.manifest.method.config.max_sitemap_depth,
      maxLocEntries: discovery.manifest.method.config.max_loc_entries,
      maxDiscoveryRequests: discovery.manifest.method.config.max_discovery_requests,
    },
    urls: discovery.urls,
    methodsUsed: discovery.manifest.discovery.methods_used,
    sitemapsFound: discovery.manifest.discovery.sitemaps_found,
    sitemapsParsed: discovery.manifest.discovery.sitemaps_parsed,
    sitemapsSkippedCrossOrigin: discovery.manifest.discovery.sitemaps_skipped_cross_origin,
    sitemapEntriesSeen: discovery.manifest.discovery.sitemap_entries_seen,
    discoveryComplete: discovery.manifest.discovery.discovery_complete,
    truncationReason: discovery.manifest.discovery.truncation_reason,
    requestsMade: discovery.manifest.discovery.requests_made,
    pageBudget,
    fetch,
    pageAnalysis,
    linkIntegrity: linkIntegrity.manifest,
  });
  return { manifest, urls: discovery.urls, links: linkIntegrity.links, linkTargets: linkIntegrity.targets, pageObservations };
}
