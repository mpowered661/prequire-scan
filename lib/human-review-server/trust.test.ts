// Authentication, capability and the single minting boundary.
// Supabase is injected, never contacted.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  UNSAFE_setCapabilityClientForTests,
  hasActivePresentationApprove,
  requirePresentationApprove,
} from './capability';
import {
  UNSAFE_setAuthClientForTests,
  authenticateReviewer,
  parseBearerToken,
} from './trusted-reviewer';

const USER = '3f1b7c2e-9a44-4b31-8c77-1d2e3f4a5b6c';
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.header.signature';

/** Minimal fake Supabase surfaces. */
function fakeAuth(result: { data?: unknown; error?: unknown } | (() => never)) {
  return {
    auth: {
      getUser: vi.fn(async () => {
        if (typeof result === 'function') result();
        return result as { data: unknown; error: unknown };
      }),
    },
  } as never;
}
function fakeStore(result: { data?: unknown; error?: unknown } | (() => never)) {
  const maybeSingle = vi.fn(async () => {
    if (typeof result === 'function') result();
    return result as { data: unknown; error: unknown };
  });
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle })) })) })),
    })),
  } as never;
}
const activeRow = { user_id: USER, capability: 'presentation.approve', revoked_at: null };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://dummy.invalid';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-not-a-real-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-not-a-real-key';
  UNSAFE_setAuthClientForTests(fakeAuth({ data: { user: { id: USER } }, error: null }));
  UNSAFE_setCapabilityClientForTests(fakeStore({ data: activeRow, error: null }));
});
afterEach(() => {
  UNSAFE_setAuthClientForTests(null);
  UNSAFE_setCapabilityClientForTests(null);
});

describe('bearer parsing is strict', () => {
  it('9 every malformed credential shape is refused', () => {
    const cases: [string, string | null, string][] = [
      ['missing header', null, 'authorization_header_missing'],
      ['empty header', '   ', 'authorization_header_missing'],
      ['wrong scheme', 'Basic abc123', 'authorization_scheme_not_bearer'],
      ['token-only', 'abc123', 'authorization_scheme_not_bearer'],
      ['bearer no token', 'Bearer', 'bearer_token_empty'],
      ['bearer whitespace only', 'Bearer    ', 'bearer_token_empty'],
      ['two credentials', `Bearer ${TOKEN}, Bearer other`, 'bearer_token_malformed'],
      ['token with whitespace', 'Bearer abc def', 'bearer_token_malformed'],
    ];
    for (const [label, header, code] of cases) {
      const out = parseBearerToken(header);
      expect(out.ok, label).toBe(false);
      if (out.ok) continue;
      expect(out.code, label).toBe(code);
    }
  });

  it('10 a well-formed credential yields the token and nothing else', () => {
    const out = parseBearerToken(`Bearer ${TOKEN}`);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.token).toBe(TOKEN);
  });
});

describe('authentication is mandatory and fail-closed', () => {
  it('11 every auth failure refuses, and none returns an identity', async () => {
    const cases: [string, () => void, string][] = [
      ['token rejected', () => UNSAFE_setAuthClientForTests(fakeAuth({ data: { user: null }, error: { message: 'invalid JWT' } })), 'token_rejected'],
      ['expired token', () => UNSAFE_setAuthClientForTests(fakeAuth({ data: { user: null }, error: { message: 'JWT expired' } })), 'token_rejected'],
      ['no user', () => UNSAFE_setAuthClientForTests(fakeAuth({ data: { user: null }, error: null })), 'no_user_for_token'],
      ['missing user id', () => UNSAFE_setAuthClientForTests(fakeAuth({ data: { user: {} }, error: null })), 'user_id_malformed'],
      ['non-uuid user id', () => UNSAFE_setAuthClientForTests(fakeAuth({ data: { user: { id: 'operator@example.com' } }, error: null })), 'user_id_malformed'],
      ['transport throw', () => UNSAFE_setAuthClientForTests(fakeAuth(() => { throw new Error('socket'); })), 'auth_transport_error'],
    ];
    for (const [label, arrange, code] of cases) {
      arrange();
      const out = await authenticateReviewer(`Bearer ${TOKEN}`);
      expect(out.ok, label).toBe(false);
      if (out.ok) continue;
      expect(out.code, label).toBe(code);
      expect(out).not.toHaveProperty('userId');
    }
  });

  it('12 an unconfigured anon key fails closed rather than falling back', async () => {
    UNSAFE_setAuthClientForTests(null);
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const out = await authenticateReviewer(`Bearer ${TOKEN}`);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe('auth_not_configured');
  });

  it('13 a verified token yields the auth.users.id', async () => {
    const out = await authenticateReviewer(`Bearer ${TOKEN}`);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.userId).toBe(USER);
  });

  it('14 the token is never echoed in any failure detail', async () => {
    UNSAFE_setAuthClientForTests(fakeAuth({ data: { user: null }, error: { message: `bad token ${TOKEN}` } }));
    const out = await authenticateReviewer(`Bearer ${TOKEN}`);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    // and the production modules never log at all
    for (const f of ['trusted-reviewer.ts', 'capability.ts']) {
      const src = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
      expect(src, f).not.toContain('console.');
    }
  });
});

describe('capability lookup fails closed', () => {
  it('15 only an active presentation.approve row passes', async () => {
    const cases: [string, unknown, unknown, boolean, string][] = [
      ['active', activeRow, null, true, ''],
      ['absent', null, null, false, 'capability_absent'],
      ['revoked', { ...activeRow, revoked_at: '2026-10-01T00:00:00.000Z' }, null, false, 'capability_revoked'],
      ['lookup error', null, { code: '08006' }, false, 'capability_lookup_failed'],
      ['wrong user in row', { ...activeRow, user_id: 'someone-else' }, null, false, 'capability_row_malformed'],
      ['wrong capability in row', { ...activeRow, capability: 'admin' }, null, false, 'capability_row_malformed'],
    ];
    for (const [label, data, error, expectOk, code] of cases) {
      UNSAFE_setCapabilityClientForTests(fakeStore({ data, error }));
      const out = await hasActivePresentationApprove(USER);
      expect(out.ok, label).toBe(expectOk);
      if (!out.ok) expect(out.code, label).toBe(code);
    }
  });

  it('16 a transport throw and an unconfigured store both fail closed', async () => {
    UNSAFE_setCapabilityClientForTests(fakeStore(() => { throw new Error('socket'); }));
    const thrown = await hasActivePresentationApprove(USER);
    expect(thrown.ok).toBe(false);
    if (!thrown.ok) expect(thrown.code).toBe('capability_lookup_failed');

    UNSAFE_setCapabilityClientForTests(null);
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const unconfigured = await hasActivePresentationApprove(USER);
    expect(unconfigured.ok).toBe(false);
    if (!unconfigured.ok) expect(unconfigured.code).toBe('capability_store_not_configured');
  });
});

describe('the single minting boundary', () => {
  it('17 a verified user with active capability is minted', async () => {
    const out = await requirePresentationApprove(`Bearer ${TOKEN}`);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.userId).toBe(USER);
    // the branded value is the verified auth.users.id and nothing else
    expect(out.reviewer as unknown as string).toBe(USER);
  });

  it('18 no authentication failure can ever mint', async () => {
    for (const header of [null, 'Basic abc', 'Bearer', `Bearer ${TOKEN}, Bearer x`]) {
      const out = await requirePresentationApprove(header);
      expect(out.ok, String(header)).toBe(false);
      expect(out).not.toHaveProperty('reviewer');
    }
    UNSAFE_setAuthClientForTests(fakeAuth({ data: { user: null }, error: { message: 'invalid' } }));
    const rejected = await requirePresentationApprove(`Bearer ${TOKEN}`);
    expect(rejected.ok).toBe(false);
    expect(rejected).not.toHaveProperty('reviewer');
  });

  it('19 a verified human WITHOUT capability cannot mint', async () => {
    for (const row of [null, { ...activeRow, revoked_at: '2026-10-01T00:00:00.000Z' }]) {
      UNSAFE_setCapabilityClientForTests(fakeStore({ data: row, error: null }));
      const out = await requirePresentationApprove(`Bearer ${TOKEN}`);
      expect(out.ok).toBe(false);
      expect(out).not.toHaveProperty('reviewer');
    }
  });

  it('20 identity comes only from the verified token, never from supplied data', async () => {
    // whatever the token's subject is, THAT is the identity; the capability
    // lookup is performed against it and nothing else
    const attacker = '00000000-0000-4000-8000-0000000000ff';
    UNSAFE_setAuthClientForTests(fakeAuth({ data: { user: { id: attacker } }, error: null }));
    UNSAFE_setCapabilityClientForTests(fakeStore({ data: { ...activeRow, user_id: attacker }, error: null }));
    const out = await requirePresentationApprove(`Bearer ${TOKEN}`);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.userId).toBe(attacker);
    expect(out.userId).not.toBe(USER);
  });

  it('21 no production export brands an arbitrary string', async () => {
    const capability = await import('./capability');
    const reviewer = await import('./trusted-reviewer');
    const exported = [...Object.keys(capability), ...Object.keys(reviewer)];
    // nothing shaped like a string-to-identity factory is exposed
    for (const bad of ['trustedReviewerIdentity', 'asTrustedReviewer', 'toTrustedReviewer',
      'makeTrustedReviewer', 'createTrustedReviewer', 'trustedReviewerFromString',
      'trustedReviewerFromEmail', 'trustedReviewerFromRequest', 'brand']) {
      expect(exported, bad).not.toContain(bad);
    }
    // the only mint is coupled to both proofs and is async by necessity
    expect(exported).toContain('requirePresentationApprove');
    expect(capability.requirePresentationApprove.length).toBe(1);
  });

  it('22 none of the forbidden identity sources can mint', async () => {
    // Each of these is offered as a bearer credential. None is a valid token,
    // so the fake auth client rejects them exactly as Supabase would.
    UNSAFE_setAuthClientForTests(fakeAuth({ data: { user: null }, error: { message: 'invalid JWT' } }));
    for (const forbidden of ['operator@example.com', 'michael-pilot-001', 'scan-123',
      'prospect-456', '00000000-0000-4000-8000-000000000001', 'admin', 'system',
      'human', 'reviewer', 'SCAN_INTERNAL_TOKEN', 'STUDY_MODE_TOKEN', 'service-role-key']) {
      const out = await requirePresentationApprove(`Bearer ${forbidden}`);
      expect(out.ok, forbidden).toBe(false);
      expect(out, forbidden).not.toHaveProperty('reviewer');
    }
  });
});

describe('source invariant — exactly one production mint', () => {
  /** Production files of this layer, comments stripped. */
  function productionCode(): { file: string; code: string }[] {
    const files = ['packet-view.ts', 'trusted-reviewer.ts', 'capability.ts'];
    return files.map(file => {
      const raw = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
      const code = raw.replace(/\/\*[\s\S]*?\*\//g, ' ')
        .split('\n')
        .filter(l => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*')); })
        .join('\n');
      return { file, code };
    });
  }

  it('23 exactly one production assertion can mint, and only in capability.ts', () => {
    const pattern = /as\s+unknown\s+as\s+TrustedReviewerIdentity|as\s+TrustedReviewerIdentity|<TrustedReviewerIdentity>/g;
    let total = 0;
    for (const { file, code } of productionCode()) {
      const hits = code.match(pattern) ?? [];
      total += hits.length;
      if (file !== 'capability.ts') expect(hits.length, file).toBe(0);
    }
    expect(total).toBe(1);
  });

  it('24 no production module in this layer imports the test-only identity helper', () => {
    for (const { file, code } of productionCode()) {
      expect(code, file).not.toContain('test-only-fixtures');
      expect(code, file).not.toContain('UNSAFE_testOnlyTrustedReviewer');
    }
  });

  it('25 the auth module never reads the service-role key', () => {
    const auth = productionCode().find(f => f.file === 'trusted-reviewer.ts')!.code;
    expect(auth).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(auth).toContain('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  });

  it('26 this tranche writes no decision or snapshot state', () => {
    for (const { file, code } of productionCode()) {
      for (const forbidden of ['review_decisions', 'presentation_snapshots',
        'record_presentation_review', '.rpc(', '.insert(', '.upsert(', '.update(', '.delete(',
        'APPROVE_PRESENTATION', 'PresentationSnapshot', 'ReviewDecisionRecord']) {
        expect(code, `${file}: ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('27 migration 010 creates only operator_capabilities and is marked NOT APPLIED', () => {
    const sql = readFileSync(new URL('../../migrations/010-operator-capabilities.sql', import.meta.url), 'utf8');
    expect(sql).toContain('*** NOT APPLIED. ***');
    expect(sql).toContain('create table if not exists public.operator_capabilities');
    expect(sql).toContain('primary key (user_id, capability)');
    expect(sql).toContain("check (capability = 'presentation.approve')");
    expect(sql).toContain('references auth.users(id) on delete cascade');
    // the mutability decision is explicit, and 009's trigger is NOT reused here
    expect(sql).toContain('DELIBERATELY MUTABLE');
    expect(sql).not.toMatch(/create trigger/i);
    // and nothing from a later tranche leaked in
    const statements = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
    for (const forbidden of ['review_decisions', 'presentation_snapshots', 'site_scans',
      'qualification_inputs', 'page_observations']) {
      expect(statements, forbidden).not.toContain(forbidden);
    }
  });
});
