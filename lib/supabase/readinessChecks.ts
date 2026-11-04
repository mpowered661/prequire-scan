import { getServiceClient } from '@/lib/supabase/serviceClient';
import type { AeoReadinessReport } from '@/lib/aeo-readiness/types';

export interface ReadinessCheckRow {
  check_id: string;
  url: string;
  score: number;
  report: AeoReadinessReport;
  tested_at: string;
}

export async function getReadinessCheck(checkId: string): Promise<ReadinessCheckRow | null> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from('aeo_readiness_checks')
    .select('check_id, url, score, report, tested_at')
    .eq('check_id', checkId)
    .single();

  if (error || !data) return null;
  return data as ReadinessCheckRow;
}
