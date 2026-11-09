import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PUBLIC_AUDIT_URL, reportJobFor, queueEmailReport } from './reportQueue';

describe('reportJobFor', () => {
  it('returns null when no email was passed (results-only visitors)', () => {
    expect(reportJobFor({ email: '', name: '', url: 'https://a.com', scanId: 's1' })).toBeNull();
    expect(reportJobFor({ email: '   ', name: '', url: 'https://a.com', scanId: 's1' })).toBeNull();
  });

  it('builds the public-audit job with the trimmed email and the on-screen scan_id', () => {
    expect(reportJobFor({ email: ' a@b.com ', name: 'Ann', url: 'https://a.com', scanId: 's1' }))
      .toEqual({ url: 'https://a.com', email: 'a@b.com', name: 'Ann', scan_id: 's1' });
  });

  it('sends scan_id null when the scan was not persisted', () => {
    expect(reportJobFor({ email: 'a@b.com', name: '', url: 'https://a.com', scanId: null })?.scan_id).toBeNull();
  });
});

describe('queueEmailReport', () => {
  const job = { url: 'https://a.com', email: 'a@b.com', name: '', scan_id: 's1' };

  it('POSTs JSON to public-audit.php and reports success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    expect(await queueEmailReport(job, fetchImpl)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(PUBLIC_AUDIT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(job),
    });
  });

  it('reports failure on a non-2xx (429 cap, 403, 503) without throwing', async () => {
    expect(await queueEmailReport(job, vi.fn().mockResolvedValue({ ok: false }))).toBe(false);
  });

  it('reports failure on a network error without throwing', async () => {
    expect(await queueEmailReport(job, vi.fn().mockRejectedValue(new Error('offline')))).toBe(false);
  });
});

// Regression pin for the 2026-11-09 defect: a homepage visitor arrives at
// /overview with ?email=, the email form is hidden, and nothing queued the report.
describe('/overview queues the emailed report for visitors who arrived with an email', () => {
  const src = readFileSync(path.join(process.cwd(), 'app/overview/page.tsx'), 'utf8');

  it('calls queueEmailReport when the email param is present', () => {
    expect(src).toMatch(/import \{[^}]*queueEmailReport[^}]*\} from '@\/lib\/reportQueue'/);
    expect(src).toMatch(/reportJobFor\(\{\s*email: searchParams\.get\('email'\)/);
    expect(src).toMatch(/queueEmailReport\(job\)/);
  });

  it('queues at most once per page load', () => {
    expect(src).toMatch(/reportQueued\.current = true/);
  });

  it('still hides the second email prompt for those visitors', () => {
    expect(src).toMatch(/cit\.status === 'done' && !searchParams\.get\('email'\)/);
  });
});
