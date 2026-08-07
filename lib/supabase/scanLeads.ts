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

/** Outcome of a lead-logging attempt. `code` is a SQLSTATE/PostgREST code or
 *  'transport' for a network-level failure — never a message or a row value. */
export type LogScanLeadResult =
  | { ok: true }
  | { ok: false; code: string };

/**
 * Records a scan lead. Never throws: lead logging is not on the critical path
 * for the scan response, so every failure mode is reported through the return
 * value instead of an exception.
 *
 * Logging is operation state, record count, and error code only. The payload
 * carries the scanned URL and UTM attribution, and Postgres error messages
 * echo offending row values, so neither is safe to emit to function logs.
 */
export async function logScanLead(data: ScanLeadData): Promise<LogScanLeadResult> {
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

  try {
    const { error } = await supabase.from('scan_leads').insert(payload);

    if (error) {
      const code = error.code ?? 'unknown';
      console.error('[scanLeads] insert failed — records: 1, code:', code);
      return { ok: false, code };
    }

    console.log('[scanLeads] insert ok — records: 1');
    return { ok: true };
  } catch {
    // Network/transport failure. Swallowed deliberately — the caller decides
    // what to do, and the scan response must not depend on this.
    console.error('[scanLeads] insert failed — records: 1, code:', 'transport');
    return { ok: false, code: 'transport' };
  }
}
