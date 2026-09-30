import type { DiscoveryConfig, ScanMode } from './types';
import type { DiscoveryMethod, InventoryUrl } from './inventory';
import type { LinkIntegrityManifestBlock } from './link-integrity';
import {
  DEFAULT_PAGE_BUDGET,
  DISCOVERY_VERSION,
  EXCLUSIONS_VERSION,
  FETCHER_VERSION,
  HARD_MAX_PAGE_FETCHES,
  HARD_MAX_SELECTED_PAGES,
  HARD_MAX_TOTAL_REQUESTS,
  MANIFEST_VERSION,
  MAX_CONCURRENCY,
  MAX_RETRIES,
  MIN_REQUEST_DELAY_MS,
  NORMALIZATION_VERSION,
  ROBOTS_RULES_VERSION,
  ROLE_PATTERNS_VERSION,
  SELECTOR_VERSION,
} from './versions';

export interface CoverageManifest {
  manifest_version: string;
  scan_id: string;
  scan_mode: ScanMode;
  domain: string;
  seed_url: string;
  started_at: string;
  completed_at: string | null;
  status: 'complete' | 'partial' | 'aborted';
  abort_reason: string | null;
  method: {
    discovery_version: string;
    normalization_version: string;
    selector_version?: string;
    role_patterns_version?: string;
    exclusions_version?: string;
    robots_rules_version?: string;
    fetcher_version?: string;
    config: {
      max_child_sitemaps: number;
      max_sitemap_depth: number;
      max_loc_entries: number;
      max_discovery_requests: number;
      page_budget?: number;
      hard_max_selected_pages?: number;
      hard_max_page_fetches?: number;
      hard_max_total_requests?: number;
      concurrency?: number;
      min_request_delay_ms?: number;
      max_retries?: number;
    };
  };
  discovery: {
    methods_used: DiscoveryMethod[];
    sitemaps_found: number;
    sitemaps_parsed: number;
    sitemaps_skipped_cross_origin: number;
    sitemap_entries_seen: number;
    discovery_complete: boolean;
    truncation_reason: string | null;
    requests_made: number;
  };
  fetch?: FetchManifestBlock;
  link_integrity?: LinkIntegrityManifestBlock;
  urls: {
    discovered: number;
    in_scope: number;
    excluded: number;
    selected: number;
    attempted: number;
    fetched: number;
    analyzed: number;
    skipped: number;
    blocked: number;
    failed: number;
  };
  coverage: CoverageRatio[];
}

export interface CoverageRatio {
  key: string;
  numerator: number;
  denominator: number;
  label: string;
}

export interface FetchManifestBlock {
  attempted: number;
  fetched: number;
  redirected_not_followed: number;
  skipped_robots: number;
  skipped_excluded: number;
  skipped_not_selected: number;
  blocked: number;
  failed: number;
  retries_used: number;
  page_requests_made: number;
  total_requests_made: number;
  robots_determinable: boolean;
  stop_reason: null | 'complete' | 'page_budget' | 'page_fetch_ceiling'
    | 'total_request_ceiling' | 'rate_limited'
    | 'robots_undeterminable' | 'crawl_delay_too_large';
}

export interface BuildManifestInput {
  scanId: string;
  scanMode: ScanMode;
  domain: string;
  seedUrl: string;
  startedAt: string;
  completedAt: string | null;
  status: CoverageManifest['status'];
  abortReason: string | null;
  config: DiscoveryConfig;
  urls: InventoryUrl[];
  methodsUsed: DiscoveryMethod[];
  sitemapsFound: number;
  sitemapsParsed: number;
  sitemapsSkippedCrossOrigin: number;
  sitemapEntriesSeen: number;
  discoveryComplete: boolean;
  truncationReason: string | null;
  requestsMade: number;
  pageBudget?: number;
  fetch?: FetchManifestBlock;
  linkIntegrity?: LinkIntegrityManifestBlock;
}

export function makeCoverageRatio(key: string, numerator: number, denominator: number, label: string): CoverageRatio {
  if (denominator === 0) throw new Error('coverage_denominator_zero');
  if (!label.includes(String(numerator)) || !label.includes(String(denominator))) {
    throw new Error('coverage_label_missing_numbers');
  }
  return { key, numerator, denominator, label };
}

export function buildManifest(input: BuildManifestInput): CoverageManifest {
  if (!input.discoveryComplete && !input.truncationReason) {
    throw new Error('truncation_reason_required');
  }
  const discovered = input.urls.length;
  const inScope = input.urls.filter(row => row.inScope).length;
  const excluded = input.urls.filter(row => row.excludedReason !== null || !row.inScope).length;
  const selected = input.urls.filter(row => row.selected === true).length;
  const fetched = input.urls.filter(row => row.fetchState === 'fetched').length;
  const coverage = discovered === 0 ? [] : [
    makeCoverageRatio('analyzed_discovered', 0, discovered, `0 of ${discovered} discovered URLs analyzed`),
  ];
  if (discovered > 0) {
    coverage.push(makeCoverageRatio('selected_of_discovered', selected, discovered, `${selected} of ${discovered} discovered URLs selected`));
  }
  if (selected > 0) {
    coverage.push(makeCoverageRatio('fetched_of_selected', fetched, selected, `${fetched} of ${selected} selected URLs fetched`));
  }
  if (input.linkIntegrity && input.linkIntegrity.unique_internal_targets > 0) {
    coverage.push(makeCoverageRatio(
      'targets_checked_of_unique_internal',
      input.linkIntegrity.targets_checked,
      input.linkIntegrity.unique_internal_targets,
      `${input.linkIntegrity.targets_checked} of ${input.linkIntegrity.unique_internal_targets} unique internal link targets checked`,
    ));
  }
  if (input.linkIntegrity && input.linkIntegrity.targets_selected_for_check > 0) {
    coverage.push(makeCoverageRatio(
      'targets_checked_of_selected',
      input.linkIntegrity.targets_checked,
      input.linkIntegrity.targets_selected_for_check,
      `${input.linkIntegrity.targets_checked} of ${input.linkIntegrity.targets_selected_for_check} selected link targets checked`,
    ));
  }

  return {
    manifest_version: MANIFEST_VERSION,
    scan_id: input.scanId,
    scan_mode: input.scanMode,
    domain: input.domain,
    seed_url: input.seedUrl,
    started_at: input.startedAt,
    completed_at: input.completedAt,
    status: input.status,
    abort_reason: input.abortReason,
    method: {
      discovery_version: DISCOVERY_VERSION,
      normalization_version: NORMALIZATION_VERSION,
      selector_version: SELECTOR_VERSION,
      role_patterns_version: ROLE_PATTERNS_VERSION,
      exclusions_version: EXCLUSIONS_VERSION,
      robots_rules_version: ROBOTS_RULES_VERSION,
      fetcher_version: FETCHER_VERSION,
      config: {
        max_child_sitemaps: input.config.maxChildSitemaps,
        max_sitemap_depth: input.config.maxSitemapDepth,
        max_loc_entries: input.config.maxLocEntries,
        max_discovery_requests: input.config.maxDiscoveryRequests,
        page_budget: Math.min(input.pageBudget ?? DEFAULT_PAGE_BUDGET, HARD_MAX_SELECTED_PAGES),
        hard_max_selected_pages: HARD_MAX_SELECTED_PAGES,
        hard_max_page_fetches: HARD_MAX_PAGE_FETCHES,
        hard_max_total_requests: HARD_MAX_TOTAL_REQUESTS,
        concurrency: MAX_CONCURRENCY,
        min_request_delay_ms: MIN_REQUEST_DELAY_MS,
        max_retries: MAX_RETRIES,
      },
    },
    discovery: {
      methods_used: input.methodsUsed,
      sitemaps_found: input.sitemapsFound,
      sitemaps_parsed: input.sitemapsParsed,
      sitemaps_skipped_cross_origin: input.sitemapsSkippedCrossOrigin,
      sitemap_entries_seen: input.sitemapEntriesSeen,
      discovery_complete: input.discoveryComplete,
      truncation_reason: input.truncationReason,
      requests_made: input.requestsMade,
    },
    fetch: input.fetch,
    link_integrity: input.linkIntegrity,
    urls: {
      discovered,
      in_scope: inScope,
      excluded,
      selected,
      attempted: input.urls.filter(row => row.fetchState === 'fetched' || row.fetchState === 'redirected' || row.fetchState === 'blocked' || row.fetchState === 'failed').length,
      fetched,
      analyzed: 0,
      skipped: input.urls.filter(row => row.fetchState === 'skipped').length,
      blocked: input.urls.filter(row => row.fetchState === 'blocked').length,
      failed: input.urls.filter(row => row.fetchState === 'failed').length,
    },
    coverage,
  };
}
