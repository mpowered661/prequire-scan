// "Fix these gaps" destination. Until the /fix/{scan_id} journey exists, the
// button opens a pre-filled email so the request carries the scanned domain and
// the report links — never a generic page that drops the scan context.
export const FIX_REQUEST_EMAIL = 'david@prequire.ai';
const SCAN_ORIGIN = 'https://scan.prequire.ai';

// Report ids are UUIDs; anything else is dropped rather than put into a link.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function hostnameOf(url: string): string {
  try {
    return new URL(url.startsWith('http') ? url : `https://${url}`).hostname;
  } catch {
    return '';
  }
}

export function fixHref(input: { url: string; scanId?: string | null; checkId?: string | null }): string {
  const domain = hostnameOf(input.url);
  const lines = [
    'Hi David,',
    '',
    `I ran a Prequire scan${domain ? ` for ${domain}` : ''} and would like help fixing the gaps it found.`,
    '',
  ];
  if (input.scanId && UUID.test(input.scanId)) lines.push(`Citation report: ${SCAN_ORIGIN}/report/${input.scanId}`);
  if (input.checkId && UUID.test(input.checkId)) lines.push(`Crawler visibility report: ${SCAN_ORIGIN}/readiness/${input.checkId}`);
  lines.push('', 'Thanks,');

  const subject = `Fix the gaps on ${domain || 'my site'}`;
  return `mailto:${FIX_REQUEST_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join('\n'))}`;
}
