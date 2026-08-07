import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';

const { captureLeadMock } = vi.hoisted(() => ({ captureLeadMock: vi.fn() }));

// Fully mocked — the real module creates a Supabase client at import time.
// isValidEmail lives in lib/validation (pure) and is NOT mocked.
vi.mock('@/lib/supabase/captureLead', () => ({ captureLead: captureLeadMock }));

import { POST } from './route';

function makeRequest(body: unknown): NextRequest {
  return {
    headers: { get: () => null },
    json: async () => body,
  } as unknown as NextRequest;
}

beforeEach(() => {
  captureLeadMock.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/capture-lead', () => {
  it('accepts a valid capture and reports non-duplicate', async () => {
    captureLeadMock.mockResolvedValue({ ok: true, duplicate: false, degraded: false });

    const res = await POST(
      makeRequest({ email: 'a@b.co', url: 'example.com', score: 72, scan_id: 's-1' }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, duplicate: false });
    expect(captureLeadMock).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'a@b.co',
        url: 'https://example.com/',
        score: 72,
        band: 'strong',
      }),
    );
  });

  it('rejects an invalid email with 400', async () => {
    const res = await POST(makeRequest({ email: 'not-an-email', url: 'example.com', score: 50 }));
    expect(res.status).toBe(400);
    expect(captureLeadMock).not.toHaveBeenCalled();
  });

  it('rejects a missing url with 400', async () => {
    const res = await POST(makeRequest({ email: 'a@b.co', score: 50 }));
    expect(res.status).toBe(400);
  });

  it('rejects a missing score with 400', async () => {
    const res = await POST(makeRequest({ email: 'a@b.co', url: 'example.com' }));
    expect(res.status).toBe(400);
  });

  it('reports duplicates idempotently (200, duplicate:true)', async () => {
    captureLeadMock.mockResolvedValue({ ok: true, duplicate: true, degraded: false });

    const res = await POST(makeRequest({ email: 'a@b.co', url: 'example.com', score: 30 }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, duplicate: true });
  });

  it('fails safely (500 + gentle message) when storage fails — never throws', async () => {
    captureLeadMock.mockResolvedValue({ ok: false, code: 'transport' });

    const res = await POST(makeRequest({ email: 'a@b.co', url: 'example.com', score: 30 }));

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toContain('try again');
  });

  it('derives band from score at the API boundary', async () => {
    captureLeadMock.mockResolvedValue({ ok: true, duplicate: false, degraded: false });

    await POST(makeRequest({ email: 'a@b.co', url: 'example.com', score: 44 }));

    expect(captureLeadMock).toHaveBeenCalledWith(expect.objectContaining({ band: 'weak' }));
  });

  it('ignores phone-shaped fields entirely — no phone data ever reaches storage', async () => {
    captureLeadMock.mockResolvedValue({ ok: true, duplicate: false, degraded: false });

    await POST(
      makeRequest({
        email: 'a@b.co',
        url: 'example.com',
        score: 60,
        phone: '+1 555 000 1111',
        phone_number: '5550001111',
        sms_opt_in: true,
      }),
    );

    const forwarded = JSON.stringify(captureLeadMock.mock.calls[0][0]).toLowerCase();
    expect(forwarded).not.toContain('phone');
    expect(forwarded).not.toContain('sms');
    expect(forwarded).not.toContain('555');
  });
});
