import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { insertMock, selectChain } = vi.hoisted(() => {
  const insertMock = vi.fn();
  // select().eq().eq().gte().limit() chain — resolves with what the test sets.
  const selectChain = {
    result: { data: [] as unknown[], error: null as unknown },
    build() {
      const limit = vi.fn().mockImplementation(async () => selectChain.result);
      const gte = vi.fn().mockReturnValue({ limit });
      const eq2 = vi.fn().mockReturnValue({ gte });
      const eq1 = vi.fn().mockReturnValue({ eq: eq2 });
      return vi.fn().mockReturnValue({ eq: eq1 });
    },
  };
  return { insertMock, selectChain };
});

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({ insert: insertMock, select: selectChain.build() }),
  }),
}));

import {
  captureLead,
  buildLeadRow,
  reduceRowForLegacySchema,
  type CaptureLeadInput,
} from './captureLead';
import { isValidEmail } from '@/lib/validation';

const INPUT: CaptureLeadInput = {
  email: 'Visitor@Example.COM',
  url: 'https://example.com/',
  scan_id: 'scan-123',
  score: 62,
  band: 'moderate',
  registry_version: '2026-08',
  prompt_version: '2026-08',
  model: 'claude-haiku-4-5-20251001',
  utm_source: 'newsletter',
  utm_medium: null,
  utm_campaign: null,
  utm_content: null,
  utm_term: null,
};

beforeEach(() => {
  insertMock.mockReset();
  selectChain.result = { data: [], error: null };
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isValidEmail', () => {
  it('accepts normal addresses', () => {
    expect(isValidEmail('a@b.co')).toBe(true);
    expect(isValidEmail('first.last+tag@sub.domain.org')).toBe(true);
  });

  it('rejects malformed addresses', () => {
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail('no-at-sign')).toBe(false);
    expect(isValidEmail('a@b')).toBe(false);
    expect(isValidEmail('spaces in@it.com')).toBe(false);
    expect(isValidEmail('a@b.')).toBe(false);
    expect(isValidEmail(null)).toBe(false);
    expect(isValidEmail(42)).toBe(false);
    expect(isValidEmail('x'.repeat(250) + '@example.com')).toBe(false);
  });
});

describe('buildLeadRow — consent and metadata recording', () => {
  const row = buildLeadRow(INPUT, '2026-08-06T12:00:00.000Z');

  it('records consent timestamp and normalized email', () => {
    expect(row.consent_ts).toBe('2026-08-06T12:00:00.000Z');
    expect(row.email).toBe('visitor@example.com');
  });

  it('records score, band, and version metadata', () => {
    expect(row.overall_score).toBe(62);
    expect(row.score_band).toBe('moderate');
    expect(row.capture_meta).toMatchObject({
      scan_id: 'scan-123',
      registry_version: '2026-08',
      prompt_version: '2026-08',
      model: 'claude-haiku-4-5-20251001',
      consent_source: 'scan_email_report_v1',
    });
  });

  it('carries UTM attribution', () => {
    expect(row.utm_source).toBe('newsletter');
    expect(row.utm_medium).toBeNull();
  });

  it('contains no phone or SMS fields anywhere in the row', () => {
    const flat = JSON.stringify(row).toLowerCase();
    expect(flat).not.toContain('phone');
    expect(flat).not.toContain('sms');
    expect(flat).not.toContain('tel:');
  });

  it('legacy reduction drops only the migration-005 columns', () => {
    const legacy = reduceRowForLegacySchema(row);
    expect(legacy).not.toHaveProperty('consent_ts');
    expect(legacy).not.toHaveProperty('score_band');
    expect(legacy).not.toHaveProperty('capture_meta');
    expect(legacy.email).toBe('visitor@example.com');
    expect(legacy.overall_score).toBe(62);
    expect(legacy.utm_source).toBe('newsletter');
  });
});

describe('captureLead', () => {
  it('inserts the full row and reports success', async () => {
    insertMock.mockResolvedValue({ error: null });

    const outcome = await captureLead(INPUT);

    expect(outcome).toEqual({ ok: true, duplicate: false, degraded: false });
    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(insertMock.mock.calls[0][0]).toMatchObject({
      email: 'visitor@example.com',
      score_band: 'moderate',
    });
  });

  it('returns duplicate:true without inserting when a recent capture exists', async () => {
    selectChain.result = { data: [{ id: 1 }], error: null };

    const outcome = await captureLead(INPUT);

    expect(outcome).toEqual({ ok: true, duplicate: true, degraded: false });
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('degrades to the legacy column set when migration 005 is not applied (PGRST204)', async () => {
    insertMock
      .mockResolvedValueOnce({ error: { code: 'PGRST204', message: 'column not found' } })
      .mockResolvedValueOnce({ error: null });

    const outcome = await captureLead(INPUT);

    expect(outcome).toEqual({ ok: true, duplicate: false, degraded: true });
    expect(insertMock).toHaveBeenCalledTimes(2);
    expect(insertMock.mock.calls[1][0]).not.toHaveProperty('consent_ts');
  });

  it('fails safely with a code on other insert errors', async () => {
    insertMock.mockResolvedValue({ error: { code: '23505', message: 'dup' } });

    const outcome = await captureLead(INPUT);

    expect(outcome).toEqual({ ok: false, code: '23505' });
  });

  it('fails safely on transport errors', async () => {
    insertMock.mockRejectedValue(new Error('network down'));

    const outcome = await captureLead(INPUT);

    expect(outcome).toEqual({ ok: false, code: 'transport' });
  });
});
