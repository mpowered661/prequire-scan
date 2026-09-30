import { createClient } from '@supabase/supabase-js';
import type { CoverageManifest, InventoryUrl } from '@/lib/site-discovery/types';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

export async function insertSiteScan(manifest: CoverageManifest): Promise<{ ok: true } | { ok: false; code: string }> {
  const row = {
    scan_id: manifest.scan_id,
    seed_url: manifest.seed_url,
    domain: manifest.domain,
    scan_mode: manifest.scan_mode,
    status: manifest.status,
    manifest,
    discovery_version: manifest.method.discovery_version,
    normalization_version: manifest.method.normalization_version,
    started_at: manifest.started_at,
    completed_at: manifest.completed_at,
  };

  try {
    const { error } = await supabase.from('site_scans').insert(row);
    if (error) return { ok: false, code: error.code ?? 'unknown' };
    return { ok: true };
  } catch {
    return { ok: false, code: 'transport' };
  }
}

export async function insertScanUrls(scanId: string, urls: InventoryUrl[]): Promise<{ ok: true } | { ok: false; code: string }> {
  for (const url of urls) {
    if (url.analyzed && url.fetchState !== 'fetched') {
      return { ok: false, code: 'invariant_violation' };
    }
  }

  const rows = urls.map(url => ({
    scan_id: scanId,
    url_raw: url.urlRaw,
    url_normalized: url.urlNormalized,
    discovery_method: url.discoveryMethod,
    discovered_from_url: url.discoveredFromUrl,
    sitemap_source_url: url.sitemapSourceUrl,
    link_depth: url.linkDepth,
    in_scope: url.inScope,
    excluded_reason: url.excludedReason,
    fetch_state: url.fetchState,
    http_status: url.httpStatus,
    analyzed: url.analyzed,
    first_seen_at: url.firstSeenAt,
  }));

  try {
    const { error } = await supabase.from('scan_urls').insert(rows);
    if (error) return { ok: false, code: error.code ?? 'unknown' };
    return { ok: true };
  } catch {
    return { ok: false, code: 'transport' };
  }
}
