// Immutable persistence behaviour. Supabase is mocked in the same style as
// lib/supabase/siteScans.test.ts — no database is contacted.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { insertMock, selectState } = vi.hoisted(() => {
  const insertMock = vi.fn();
  const selectState = { row: null as unknown, error: null as unknown };
  return { insertMock, selectState };
});

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      insert: insertMock,
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: selectState.row, error: selectState.error }) }),
      }),
    }),
  }),
}));

import type { QualificationInput } from '../opportunity-qualification/types';
import { qualificationInputHash } from './canonical-hash';
import { ACCEPTED_QUALIFICATION_VERSION, QUALIFICATION_INPUT_SCHEMA_VERSION } from './contract';
import { loadQualificationInputRow, persistQualificationInput } from './store';

const FIXTURE = JSON.parse(
  readFileSync(new URL('../opportunity-qualification/__fixtures__/michael-pilot.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
function input(): QualificationInput {
  const { _provenance, ...rest } = FIXTURE;
  return JSON.parse(JSON.stringify(rest)) as QualificationInput;
}

beforeEach(() => {
  insertMock.mockReset();
  selectState.row = null;
  selectState.error = null;
});

describe('immutable persistence', () => {
  it('29 a first write inserts the artifact with its versions and hash', async () => {
    insertMock.mockResolvedValue({ error: null });
    const i = input();
    const out = await persistQualificationInput(i);
    expect(out).toEqual({ ok: true, created: true, scanId: i.scanId, inputHash: qualificationInputHash(i) });
    const row = insertMock.mock.calls[0][0];
    expect(row.scan_id).toBe(i.scanId);
    expect(row.input_schema_version).toBe(QUALIFICATION_INPUT_SCHEMA_VERSION);
    expect(row.qualification_version).toBe(ACCEPTED_QUALIFICATION_VERSION);
    expect(row.input_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.payload).toBeTypeOf('object');
  });

  it('30 an identical retry reuses the stored artifact and writes nothing new', async () => {
    const i = input();
    insertMock.mockResolvedValue({ error: { code: '23505' } });
    selectState.row = {
      scan_id: i.scanId, input_schema_version: QUALIFICATION_INPUT_SCHEMA_VERSION,
      qualification_version: ACCEPTED_QUALIFICATION_VERSION,
      input_hash: qualificationInputHash(i), payload: {}, created_at: 'x',
    };
    const out = await persistQualificationInput(i);
    expect(out).toEqual({ ok: true, created: false, scanId: i.scanId, inputHash: qualificationInputHash(i) });
    expect(insertMock).toHaveBeenCalledTimes(1);
  });

  it('31 a CONFLICTING payload for the same scan is refused, never overwritten', async () => {
    const i = input();
    insertMock.mockResolvedValue({ error: { code: '23505' } });
    selectState.row = {
      scan_id: i.scanId, input_schema_version: QUALIFICATION_INPUT_SCHEMA_VERSION,
      qualification_version: ACCEPTED_QUALIFICATION_VERSION,
      input_hash: 'a'.repeat(64), payload: {}, created_at: 'x',
    };
    const out = await persistQualificationInput(i);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe('conflicting_payload_for_scan');
    expect(out.detail).toContain('refusing to overwrite');
    // exactly one insert attempt, and no second write of any kind
    expect(insertMock).toHaveBeenCalledTimes(1);
  });

  it('32 a database error is reported, not swallowed', async () => {
    insertMock.mockResolvedValue({ error: { code: '42501' } });
    const out = await persistQualificationInput(input());
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe('database_error');

    insertMock.mockRejectedValue(new Error('socket'));
    const thrown = await persistQualificationInput(input());
    expect(thrown.ok).toBe(false);
    if (!thrown.ok) expect(thrown.detail).toBe('transport');
  });

  it('33 a missing artifact is not_found, never a silent empty input', async () => {
    selectState.row = null;
    const out = await loadQualificationInputRow('no-such-scan');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe('not_found');
    selectState.error = { code: '08006' };
    const err = await loadQualificationInputRow('x');
    expect(err.ok).toBe(false);
    if (!err.ok) expect(err.code).toBe('database_error');
  });

  it('34 the store exposes no update, upsert or delete path', () => {
    const src = readFileSync(new URL('./store.ts', import.meta.url), 'utf8')
      .split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    for (const bad of ['.update(', '.upsert(', '.delete(', 'onConflict', 'ignoreDuplicates']) {
      expect(src, bad).not.toContain(bad);
    }
    expect(src).toContain('.insert(');
    expect(src).toContain('.select(');
  });
});

describe('migration 009 — STRUCTURAL inspection of the immutability contract', () => {
  // IMPORTANT: these assert what the migration SQL EXPRESSES. They are not a
  // runtime PostgreSQL test — no psql and no running database is available in
  // this environment, so nothing here proves live DML behaviour. The migration
  // carries a commented smoke test (UPDATE/DELETE inside a rolled-back
  // transaction) to be run by hand in the SQL editor after it is applied.
  const sql = readFileSync(new URL('../../migrations/009-qualification-inputs.sql', import.meta.url), 'utf8');

  it('35 a BEFORE UPDATE OR DELETE trigger refuses mutation for every role', () => {
    expect(sql).toContain('create or replace function public.refuse_qualification_input_mutation()');
    expect(sql).toMatch(/before update or delete on public\.qualification_inputs/);
    expect(sql).toContain('for each row');
    expect(sql).toContain('execute function public.refuse_qualification_input_mutation()');
    expect(sql).toContain('raise exception');
    expect(sql).toContain('qualification_inputs is immutable');
    // the transaction aborts if the trigger is somehow absent
    expect(sql).toContain('Migration 009 failed: qualification_inputs_immutable trigger not present');
  });

  it('36 UPDATE and DELETE privileges are revoked from every API role', () => {
    for (const role of ['service_role', 'authenticated', 'anon']) {
      expect(sql, role).toContain(`revoke update, delete on public.qualification_inputs from ${role};`);
    }
    // and no UPDATE/DELETE policy is granted anywhere
    expect(sql).not.toMatch(/for\s+update/i);
    expect(sql).not.toMatch(/for\s+delete/i);
  });

  it('37 the corrected contract no longer claims RLS stops service_role', () => {
    // the inaccurate claim is gone, and the correction plus the real limitation
    // are both recorded
    expect(sql).not.toContain('so even the service role cannot rewrite or remove a stored artifact');
    expect(sql).toContain('THAT WAS WRONG');
    expect(sql).toContain('BYPASSRLS');
    expect(sql).toContain('LIMITATION, stated accurately');
    expect(sql).toContain('not absolute immutability');
  });

  it('38 the migration remains additive and independent of migration 008', () => {
    // executable SQL only: the header legitimately NAMES the tables it does not touch
    const statements = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
    expect(statements).not.toMatch(/site_scans/);
    expect(statements).not.toMatch(/page_observations|scan_links|scan_link_targets/);
    expect(statements).not.toMatch(/drop table|alter table public\.(scan_urls|site_scans|page_observations)/i);
    // follows the repository's BEGIN / guard / COMMIT convention
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('COMMIT;');
  });
});
