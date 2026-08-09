import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';

const { createMock, logScanLeadMock, saveScanResultMock, buildResilienceMock } = vi.hoisted(() => ({
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
const EXPECTED_A11Y = 84;

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
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          '<html><body><table><caption>In $ millions</caption>' +
          '<thead><tr><th>Region</th><th>2025</th><th>2026</th></tr></thead>' +
          '<tbody><tr><th>North</th><td>4.2</td><td>5.1</td></tr></tbody></table></body></html>',
      }),
    );

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
