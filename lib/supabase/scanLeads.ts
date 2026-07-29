import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

export interface ScanLeadData {
  url: string;
  overall_score: number;
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  utm_content?: string | null;
  utm_term?: string | null;
}

export async function logScanLead(data: ScanLeadData): Promise<void> {
  const payload = {
    url: data.url,
    overall_score: data.overall_score,
    utm_source: data.utm_source ?? null,
    utm_medium: data.utm_medium ?? null,
    utm_campaign: data.utm_campaign ?? null,
    utm_content: data.utm_content ?? null,
    utm_term: data.utm_term ?? null,
    created_at: new Date().toISOString(),
  };

  const { error } = await supabase.from('scan_leads').insert(payload);

  // Log operation outcome only. The payload carries the scanned URL and UTM
  // attribution, and Postgres error messages echo offending row values, so
  // neither is safe to emit to function logs.
  if (error) {
    console.error('[scanLeads] insert failed — records: 1, code:', error.code ?? 'unknown');
  } else {
    console.log('[scanLeads] insert ok — records: 1');
  }
}
