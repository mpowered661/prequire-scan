export type DiscoveryMethod =
  | 'seed' | 'robots_sitemap' | 'sitemap' | 'sitemap_index' | 'wp_convention';

export type FetchState =
  | 'not_attempted' | 'fetched' | 'redirected' | 'blocked' | 'failed' | 'skipped';

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
  firstSeenAt: string;
}

export class Inventory {
  private readonly rows = new Map<string, InventoryUrl>();
  duplicatesSuppressed = 0;

  add(row: InventoryUrl): boolean {
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

  list(): InventoryUrl[] {
    return [...this.rows.values()];
  }
}

export function assertInvariants(row: InventoryUrl): void {
  if (row.analyzed && row.fetchState !== 'fetched') {
    throw new Error('analyzed_requires_fetched');
  }
}
