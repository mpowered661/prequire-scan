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
}

export type { CoverageManifest, DiscoveryMethod, InventoryUrl };
