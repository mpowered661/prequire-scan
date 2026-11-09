import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PUBLIC_AUDIT_URL, reportJobFor, queueEmailReport, requestHomepageReport } from './reportQueue';

const ok = (status = 200) => ({ ok: status >= 200 && status < 300, status });

describe('reportJobFor', () => {
  it('returns null when no email was passed (results-only visitors)', () => {
    expect(reportJobFor({ email: '', name: '', url: 'https://a.com', scanId: 's1' })).toBeNull();
    expect(reportJobFor({ email: '   ', name: '', url: 'https://a.com', scanId: 's1' })).toBeNull();
  });

  it('builds the public-audit job with the trimmed email and the on-screen scan_id', () => {
    expect(reportJobFor({ email: ' a@b.com ', name: 'Ann', url: 'https://a.com', scanId: 's1' }))
      .toEqual({ url: 'https://a.com', email: 'a@b.com', name: 'Ann', scan_id: 's1' });
  });
});

describe('queueEmailReport', () => {
  const job = { url: 'https://a.com', email: 'a@b.com', name: '', scan_id: 's1' };

  it('POSTs JSON to public-audit.php', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok());
    expect(await queueEmailReport(job, fetchImpl)).toBe('queued');
    expect(fetchImpl).toHaveBeenCalledWith(PUBLIC_AUDIT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(job),
    });
  });

  it('distinguishes the queue limit (429) from other failures, without throwing', async () => {
    expect(await queueEmailReport(job, vi.fn().mockResolvedValue(ok(429)))).toBe('limited');
    expect(await queueEmailReport(job, vi.fn().mockResolvedValue(ok(503)))).toBe('failed');
    expect(await queueEmailReport(job, vi.fn().mockRejectedValue(new Error('offline')))).toBe('failed');
  });
});

describe('requestHomepageReport', () => {
  const input = { email: 'a@b.com', name: null, url: 'https://a.com/', scanId: 's1', score: 62 };

  it('records consent (report-only source) BEFORE queuing, then queues the on-screen scan', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok());
    expect(await requestHomepageReport(input, fetchImpl)).toEqual({ status: 'queued' });
    const [first, second] = fetchImpl.mock.calls;
    expect(first[0]).toBe('/api/capture-lead');
    expect(JSON.parse(first[1].body)).toMatchObject({ email: 'a@b.com', scan_id: 's1', consent_source: 'homepage_audit_form_v1' });
    expect(second[0]).toBe(PUBLIC_AUDIT_URL);
    expect(JSON.parse(second[1].body)).toEqual({ url: 'https://a.com/', email: 'a@b.com', name: '', scan_id: 's1' });
  });

  it('sends nothing if the consent record fails', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(ok(500));
    expect(await requestHomepageReport(input, fetchImpl)).toEqual({ status: 'failed', step: 'consent' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('sends nothing without a stored scan (the email must match the screen)', async () => {
    const fetchImpl = vi.fn();
    expect(await requestHomepageReport({ ...input, scanId: null }, fetchImpl)).toEqual({ status: 'no_scan' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a duplicate consent capture still reaches the queue, whose ledger decides (so a failed send is retryable)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok());
    await requestHomepageReport(input, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('reports a queue failure and a queue limit distinctly', async () => {
    expect(await requestHomepageReport(input, vi.fn().mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok(503))))
      .toEqual({ status: 'failed', step: 'queue' });
    expect(await requestHomepageReport(input, vi.fn().mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok(429))))
      .toEqual({ status: 'limited' });
  });
});

// Regression pin for the 2026-11-09 defect: a homepage visitor arrives at
// /overview with ?email=, the email form is hidden, and nothing queued the report.
describe('/overview requests the emailed report for visitors who arrived with an email', () => {
  const src = readFileSync(path.join(process.cwd(), 'app/overview/page.tsx'), 'utf8');

  it('calls requestHomepageReport with the email param and the on-screen scan', () => {
    expect(src).toMatch(/import \{[^}]*requestHomepageReport[^}]*\} from '@\/lib\/reportQueue'/);
    expect(src).toMatch(/requestHomepageReport\(\{\s*email: homepageEmail/);
    expect(src).toMatch(/scanId: cit\.scanId/);
  });

  it('requests at most once per page load, with an explicit retry', () => {
    expect(src).toMatch(/reportRequested\.current = true/);
    expect(src).toMatch(/Try again/);
  });

  it('announces the outcome in a polite live region', () => {
    expect(src).toMatch(/role="status"/);
  });

  it('still hides the second email prompt for those visitors', () => {
    expect(src).toMatch(/cit\.status === 'done' && !searchParams\.get\('email'\)/);
  });
});
