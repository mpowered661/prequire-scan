import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';

const { createMock, logScanLeadMock, saveScanResultMock, buildResilienceMock, safeFetchMock, claimMock, findRecentMock } = vi.hoisted(() => ({
  safeFetchMock: vi.fn(),
  claimMock: vi.fn(),
  findRecentMock: vi.fn(),
  createMock: vi.fn(),
  logScanLeadMock: vi.fn(),
  saveScanResultMock: vi.fn(),
  buildResilienceMock: vi.fn(),
}));

// Spied, but running the real deterministic implementation — the assertions
// below are about genuine engine output, not a stub. Only the failure test
// swaps in a throw, to prove the route degrades without losing the scan.
vi.mock('@/lib/extraction-resilience', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/extraction-resilience')>();
  buildResilienceMock.mockImplementation(actual.buildExtractionResilience);
  return { ...actual, buildExtractionResilience: buildResilienceMock };
});

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: createMock };
  },
}));

vi.mock('@/lib/supabase/scanLeads', () => ({ logScanLead: logScanLeadMock }));
vi.mock('@/lib/supabase/scanResults', () => ({ saveScanResult: saveScanResultMock }));
// Real validateTarget/EgressError; only the network hop is replaced.
vi.mock('@/lib/egress', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/egress')>();
  // Static policy is real; the DNS pre-check is skipped so tests make no network lookups.
  return { ...actual, safeFetch: safeFetchMock, assertPublicTarget: async (u: string) => actual.validateTarget(u) };
});
vi.mock('@/lib/scanBudget', () => ({ claimPaidScan: claimMock, findRecentScan: findRecentMock }));

import { POST } from './route';

// Contract-valid ScanResult fixture: the route's shape guard requires all four
// category scores, and overallScore is recomputed server-side as the mean of
// content/schema/performance (accessibility excluded) → (70+80+90)/3 = 80.
const cat = (score: number) => ({ score, checks: [], recommendations: [] });
const a11yCheck = (status: string) => ({ label: 'x', status, detail: '' });
const SCAN_RESULT = {
  overallScore: 71, // model's own number — deliberately ignored by the route
  summary: 'Test summary.',
  categories: {
    contentQuality: cat(70),
    schemaMarkup: cat(80),
    performance: cat(90),
    // model claims 10; server recomputes from statuses:
    // pass+pass+warn+pass = 24+24+12+24 = 84, no bonus
    accessibility: {
      score: 10,
      checks: [
        a11yCheck('pass'), a11yCheck('pass'), a11yCheck('warn'), a11yCheck('pass'),
        a11yCheck('not_assessable'), a11yCheck('not_assessable'),
      ],
      recommendations: [],
    },
  },
};
const EXPECTED_OVERALL = 80;
const EXPECTED_A11Y = null; // accessibility is never scored (2026-11-11)

/** Minimal stand-in for the only two NextRequest members the route touches. */
function makeRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): NextRequest {
  return {
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
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

  // Page fetch succeeds with minimal HTML; budget open; no recent scan to reuse.
  safeFetchMock.mockReset();
  safeFetchMock.mockImplementation(async () => new Response('<html><body><h1>Test</h1></body></html>', { status: 200 }));
  claimMock.mockReset();
  claimMock.mockResolvedValue({ ok: true });
  findRecentMock.mockReset();
  findRecentMock.mockResolvedValue(null);

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

describe('POST /api/scan — result is never gated on email', () => {
  it('completes a scan with no email anywhere in the request', async () => {
    logScanLeadMock.mockResolvedValue({ ok: true });

    const events = await readEvents(await POST(makeRequest({ url: 'example.com' })));
    const complete = events.find((e) => e.stage === 'complete');

    expect(complete).toBeDefined();
    // Full result delivered to an anonymous visitor — no email required.
    const result = (complete!.data as { result: { categories: Record<string, { score: number }> } }).result;
    expect(result.categories.contentQuality).toEqual(SCAN_RESULT.categories.contentQuality);
    expect(result.categories.accessibility.score).toBe(EXPECTED_A11Y);
    expect(saveScanResultMock).toHaveBeenCalledWith(expect.objectContaining({ email: null }));
  });
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
    // overallScore and the accessibility category score are server-side
    // recomputes; scan_meta is stamped; everything else passes through.
    const result = (complete!.data as { result: { categories: Record<string, { score: number }> } & Record<string, unknown> }).result;
    expect(result.categories.contentQuality).toEqual(SCAN_RESULT.categories.contentQuality);
    expect(result.categories.accessibility.score).toBe(EXPECTED_A11Y);
    expect(result.overallScore).toBe(EXPECTED_OVERALL);
    expect(result.scan_meta).toMatchObject({
      overall_score_basis: 'content_schema_performance_mean',
    });
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

  it('attaches an extraction resilience result without touching existing scores', async () => {
    logScanLeadMock.mockResolvedValue({ ok: true });

    const events = await readEvents(await POST(makeRequest({ url: 'example.com' })));
    const result = (events.find((e) => e.stage === 'complete')!.data as {
      result: Record<string, { score?: number } & Record<string, unknown>> & {
        overallScore: number;
        extraction_resilience?: { band: string; meta: Record<string, unknown> };
        categories: Record<string, { score: number }>;
      };
    }).result;

    // Present, deterministic, and honest about what it did not do.
    expect(result.extraction_resilience).toBeDefined();
    expect(result.extraction_resilience!.meta).toMatchObject({
      increment: 1,
      vision_assessed: false,
      scoring: 'deterministic_band_rules',
    });

    // The headline score and every existing category are byte-for-byte what
    // they were before this feature existed.
    expect(result.overallScore).toBe(EXPECTED_OVERALL);
    expect(result.categories.contentQuality).toEqual(SCAN_RESULT.categories.contentQuality);
    expect(result.categories.schemaMarkup).toEqual(SCAN_RESULT.categories.schemaMarkup);
    expect(result.categories.performance).toEqual(SCAN_RESULT.categories.performance);
    expect(result.categories.accessibility.score).toBe(EXPECTED_A11Y);
  });

  it('is not part of the overall score even when the page is fragile', async () => {
    logScanLeadMock.mockResolvedValue({ ok: true });
    // A page whose numbers lose every qualifier still cannot move overallScore.
    safeFetchMock.mockResolvedValueOnce(new Response(
      '<html><body><table><caption>In $ millions</caption>' +
        '<thead><tr><th>Region</th><th>2025</th><th>2026</th></tr></thead>' +
        '<tbody><tr><th>North</th><td>4.2</td><td>5.1</td></tr></tbody></table></body></html>',
      { status: 200 },
    ));

    const events = await readEvents(await POST(makeRequest({ url: 'example.com' })));
    const result = (events.find((e) => e.stage === 'complete')!.data as {
      result: { overallScore: number; extraction_resilience?: { band: string } };
    }).result;

    expect(result.extraction_resilience!.band).toBe('fragile');
    expect(result.overallScore).toBe(EXPECTED_OVERALL);
  });

  it('still completes the scan when resilience analysis throws', async () => {
    logScanLeadMock.mockResolvedValue({ ok: true });
    buildResilienceMock.mockImplementationOnce(() => {
      throw new Error('extractor exploded');
    });

    const events = await readEvents(await POST(makeRequest({ url: 'example.com' })));
    const complete = events.find((e) => e.stage === 'complete');
    const result = (complete!.data as { result: Record<string, unknown> }).result;

    expect(complete).toBeDefined();
    expect(events.map((e) => e.stage)).not.toContain('error');
    // The scan is delivered in full; only the resilience block is absent.
    expect(result.extraction_resilience).toBeUndefined();
    expect(result.overallScore).toBe(EXPECTED_OVERALL);
    expect(errorSpy).toHaveBeenCalledWith(
      '[scan] extraction resilience failed (non-fatal):',
      expect.any(Error),
    );
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

describe('POST /api/scan — egress guard (SSRF)', () => {
  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1/',
    'http://10.0.0.1/admin',
    'http://[::1]/',
    'http://2130706433/',
    'https://example.com:6379/',
    'file:///etc/passwd',
  ])('refuses %s before any fetch or model call', async (url) => {
    const events = await readEvents(await POST(makeRequest({ url })));
    const err = events.find((e) => e.stage === 'error');
    expect(err).toBeDefined();
    expect(String(err!.message)).not.toMatch(/169\.254|127\.0|10\.0|metadata|ECONN|stack/i);
    expect(safeFetchMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
    expect(claimMock).not.toHaveBeenCalled();
  });

  it('uses the guarded fetch with a bounded timeout and body size', async () => {
    logScanLeadMock.mockResolvedValue({ ok: true });
    await readEvents(await POST(makeRequest({ url: 'example.com' })));
    expect(safeFetchMock).toHaveBeenCalledWith('https://example.com/', expect.objectContaining({
      timeoutMs: 10000,
      maxBytes: expect.any(Number),
    }));
  });

  it("shows only the guard's visitor-safe message when a redirect or DNS answer is refused", async () => {
    const { EgressError } = await import('@/lib/egress');
    safeFetchMock.mockRejectedValueOnce(new EgressError('This address cannot be scanned. Only public websites are supported.', 'resolved to non-public IP 10.0.0.7'));
    const events = await readEvents(await POST(makeRequest({ url: 'example.com' })));
    const err = events.find((e) => e.stage === 'error')!;
    expect(err.message).toBe('This address cannot be scanned. Only public websites are supported.');
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/scan — cost controls', () => {
  it('makes no model call when the daily ceiling is reached, with a friendly retry message', async () => {
    claimMock.mockResolvedValueOnce({ ok: false, reason: 'cap_reached' });
    const events = await readEvents(await POST(makeRequest({ url: 'example.com' })));
    expect(String(events.find((e) => e.stage === 'error')!.message)).toMatch(/try again tomorrow/);
    expect(createMock).not.toHaveBeenCalled();
    expect(saveScanResultMock).not.toHaveBeenCalled();
  });

  it('claims exactly one slot per paid scan, after the page fetched', async () => {
    logScanLeadMock.mockResolvedValue({ ok: true });
    await readEvents(await POST(makeRequest({ url: 'example.com' })));
    expect(claimMock).toHaveBeenCalledTimes(1);
    expect(safeFetchMock.mock.invocationCallOrder[0]).toBeLessThan(claimMock.mock.invocationCallOrder[0]);
    expect(claimMock.mock.invocationCallOrder[0]).toBeLessThan(createMock.mock.invocationCallOrder[0]);
  });

  it('an unreachable or refused page uses no slot', async () => {
    safeFetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await readEvents(await POST(makeRequest({ url: 'example.com' })));
    expect(claimMock).not.toHaveBeenCalled();
    await readEvents(await POST(makeRequest({ url: 'http://10.0.0.1/' })));
    expect(claimMock).not.toHaveBeenCalled();
  });

  it('fails closed (no model call) when the budget cannot be read', async () => {
    claimMock.mockResolvedValueOnce({ ok: false, reason: 'unavailable' });
    const events = await readEvents(await POST(makeRequest({ url: 'example.com' })));
    expect(String(events.find((e) => e.stage === 'error')!.message)).toMatch(/try again in a few minutes/);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('reuses a scan of the same URL from the last few minutes: no fetch, no model call, same scan_id', async () => {
    logScanLeadMock.mockResolvedValue({ ok: true });
    findRecentMock.mockResolvedValueOnce({ scan_id: 'recent-1', result: { ...SCAN_RESULT, overallScore: 80 } });
    const events = await readEvents(await POST(makeRequest({ url: 'example.com' })));
    const complete = events.find((e) => e.stage === 'complete')!;
    expect((complete.data as { scan_id: string }).scan_id).toBe('recent-1');
    expect(safeFetchMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
    expect(saveScanResultMock).not.toHaveBeenCalled();
  });

  it('internal (Quinn) scans bypass the public ceiling and reuse', async () => {
    process.env.SCAN_INTERNAL_TOKEN = 'tok';
    logScanLeadMock.mockResolvedValue({ ok: true });
    await readEvents(await POST(makeRequest({ url: 'example.com' }, { 'x-internal-token': 'tok' })));
    expect(claimMock).not.toHaveBeenCalled();
    expect(findRecentMock).not.toHaveBeenCalled();
    expect(createMock).toHaveBeenCalledTimes(1);
    delete process.env.SCAN_INTERNAL_TOKEN;
  });
});
