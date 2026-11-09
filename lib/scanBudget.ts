// Cost controls for the anonymous /api/scan (one paid model call per scan).
// Both read the existing scan_results table (url, source, created_at; indexed on
// created_at and source), so no migration is needed. Per-IP throttling is left to
// the edge (Vercel Firewall rate-limit rule), where serverless instances share state.
import { getServiceClient } from '@/lib/supabase/serviceClient';
import type { ScanResult } from '@/lib/scanPrompt';

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Ceiling on paid public scans per rolling 24 h. Env-tunable without a deploy of code. */
export const PUBLIC_SCAN_DAILY_CAP = positiveInt(process.env.SCAN_PUBLIC_DAILY_CAP, 300);

/** A repeat scan of the same URL inside this window reuses the stored result (no model call). */
export const SCAN_REUSE_MINUTES = 15;

export type BudgetDecision = { ok: true } | { ok: false; reason: 'cap_reached' | 'unavailable' };

/** Fails closed: if the count cannot be read, no paid call is made. */
export async function checkDailyBudget(cap = PUBLIC_SCAN_DAILY_CAP): Promise<BudgetDecision> {
  try {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { count, error } = await getServiceClient()
      .from('scan_results')
      .select('scan_id', { count: 'exact', head: true })
      .eq('source', 'public')
      .gte('created_at', since);
    if (error || typeof count !== 'number') return { ok: false, reason: 'unavailable' };
    return count >= cap ? { ok: false, reason: 'cap_reached' } : { ok: true };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

/** Most recent public scan of exactly this URL inside the reuse window, or null (a miss is always safe). */
export async function findRecentScan(
  url: string,
): Promise<{ scan_id: string; result: ScanResult } | null> {
  try {
    const since = new Date(Date.now() - SCAN_REUSE_MINUTES * 60 * 1000).toISOString();
    const { data, error } = await getServiceClient()
      .from('scan_results')
      .select('scan_id, result_json')
      .eq('url', url)
      .eq('source', 'public')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    return { scan_id: data.scan_id as string, result: data.result_json as ScanResult };
  } catch {
    return null;
  }
}
