import { createClient } from '@supabase/supabase-js';
import type { AeoReadinessReport } from '@/lib/aeo-readiness/types';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

export interface ReadinessCheckRow {
  check_id: string;
  url: string;
  score: number;
  report: AeoReadinessReport;
  tested_at: string;
}

export async function getReadinessCheck(checkId: string): Promise<ReadinessCheckRow | null> {
  const { data, error } = await supabase
    .from('aeo_readiness_checks')
    .select('check_id, url, score, report, tested_at')
    .eq('check_id', checkId)
    .single();

  if (error || !data) return null;
  return data as ReadinessCheckRow;
}
