import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { insertMock } = vi.hoisted(() => ({ insertMock: vi.fn() }));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: () => ({ insert: insertMock }) }),
}));

import { logScanLead } from './scanLeads';

// Values that must never reach the logs. The scanned URL identifies the
// prospect and the UTM fields carry campaign attribution.
const SENSITIVE = {
  url: 'https://acme-dental-clinic.example.com/pricing',
  utm_source: 'newsletter-list-q3',
  utm_medium: 'email',
  utm_campaign: 'spring-promo-2026',
  utm_content: 'variant-b',
  utm_term: 'dental seo wichita',
};

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

/** Every argument passed to console.log/console.error, flattened to one string. */
function consoleOutput(): string {
  return [...logSpy.mock.calls, ...errorSpy.mock.calls]
    .flat()
    .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
    .join(' ');
}

beforeEach(() => {
  insertMock.mockReset();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('logScanLead — logging never leaks payload values', () => {
  it('logs a safe success message on insert success', async () => {
    insertMock.mockResolvedValue({ error: null });

    await logScanLead({ overall_score: 42, ...SENSITIVE });

    const output = consoleOutput();
    for (const value of Object.values(SENSITIVE)) {
      expect(output).not.toContain(value);
    }
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('[scanLeads] insert ok — records: 1');
  });

  it('logs only the error code when Postgres echoes row values in the message', async () => {
    // Shape of a real unique-violation: the message embeds the offending value.
    insertMock.mockResolvedValue({
      error: {
        code: '23505',
        message: `duplicate key value violates unique constraint "scan_leads_url_key" Key (url)=(${SENSITIVE.url}) already exists.`,
        details: `Key (url)=(${SENSITIVE.url}) already exists.`,
        hint: null,
      },
    });

    await logScanLead({ overall_score: 42, ...SENSITIVE });

    const output = consoleOutput();
    for (const value of Object.values(SENSITIVE)) {
      expect(output).not.toContain(value);
    }
    expect(output).not.toContain('duplicate key value');
    expect(errorSpy).toHaveBeenCalledWith(
      '[scanLeads] insert failed — records: 1, code:',
      '23505',
    );
  });

  it('falls back to a placeholder when the error carries no code', async () => {
    insertMock.mockResolvedValue({ error: { message: SENSITIVE.url } });

    await logScanLead({ overall_score: 42, ...SENSITIVE });

    expect(consoleOutput()).not.toContain(SENSITIVE.url);
    expect(errorSpy).toHaveBeenCalledWith(
      '[scanLeads] insert failed — records: 1, code:',
      'unknown',
    );
  });

  it('still sends the full payload to Supabase', async () => {
    insertMock.mockResolvedValue({ error: null });

    await logScanLead({ overall_score: 42, ...SENSITIVE });

    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(insertMock.mock.calls[0][0]).toMatchObject(SENSITIVE);
  });
});
