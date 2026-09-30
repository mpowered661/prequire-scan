import type { DiscoveryMethod, InventoryUrl } from './inventory';
import type { CoverageManifest } from './coverage-manifest';

export interface DiscoveryConfig {
  maxChildSitemaps: number;
  maxSitemapDepth: number;
  maxLocEntries: number;
  maxDiscoveryRequests: number;
}

export type ScanMode = 'prospect_observation' | 'authorized_customer';

export interface RunDiscoveryInput {
  seedUrl: string;
  scanId: string;
  scanMode?: ScanMode;
  config?: Partial<DiscoveryConfig>;
}

export interface DiscoveryResult {
  manifest: CoverageManifest;
  urls: InventoryUrl[];
  robots: {
    body: string | null;
    httpStatus: number | null;
    determinable: boolean;
  };
}

export interface SelectionConfig {
  budget?: number;
  navUrls?: string[];
}

export interface FetchConfig {
  maxTotalRequests?: number;
  targetCheckBudget?: number;
}

export interface RunScanInput extends RunDiscoveryInput {
  selection?: SelectionConfig;
  fetch?: FetchConfig;
  robotsTxt?: string | null;
  robotsDeterminable?: boolean;
}

export interface RunScanResult {
  manifest: CoverageManifest;
  urls: InventoryUrl[];
  links?: ExtractedLink[];
  linkTargets?: TargetObservation[];
  pageObservations?: PageObservation[];
}

export type LinkPlacement = 'nav' | 'footer' | 'body' | 'unknown';
export type TargetClassification = 'healthy' | 'redirected' | 'broken_4xx'
  | 'server_failure_5xx' | 'blocked' | 'timeout' | 'undeterminable';
export type TargetUncheckedReason = 'target_budget_exhausted' | 'global_budget_exhausted'
  | 'robots_disallowed' | 'host_rate_limited' | 'external' | 'unsupported_scheme' | 'ineligible';

export interface ExtractedLink {
  sourceUrl: string;
  hrefRaw: string;
  targetUrlNormalized: string | null;
  anchorText: string;
  placement: LinkPlacement;
  isInternal: boolean;
  eligibleForCheck: boolean;
  exclusionReason: string | null;
}

export interface TargetObservation {
  targetUrlNormalized: string;
  checkState: 'checked' | 'unchecked';
  uncheckedReason: string | null;
  classification: null | TargetClassification;
  httpStatus: number | null;
  redirectTargetUrl: string | null;
  redirectLeftOrigin: boolean | null;
  redirectHops: number;
  methodUsed: 'HEAD' | 'GET' | null;
  responseMs: number | null;
  sourceLinkCount: number;
  checkedAt: string | null;
}

export interface FetchedPageArtifact {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  html: string;
  contentSha256: string;
  contentLength: number;
  fetchedAt: string;
}

export type OnPage = (artifact: FetchedPageArtifact) => void;

export type PageEngineName =
  | 'extraction_resilience'
  | 'structured_data'
  | 'content_delivery'
  | 'meta_tags';

export type AnalysisState = 'not_attempted' | 'partial' | 'complete' | 'failed';

export interface PageObservation {
  scanId: string;
  requestedUrl: string;
  finalUrl: string;
  engine: PageEngineName;
  engineVersion: string;
  contentSha256: string;
  observation: unknown;
  status: 'ok' | 'failed';
  errorReason: string | null;
  observedAt: string;
  scope: 'page';
}

export type { CoverageManifest, DiscoveryMethod, InventoryUrl };
