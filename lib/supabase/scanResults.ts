import { getServiceClient } from '@/lib/supabase/serviceClient';
import { ScanResult } from '@/lib/scanPrompt';

export interface ScanResultData {
  url: string;
  overall_score: number;
  result_json: ScanResult;
  email?: string | null;
  source?: string;
  ghl_contact_id?: string | null;
}

export async function saveScanResult(data: ScanResultData): Promise<string> {
  const supabase = getServiceClient();
  const { data: row, error } = await supabase
    .from('scan_results')
    .insert({
      url: data.url,
      overall_score: data.overall_score,
      result_json: data.result_json,
      email: data.email ?? null,
      source: data.source ?? 'public',
      ghl_contact_id: data.ghl_contact_id ?? null,
    })
    .select('scan_id')
    .single();

  if (error || !row) {
    console.error('[scanResults] Supabase insert error:', error?.message);
    throw new Error('Failed to persist scan result');
  }

  return row.scan_id as string;
}

export async function getScanResult(scanId: string): Promise<{
  scan_id: string;
  url: string;
  overall_score: number;
  result_json: ScanResult;
  created_at: string;
} | null> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from('scan_results')
    .select('scan_id, url, overall_score, result_json, created_at')
    .eq('scan_id', scanId)
    .single();

  if (error || !data) return null;
  return data as {
    scan_id: string;
    url: string;
    overall_score: number;
    result_json: ScanResult;
    created_at: string;
  };
}
