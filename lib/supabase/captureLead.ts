import { createClient } from '@supabase/supabase-js';
import type { ScoreBand } from '@/lib/scanUtils';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Email-report capture (Lead Capture sprint). Distinct from logScanLead —
// that records every scan anonymously; this records an explicit, consented
// request for the report by email. No phone number is accepted anywhere in
// this flow and nothing here can trigger SMS.

const DEDUPE_WINDOW_HOURS = 24;

export { isValidEmail } from '@/lib/validation';

export interface CaptureLeadInput {
  email: string;
  url: string;
  scan_id?: string | null;
  score: number;
  band: ScoreBand;
  scanned_at?: string | null;
  registry_version?: string | null;
  prompt_version?: string | null;
  model?: string | null;
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  utm_content?: string | null;
  utm_term?: string | null;
}

export type CaptureLeadOutcome =
  | { ok: true; duplicate: boolean; degraded: boolean }
  | { ok: false; code: string };

// Full row shape — requires migration 005 (consent_ts, score_band,
// capture_meta). Until that migration is applied, inserts degrade to the
// legacy column set so a capture is never lost to a missing column.
export function buildLeadRow(input: CaptureLeadInput, consentTs: string) {
  return {
    url: input.url,
    email: input.email.trim().toLowerCase(),
    overall_score: input.score,
    score_band: input.band,
    consent_ts: consentTs,
    capture_meta: {
      scan_id: input.scan_id ?? null,
      scanned_at: input.scanned_at ?? null,
      registry_version: input.registry_version ?? null,
      prompt_version: input.prompt_version ?? null,
      model: input.model ?? null,
      consent_source: 'scan_email_report_v1',
    },
    utm_source: input.utm_source ?? null,
    utm_medium: input.utm_medium ?? null,
    utm_campaign: input.utm_campaign ?? null,
    utm_content: input.utm_content ?? null,
    utm_term: input.utm_term ?? null,
    created_at: consentTs,
  };
}

// Legacy fallback: only columns that exist in scan_leads today.
export function reduceRowForLegacySchema(row: ReturnType<typeof buildLeadRow>) {
  const { score_band: _band, consent_ts: _consent, capture_meta: _meta, ...legacy } = row;
  return legacy;
}

export async function captureLead(input: CaptureLeadInput): Promise<CaptureLeadOutcome> {
  const consentTs = new Date().toISOString();
  const email = input.email.trim().toLowerCase();

  try {
    // Duplicate prevention: same email + url inside the window is idempotent
    // success — no second row, and the caller must not queue a second email.
    const windowStart = new Date(Date.now() - DEDUPE_WINDOW_HOURS * 3600 * 1000).toISOString();
    const { data: existing, error: dupErr } = await supabase
      .from('scan_leads')
      .select('id')
      .eq('email', email)
      .eq('url', input.url)
      .gte('created_at', windowStart)
      .limit(1);

    if (!dupErr && existing && existing.length > 0) {
      return { ok: true, duplicate: true, degraded: false };
    }

    const row = buildLeadRow(input, consentTs);
    const { error } = await supabase.from('scan_leads').insert(row);

    if (!error) return { ok: true, duplicate: false, degraded: false };

    // PGRST204 = a payload column does not exist (migration 005 not applied
    // yet). Degrade to the legacy column set rather than losing the capture;
    // consent/metadata then live only in this function's log line until the
    // migration lands.
    if (error.code === 'PGRST204') {
      const { error: legacyError } = await supabase
        .from('scan_leads')
        .insert(reduceRowForLegacySchema(row));
      if (!legacyError) {
        console.warn('[captureLead] degraded insert (migration 005 not applied) — consent_ts:', consentTs);
        return { ok: true, duplicate: false, degraded: true };
      }
      console.error('[captureLead] legacy insert failed — code:', legacyError.code ?? 'unknown');
      return { ok: false, code: legacyError.code ?? 'unknown' };
    }

    console.error('[captureLead] insert failed — code:', error.code ?? 'unknown');
    return { ok: false, code: error.code ?? 'unknown' };
  } catch {
    console.error('[captureLead] transport failure');
    return { ok: false, code: 'transport' };
  }
}
