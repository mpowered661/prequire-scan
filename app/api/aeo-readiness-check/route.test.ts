import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const { buildReportMock, serviceClientMock } = vi.hoisted(() => ({
  buildReportMock: vi.fn(),
  serviceClientMock: vi.fn(),
}));
vi.mock('@/lib/aeo-readiness/report-builder', () => ({ buildReport: buildReportMock }));
vi.mock('@/lib/supabase/serviceClient', () => ({ getServiceClient: serviceClientMock }));

import { POST } from './route';

const req = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  ({ json: async () => body, headers: { get: (k: string) => headers[k.toLowerCase()] ?? null } }) as unknown as NextRequest;

beforeEach(() => {
  buildReportMock.mockReset();
  serviceClientMock.mockReset();
});

// The readiness check fetches the target 16+ times (crawler UAs, robots.txt,
// llms.txt). It must not be a way around the egress guard on /api/scan.
describe('POST /api/aeo-readiness-check — egress guard', () => {
  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1/',
    'http://localhost/', // resolves to loopback: refused by the DNS pre-check
    'http://localhost.localdomain.127.0.0.1.nip.io.invalid:22/',
    'http://10.0.0.1/',
    'http://[::1]/',
    'http://2130706433/',
    'https://example.com:8443/',
    'http://user:pw@example.com/',
  ])('refuses %s with 400 before any fetch, DB or report work', async (url) => {
    const res = await POST(req({ url }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(String(body.error)).not.toMatch(/169\.254|127\.0|10\.0|ECONN/);
    expect(buildReportMock).not.toHaveBeenCalled();
    expect(serviceClientMock).not.toHaveBeenCalled();
  });

  it('study mode cannot skip the guard', async () => {
    process.env.STUDY_MODE_TOKEN = 'study-tok';
    const res = await POST(req({ url: 'http://169.254.169.254/', study: true }, { 'x-study-token': 'study-tok' }));
    expect(res.status).toBe(400);
    expect(buildReportMock).not.toHaveBeenCalled();
    delete process.env.STUDY_MODE_TOKEN;
  });
});
