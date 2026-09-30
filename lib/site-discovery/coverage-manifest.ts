import type { DiscoveryConfig, ScanMode } from './types';
import type { DiscoveryMethod, InventoryUrl } from './inventory';
import { DISCOVERY_VERSION, MANIFEST_VERSION, NORMALIZATION_VERSION } from './versions';

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
    config: {
      max_child_sitemaps: number;
      max_sitemap_depth: number;
      max_loc_entries: number;
      max_discovery_requests: number;
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
  const excluded = discovered - inScope;
  const coverage = discovered === 0 ? [] : [
    makeCoverageRatio('analyzed_discovered', 0, discovered, `0 of ${discovered} discovered URLs analyzed`),
  ];

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
      config: {
        max_child_sitemaps: input.config.maxChildSitemaps,
        max_sitemap_depth: input.config.maxSitemapDepth,
        max_loc_entries: input.config.maxLocEntries,
        max_discovery_requests: input.config.maxDiscoveryRequests,
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
    urls: {
      discovered,
      in_scope: inScope,
      excluded,
      selected: 0,
      attempted: 0,
      fetched: 0,
      analyzed: 0,
      skipped: 0,
      blocked: 0,
      failed: 0,
    },
    coverage,
  };
}
