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

  console.log('[scanLeads] inserting:', JSON.stringify(payload, null, 2));

  const { error } = await supabase.from('scan_leads').insert(payload);

  console.log('[scanLeads] insert result — error:', error ? JSON.stringify(error) : null);

  if (error) {
    console.error('[scanLeads] Supabase insert error:', error.message);
  }
}
