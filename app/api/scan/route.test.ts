import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';

const { createMock, logScanLeadMock, saveScanResultMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  logScanLeadMock: vi.fn(),
  saveScanResultMock: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: createMock };
  },
}));

vi.mock('@/lib/supabase/scanLeads', () => ({ logScanLead: logScanLeadMock }));
vi.mock('@/lib/supabase/scanResults', () => ({ saveScanResult: saveScanResultMock }));

import { POST } from './route';

const SCAN_RESULT = {
  overallScore: 71,
  categories: { content: { score: 70 } },
};

/** Minimal stand-in for the only two NextRequest members the route touches. */
function makeRequest(body: Record<string, unknown>): NextRequest {
  return {
    headers: { get: () => null },
    json: async () => body,
  } as unknown as NextRequest;
}

/** Drain the NDJSON stream into an array of parsed events. */
async function readEvents(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  createMock.mockReset();
  logScanLeadMock.mockReset();
  saveScanResultMock.mockReset();

  vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  // Page fetch succeeds with minimal HTML.
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '<html><body><h1>Test</h1></body></html>',
    }),
  );

  createMock.mockResolvedValue({
    content: [{ type: 'text', text: JSON.stringify(SCAN_RESULT) }],
    stop_reason: 'end_turn',
  });

  saveScanResultMock.mockResolvedValue('scan-id-1');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('POST /api/scan — lead logging is non-fatal', () => {
  it('completes the scan when lead logging succeeds', async () => {
    logScanLeadMock.mockResolvedValue({ ok: true });

    const events = await readEvents(await POST(makeRequest({ url: 'example.com' })));
    const stages = events.map((e) => e.stage);

    expect(stages).toContain('complete');
    expect(stages).not.toContain('error');
  });

  it('still completes the scan when lead logging returns a failure', async () => {
    logScanLeadMock.mockResolvedValue({ ok: false, code: 'PGRST204' });

    const events = await readEvents(await POST(makeRequest({ url: 'example.com' })));
    const complete = events.find((e) => e.stage === 'complete');

    expect(complete).toBeDefined();
    expect(events.map((e) => e.stage)).not.toContain('error');
    // Result payload is intact — the failure did not degrade the response.
    expect((complete!.data as { result: unknown }).result).toEqual(SCAN_RESULT);
  });

  it('surfaces the failure through safe operational logging only', async () => {
    logScanLeadMock.mockResolvedValue({ ok: false, code: 'PGRST204' });

    await readEvents(await POST(makeRequest({ url: 'example.com' })));

    expect(errorSpy).toHaveBeenCalledWith(
      '[scan] lead logging failed (non-fatal), code:',
      'PGRST204',
    );
  });

  it('still completes the scan when lead logging throws', async () => {
    logScanLeadMock.mockRejectedValue(new Error('unexpected'));

    const events = await readEvents(await POST(makeRequest({ url: 'example.com' })));
    const stages = events.map((e) => e.stage);

    expect(stages).toContain('complete');
    expect(stages).not.toContain('error');
    expect(errorSpy).toHaveBeenCalledWith('[scan] lead logging threw (non-fatal)');
  });

  it('forwards utm_content and utm_term to the lead logger', async () => {
    logScanLeadMock.mockResolvedValue({ ok: true });

    await readEvents(
      await POST(
        makeRequest({
          url: 'example.com',
          utm_content: 'variant-b',
          utm_term: 'dental seo wichita',
        }),
      ),
    );

    expect(logScanLeadMock).toHaveBeenCalledWith(
      expect.objectContaining({ utm_content: 'variant-b', utm_term: 'dental seo wichita' }),
    );
  });
});
