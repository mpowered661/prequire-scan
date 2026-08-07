import { createHash } from 'crypto';

// Non-production study mode (Sprint Alpha, scanner-audit-addendum-2026-08-06).
// A study request runs the identical analysis pipeline but with ZERO production
// side effects: no row persisted, no lead created, no email stored, no GHL
// linkage, no downstream workflow can trigger. The response carries a
// deterministic evidence envelope so the study runner can export reproducible
// records. Fail-closed: requesting study mode without a valid token is an
// error, never a silent fallback to production behavior.

export type StudyAuth = 'not_requested' | 'authorized' | 'rejected';

export function resolveStudyAuth(
  studyFlag: unknown,
  headerToken: string | null,
  envToken: string | undefined,
): StudyAuth {
  if (studyFlag !== true) return 'not_requested';
  if (!envToken || !headerToken || headerToken !== envToken) return 'rejected';
  return 'authorized';
}

export interface StudyEnvelope {
  mode: 'study';
  fetched_at: string;
  input_url: string;
  html_bytes: number;
  html_sha256: string;
  versions: Record<string, string>;
  persisted: false;
}

export function buildStudyEnvelope(
  inputUrl: string,
  html: string,
  versions: Record<string, string>,
): StudyEnvelope {
  return {
    mode: 'study',
    fetched_at: new Date().toISOString(),
    input_url: inputUrl,
    html_bytes: Buffer.byteLength(html, 'utf8'),
    html_sha256: createHash('sha256').update(html, 'utf8').digest('hex'),
    versions,
    persisted: false,
  };
}
