// Queues the emailed report through the existing audit pipeline
// (app.prequire.ai public-audit.php → cron → email). scan_id ties the email to
// the exact result shown on screen; without it the cron re-scans with a second engine.
export const PUBLIC_AUDIT_URL = 'https://app.prequire.ai/api/audit/public-audit.php';

type FetchLike = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;

export interface ReportJob {
  url: string;
  email: string;
  name: string;
  scan_id: string | null;
}

export function reportJobFor(input: {
  email: string | null;
  name: string | null;
  url: string;
  scanId: string | null;
}): ReportJob | null {
  const email = (input.email ?? '').trim();
  if (!email) return null;
  return { url: input.url, email, name: input.name ?? '', scan_id: input.scanId };
}

export type QueueOutcome = 'queued' | 'limited' | 'failed';

// Never throws: a queue failure must not affect the on-screen scan.
// The queue's ledger is the authority on duplicates: a repeat for an address + site
// whose report is already queued or accepted answers 'queued' and sends nothing.
export async function queueEmailReport(job: ReportJob, fetchImpl: FetchLike = fetch): Promise<QueueOutcome> {
  try {
    const res = await fetchImpl(PUBLIC_AUDIT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(job),
    });
    if (res.ok) return 'queued';
    return res.status === 429 ? 'limited' : 'failed';
  } catch {
    return 'failed';
  }
}

export type ReportRequestOutcome =
  | { status: 'queued' }
  | { status: 'no_scan' }
  | { status: 'limited' }
  | { status: 'failed'; step: 'consent' | 'queue' };

/**
 * Report requested on the prequire.ai homepage form (arrives as ?email=).
 * 1. Requires a stored scan, so the email matches what is on screen.
 * 2. Records the consent first (report-only scope); no record, no email.
 * 3. Queues the email. Safe to call again after a failure.
 */
export async function requestHomepageReport(
  input: {
    email: string;
    name: string | null;
    url: string;
    scanId: string | null;
    score: number;
    utm?: Record<string, string | null>;
  },
  fetchImpl: FetchLike = fetch,
): Promise<ReportRequestOutcome> {
  const job = reportJobFor(input);
  if (!job) return { status: 'failed', step: 'consent' };
  if (!input.scanId) return { status: 'no_scan' };

  try {
    const res = await fetchImpl('/api/capture-lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: job.email,
        url: input.url,
        score: input.score,
        scan_id: input.scanId,
        consent_source: 'homepage_audit_form_v1',
        ...(input.utm ?? {}),
      }),
    });
    // A duplicate capture (200, duplicate:true) is consent already on record: continue.
    if (!res.ok) return { status: 'failed', step: 'consent' };
  } catch {
    return { status: 'failed', step: 'consent' };
  }

  const q = await queueEmailReport(job, fetchImpl);
  if (q === 'queued') return { status: 'queued' };
  if (q === 'limited') return { status: 'limited' };
  return { status: 'failed', step: 'queue' };
}
