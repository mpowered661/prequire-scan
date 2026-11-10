import { describe, it, expect, vi, beforeEach } from 'vitest';

const { rpcMock, fromMock, chain } = vi.hoisted(() => {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const m of ['select', 'eq', 'gte', 'order', 'limit']) chain[m] = vi.fn(() => chain);
  chain.maybeSingle = vi.fn();
  return { rpcMock: vi.fn(), fromMock: vi.fn(() => chain), chain };
});
vi.mock('@/lib/supabase/serviceClient', () => ({
  getServiceClient: () => ({ rpc: rpcMock, from: fromMock }),
}));

import { claimPaidScan, findRecentScan, PUBLIC_SCAN_DAILY_CAP, SCAN_REUSE_MINUTES } from './scanBudget';

beforeEach(() => {
  rpcMock.mockReset();
  fromMock.mockClear();
  for (const m of Object.values(chain)) m.mockClear();
});

describe('claimPaidScan — atomic ceiling (migration 006)', () => {
  it('defaults to 300 paid scans per day', () => {
    expect(PUBLIC_SCAN_DAILY_CAP).toBe(300);
  });

  it('asks the database for exactly one slot under the cap', async () => {
    rpcMock.mockResolvedValue({ data: true, error: null });
    expect(await claimPaidScan()).toEqual({ ok: true });
    expect(rpcMock).toHaveBeenCalledWith('claim_paid_scan', { p_cap: 300 });
  });

  it('reports the cap when the database refuses a slot', async () => {
    rpcMock.mockResolvedValue({ data: false, error: null });
    expect(await claimPaidScan()).toEqual({ ok: false, reason: 'cap_reached' });
  });

  it.each([
    ['an RPC error (e.g. migration not applied)', { data: null, error: { message: 'function does not exist' } }],
    ['a non-boolean answer', { data: 'yes', error: null }],
  ])('fails closed on %s', async (_label, res) => {
    rpcMock.mockResolvedValue(res);
    expect(await claimPaidScan()).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('fails closed when the client throws', async () => {
    rpcMock.mockRejectedValue(new Error('network'));
    expect(await claimPaidScan()).toEqual({ ok: false, reason: 'unavailable' });
  });
});

describe('findRecentScan — 15-minute reuse of public results only', () => {
  it('selects only the result and scan_id (never email, name or contact ids), public rows, inside the window', async () => {
    chain.maybeSingle.mockResolvedValue({ data: { scan_id: 's1', result_json: { overallScore: 80 } }, error: null });
    const before = Date.now();
    expect(await findRecentScan('https://example.com/')).toEqual({ scan_id: 's1', result: { overallScore: 80 } });
    expect(fromMock).toHaveBeenCalledWith('scan_results');
    expect(chain.select).toHaveBeenCalledWith('scan_id, result_json');
    expect(chain.eq).toHaveBeenCalledWith('url', 'https://example.com/');
    expect(chain.eq).toHaveBeenCalledWith('source', 'public');
    const since = Date.parse(chain.gte.mock.calls[0][1] as string);
    expect(before - since).toBeGreaterThanOrEqual(SCAN_REUSE_MINUTES * 60_000 - 50);
    expect(before - since).toBeLessThan(SCAN_REUSE_MINUTES * 60_000 + 1000);
  });

  it('a lookup error or no row is a miss (a fresh scan runs)', async () => {
    chain.maybeSingle.mockResolvedValueOnce({ data: null, error: { message: 'x' } });
    expect(await findRecentScan('https://a.com/')).toBeNull();
    chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    expect(await findRecentScan('https://a.com/')).toBeNull();
  });
});
