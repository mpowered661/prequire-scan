export type DiscoveryMethod =
  | 'seed' | 'robots_sitemap' | 'sitemap' | 'sitemap_index' | 'wp_convention';

export type FetchState =
  | 'not_attempted' | 'fetched' | 'redirected' | 'blocked' | 'failed' | 'skipped';

export type AnalysisState = 'not_attempted' | 'partial' | 'complete' | 'failed';

export interface InventoryUrl {
  urlRaw: string;
  urlNormalized: string | null;
  discoveryMethod: DiscoveryMethod;
  discoveredFromUrl: string | null;
  sitemapSourceUrl: string | null;
  linkDepth: number | null;
  inScope: boolean;
  excludedReason: string | null;
  fetchState: FetchState;
  httpStatus: number | null;
  analyzed: boolean;
  analysisState?: AnalysisState;
  firstSeenAt: string;
  selected?: boolean;
  selectionReason?: string | null;
  selectionRank?: number | null;
  skipReason?: string | null;
  redirectTargetUrl?: string | null;
  contentSha256?: string | null;
  contentLength?: number | null;
  responseMs?: number | null;
  lastCheckedAt?: string | null;
}

export type FetchStatePatch = Partial<Pick<InventoryUrl,
  'fetchState' | 'httpStatus' | 'analyzed' | 'analysisState' | 'skipReason' | 'redirectTargetUrl' |
  'contentSha256' | 'contentLength' | 'responseMs' | 'lastCheckedAt'
>>;

export class Inventory {
  private readonly rows = new Map<string, InventoryUrl>();
  duplicatesSuppressed = 0;

  add(row: InventoryUrl): boolean {
    applyTrancheBDefaults(row);
    assertInvariants(row);
    if (row.fetchState !== 'not_attempted' || row.analyzed) {
      throw new Error('tranche_a_fetch_state_violation');
    }
    const key = row.urlNormalized === null ? `raw:${row.urlRaw}` : `normalized:${row.urlNormalized}`;
    if (this.rows.has(key)) {
      this.duplicatesSuppressed += 1;
      return false;
    }
    this.rows.set(key, row);
    return true;
  }

  updateFetchState(key: string, patch: FetchStatePatch): InventoryUrl {
    const row = this.rows.get(key);
    if (!row) throw new Error('inventory_url_not_found');
    updateFetchState(row, patch);
    return row;
  }

  list(): InventoryUrl[] {
    return [...this.rows.values()];
  }
}

export function assertInvariants(row: InventoryUrl): void {
  if (row.analyzed && row.fetchState !== 'fetched') {
    throw new Error('analyzed_requires_fetched');
  }
  if (row.analyzed !== (row.analysisState === 'complete')) {
    throw new Error('analyzed_must_derive_from_analysis_state');
  }
}

export function inventoryKey(row: Pick<InventoryUrl, 'urlRaw' | 'urlNormalized'>): string {
  return row.urlNormalized === null ? `raw:${row.urlRaw}` : `normalized:${row.urlNormalized}`;
}

export function applyTrancheBDefaults(row: InventoryUrl): InventoryUrl {
  row.selected ??= false;
  row.selectionReason ??= null;
  row.selectionRank ??= null;
  row.skipReason ??= null;
  row.redirectTargetUrl ??= null;
  row.contentSha256 ??= null;
  row.contentLength ??= null;
  row.responseMs ??= null;
  row.lastCheckedAt ??= null;
  row.analysisState ??= 'not_attempted';
  row.analyzed = row.analysisState === 'complete';
  return row;
}

export function updateFetchState(row: InventoryUrl, patch: FetchStatePatch): InventoryUrl {
  applyTrancheBDefaults(row);
  if (patch.analyzed !== undefined) throw new Error('analyzed_is_derived');
  if (patch.analysisState !== undefined) row.analysisState = patch.analysisState;
  const nextState = patch.fetchState ?? row.fetchState;
  if (row.fetchState !== 'not_attempted' && nextState !== row.fetchState) {
    throw new Error('illegal_fetch_state_transition');
  }
  if (row.fetchState === 'not_attempted') {
    row.fetchState = nextState;
  } else if (nextState !== row.fetchState) {
    throw new Error('illegal_fetch_state_transition');
  }
  if (patch.httpStatus !== undefined) row.httpStatus = patch.httpStatus;
  if (patch.skipReason !== undefined) row.skipReason = patch.skipReason;
  if (patch.redirectTargetUrl !== undefined) row.redirectTargetUrl = patch.redirectTargetUrl;
  if (patch.contentSha256 !== undefined) row.contentSha256 = patch.contentSha256;
  if (patch.contentLength !== undefined) row.contentLength = patch.contentLength;
  if (patch.responseMs !== undefined) row.responseMs = patch.responseMs;
  if (patch.lastCheckedAt !== undefined) row.lastCheckedAt = patch.lastCheckedAt;
  row.analyzed = row.analysisState === 'complete';
  assertInvariants(row);
  return row;
}
