// Queues the emailed report through the existing audit pipeline
// (app.prequire.ai public-audit.php → cron → email). scan_id ties the email to
// the exact result shown on screen; without it the cron re-scans with a second engine.
export const PUBLIC_AUDIT_URL = 'https://app.prequire.ai/api/audit/public-audit.php';

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

// Never throws: a queue failure must not affect the on-screen scan.
export async function queueEmailReport(
  job: ReportJob,
  fetchImpl: (url: string, init: RequestInit) => Promise<{ ok: boolean }> = fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl(PUBLIC_AUDIT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(job),
    });
    return res.ok;
  } catch {
    return false;
  }
}
