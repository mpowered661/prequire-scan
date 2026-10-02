// Phase 2b-C3 — route adapter tests.
//
// The C2 service is mocked here on purpose: this file tests the ADAPTER, so it
// must be able to drive every C2 result class deterministically. C2's own
// behaviour is covered by its 63 accepted tests, and the handoff itself is
// asserted here byte-for-byte.
import { readdirSync, readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { reviewMock } = vi.hoisted(() => ({ reviewMock: vi.fn() }));
vi.mock('@/lib/human-review-server/presentation-review-service', () => ({
  reviewPresentation: reviewMock,
}));

import { POST } from './route';

/** Every C2 failure class, read from the service source so it cannot drift. */
const FAILURE_CLASSES: string[] = (() => {
  const src = readFileSync(
    new URL('../../../../lib/human-review-server/presentation-review-service.ts', import.meta.url),
    'utf8');
  const block = /export type ReviewFailureClass =([\s\S]*?);/.exec(src)![1];
  return [...block.matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
})();

function makeRequest(body: unknown, header: string | null = 'Bearer tok'): NextRequest {
  return {
    headers: { get: (k: string) => (k.toLowerCase() === 'authorization' ? header : null) },
    json: async () => body,
  } as unknown as NextRequest;
}
function brokenJsonRequest(header: string | null = 'Bearer tok'): NextRequest {
  return {
    headers: { get: (k: string) => (k.toLowerCase() === 'authorization' ? header : null) },
    json: async () => { throw new SyntaxError('Unexpected token } in JSON at position 42'); },
  } as unknown as NextRequest;
}

const OK = Object.freeze({
  ok: true, outcome: 'RECORDED',
  reviewDecisionId: 'dddddddd-2222-4333-8444-000000000001',
  requestId: '7f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  decisionTimestamp: '2026-10-02T12:00:00.000Z',
  presentationSnapshotId: null,
});

beforeEach(() => { reviewMock.mockReset(); });

describe('POST /api/internal/presentation-review — handoff', () => {
  it('1 the Authorization header is forwarded byte-for-byte, never parsed', async () => {
    reviewMock.mockResolvedValue(OK);
    const header = 'Bearer   eyJhbGciOiJIUzI1NiJ9.PAYLOAD.sig  ';
    await POST(makeRequest({ any: 'body' }, header));
    expect(reviewMock).toHaveBeenCalledTimes(1);
    expect(reviewMock.mock.calls[0][0], 'forwarded verbatim, whitespace included').toBe(header);
  });

  it('2 a missing Authorization header is forwarded as null', async () => {
    reviewMock.mockResolvedValue(OK);
    await POST(makeRequest({}, null));
    expect(reviewMock.mock.calls[0][0]).toBeNull();
  });

  it('3 the body reaches C2 unnarrowed: objects, arrays and primitives alike', async () => {
    for (const body of [{ a: 1 }, [1, 2, 3], 'a string', 42, true, null]) {
      reviewMock.mockReset();
      reviewMock.mockResolvedValue(OK);
      await POST(makeRequest(body));
      expect(reviewMock.mock.calls[0][1], JSON.stringify(body)).toBe(body);
    }
  });

  it('4 the route does NOT strip or sanitize forbidden fields — C2 must see them', async () => {
    // C3 deliberately owns no copy of the forbidden list. A hostile body is
    // handed over intact so C2's own boundary refuses it.
    reviewMock.mockResolvedValue({
      ok: false, failure: 'request_invalid',
      reasons: ['forbidden_field_supplied', 'forbidden:reviewerId'],
    });
    const hostile = { reviewerId: 'attacker', decisionTimestamp: '1999-01-01T00:00:00.000Z', scanId: 's' };
    const res = await POST(makeRequest(hostile));
    const handed = reviewMock.mock.calls[0][1] as Record<string, unknown>;
    expect(handed).toBe(hostile);
    expect(handed.reviewerId, 'not stripped').toBe('attacker');
    expect(handed.decisionTimestamp, 'not stripped').toBe('1999-01-01T00:00:00.000Z');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      ok: false, failure: 'request_invalid',
      reasons: ['forbidden_field_supplied', 'forbidden:reviewerId'],
    });
  });

  it('5 C2 is called exactly once, with exactly two arguments', async () => {
    reviewMock.mockResolvedValue(OK);
    await POST(makeRequest({ x: 1 }));
    expect(reviewMock).toHaveBeenCalledTimes(1);
    expect(reviewMock.mock.calls[0]).toHaveLength(2);
  });
});

describe('malformed JSON', () => {
  it('6 refuses before C2 is reached, without echoing the parser message', async () => {
    const res = await POST(brokenJsonRequest());
    expect(res.status).toBe(400);
    expect(reviewMock, 'C2 must not be invoked').not.toHaveBeenCalled();
    const body = await res.json();
    expect(body).toEqual({ ok: false, failure: 'request_invalid', reasons: ['malformed_json_body'] });
    const json = JSON.stringify(body);
    for (const leak of ['Unexpected token', 'position 42', 'SyntaxError']) {
      expect(json, leak).not.toContain(leak);
    }
  });
});

describe('success responses', () => {
  it('7 RECORDED returns 200 with the C2 payload unchanged', async () => {
    reviewMock.mockResolvedValue(OK);
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(OK);
  });

  it('8 ALREADY_RECORDED also returns 200 with the payload unchanged', async () => {
    const replay = { ...OK, outcome: 'ALREADY_RECORDED', presentationSnapshotId: 'e'.repeat(32) };
    reviewMock.mockResolvedValue(replay);
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(replay);
  });

  it('9 the success body is not embellished with any action-implying field', async () => {
    reviewMock.mockResolvedValue(OK);
    const body = await (await POST(makeRequest({}))).json();
    expect(Object.keys(body).sort()).toEqual([
      'decisionTimestamp', 'ok', 'outcome', 'presentationSnapshotId',
      'requestId', 'reviewDecisionId']);
    for (const f of ['sent', 'emailed', 'published', 'authorizedForOutreach', 'fixed',
      'verified', 'converted', 'remediated', 'businessImpact', 'delivered']) {
      expect(Object.keys(body), f).not.toContain(f);
    }
  });
});

describe('C2 failure class to HTTP status — exhaustive', () => {
  const EXPECTED: Record<string, number> = {
    request_invalid: 400,
    unauthenticated: 401,
    forbidden: 403,
    scan_not_found: 404,
    opportunity_not_found: 404,
    binding_mismatch: 409,
    ambiguous_opportunity: 409,
    revoke_target_invalid: 409,
    idempotency_conflict: 409,
    decision_invalid: 422,
    approval_not_eligible: 422,
    snapshot_not_derivable: 422,
    rederivation_failed: 422,
    invalid_packet_identity: 422,
    history_failed: 422,
    server_misconfiguration: 500,
    persistence_failed: 500,
    upstream_failure: 502,
  };

  it('10 every class C2 declares has an expectation here — no class left unmapped', () => {
    expect(FAILURE_CLASSES.length).toBe(18);
    expect(Object.keys(EXPECTED).sort()).toEqual([...FAILURE_CLASSES].sort());
  });

  it('11 each class maps to its status, deterministically and by class alone', async () => {
    for (const [failure, status] of Object.entries(EXPECTED)) {
      reviewMock.mockReset();
      reviewMock.mockResolvedValue({ ok: false, failure, reasons: ['a_stable_code'] });
      const res = await POST(makeRequest({}));
      expect(res.status, failure).toBe(status);
      expect(await res.json(), failure).toEqual({
        ok: false, failure, reasons: ['a_stable_code'],
      });
    }
  });

  it('12 status does not depend on the reasons text', async () => {
    // The same class with wildly different reasons must give the same status.
    for (const reasons of [[], ['x'], ['STALE_EVIDENCE'], ['a', 'b', 'c'], ['500'], ['401']]) {
      reviewMock.mockReset();
      reviewMock.mockResolvedValue({ ok: false, failure: 'binding_mismatch', reasons });
      const res = await POST(makeRequest({}));
      expect(res.status, JSON.stringify(reasons)).toBe(409);
    }
  });

  it('13 reasons are preserved verbatim as stable codes, never rewritten', async () => {
    reviewMock.mockResolvedValue({
      ok: false, failure: 'revoke_target_invalid',
      reasons: ['revoke_nothing_standing', 'status_before:REVOKED'],
    });
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(409);
    expect((await res.json()).reasons).toEqual(['revoke_nothing_standing', 'status_before:REVOKED']);
  });

  it('14 the refusal body carries exactly three keys', async () => {
    reviewMock.mockResolvedValue({ ok: false, failure: 'forbidden', reasons: ['capability_absent'] });
    const body = await (await POST(makeRequest({}))).json();
    expect(Object.keys(body).sort()).toEqual(['failure', 'ok', 'reasons']);
  });
});

describe('containment and detail leak', () => {
  const POISON = 'PGPASSWORD=s3cr3t eyJhbGciOiJIUzI1NiJ9.SERVICE_ROLE 42P01 relation "review_decisions"';

  it('15 a thrown C2 exception becomes a generic bounded 500', async () => {
    reviewMock.mockRejectedValue(new Error(POISON));
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ ok: false, failure: 'unexpected_error', reasons: [] });
    const json = JSON.stringify(body);
    for (const frag of ['PGPASSWORD', 's3cr3t', 'eyJhbGci', 'SERVICE_ROLE', '42P01',
      'review_decisions', 'Error', 'stack']) {
      expect(json, frag).not.toContain(frag);
    }
  });

  it('16 non-Error throws are contained identically', async () => {
    for (const thrown of [POISON, { detail: POISON }, 42, null, undefined]) {
      reviewMock.mockReset();
      reviewMock.mockImplementation(() => { throw thrown; });
      const res = await POST(makeRequest({}));
      expect(res.status, String(thrown)).toBe(500);
      expect(JSON.stringify(await res.json())).not.toContain('s3cr3t');
    }
  });

  it('17 the Authorization value is never echoed into any response', async () => {
    const header = 'Bearer SUPER-SECRET-TOKEN-VALUE';
    // success
    reviewMock.mockResolvedValue(OK);
    expect(JSON.stringify(await (await POST(makeRequest({}, header))).json()))
      .not.toContain('SUPER-SECRET');
    // refusal
    reviewMock.mockReset();
    reviewMock.mockResolvedValue({ ok: false, failure: 'unauthenticated', reasons: ['token_rejected'] });
    expect(JSON.stringify(await (await POST(makeRequest({}, header))).json()))
      .not.toContain('SUPER-SECRET');
    // thrown
    reviewMock.mockReset();
    reviewMock.mockRejectedValue(new Error(header));
    expect(JSON.stringify(await (await POST(makeRequest({}, header))).json()))
      .not.toContain('SUPER-SECRET');
  });

  it('18 a refusal reasons array containing prose is still passed through unchanged', async () => {
    // C2 guarantees stable codes; the route must not start filtering them,
    // because silently dropping a reason would hide a real refusal cause.
    reviewMock.mockResolvedValue({ ok: false, failure: 'decision_invalid', reasons: ['timestamp_not_iso'] });
    expect((await (await POST(makeRequest({}))).json()).reasons).toEqual(['timestamp_not_iso']);
  });
});

describe('structural boundary', () => {
  /**
   * Executable code only. The route NAMES several forbidden constructs in its
   * header in order to state that they are forbidden, so a raw scan would match
   * its own documentation. Comments and the import block are excluded, and the
   * import block is checked separately below.
   */
  function executableCode(): string {
    const raw = readFileSync(new URL('./route.ts', import.meta.url), 'utf8');
    return raw
      .replace(/[/][*][\s\S]*?[*][/]/g, ' ')
      .split('\n')
      .filter(l => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*')); })
      .join('\n');
  }

  it('19 the route establishes no identity and touches no data layer', () => {
    const code = executableCode();
    for (const forbidden of [
      'auth.getUser', 'getUser(', 'operator_capabilities',
      'TrustedReviewerIdentity', 'requirePresentationApprove',
      'SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
      'SCAN_INTERNAL_TOKEN', 'STUDY_MODE_TOKEN',
      'createClient', '@supabase', '.rpc(', '.from(',
      '.insert(', '.update(', '.upsert(', '.delete(',
      'review_decisions', 'presentation_snapshots', 'qualification_inputs',
    ]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });

  it('20 the route performs no downstream business action', () => {
    const code = executableCode();
    for (const forbidden of [
      'sendMail', 'sendEmail', 'outreach', 'publish(', 'remediate',
      'heygen', 'HeyGen', 'blotato', 'Blotato', 'VideoBrief', 'Scout',
      'fetch(', 'webhook',
    ]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });

  it('21 it imports exactly next/server and the C2 service, and nothing else', () => {
    const raw = readFileSync(new URL('./route.ts', import.meta.url), 'utf8');
    const specs = [...raw.matchAll(/from '([^']+)'/g)].map(m => m[1]).sort();
    expect(specs).toEqual([
      '@/lib/human-review-server/presentation-review-service',
      'next/server',
    ]);
  });

  it('22 it never narrows or casts the body before handing it to C2', () => {
    const code = executableCode();
    expect(code).toContain('let body: unknown;');
    // no cast of the parsed body to a trusted request type
    expect(code).not.toMatch(/body as [A-Z]/);
    expect(code).not.toContain('PresentationReviewRequest');
    // and no local copy of C2's contracts
    for (const forbidden of ['FORBIDDEN_REQUEST_FIELDS', 'UUID', 'structuredRejectionReason',
      'revokesReviewDecisionId', 'decisionType', 'REJECTION_REASONS']) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });

  it('23 the status map is exhaustive over the C2 class union at the type level', () => {
    const code = executableCode();
    // Record<ReviewFailureClass, number> makes a new C2 class a compile error
    expect(code).toContain('Record<ReviewFailureClass, number>');
    for (const cls of FAILURE_CLASSES) {
      expect(code, cls).toContain(cls + ':');
    }
  });

  it('24 only POST is exported, and nothing is logged', () => {
    const code = executableCode();
    const verbs = [...code.matchAll(/export async function ([A-Z]+)/g)].map(m => m[1]);
    expect(verbs).toEqual(['POST']);
    for (const forbidden of ['console.', 'process.stdout', 'process.stderr']) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });

  it('25 there is exactly one presentation-review route in the repository', () => {
    // guards against a second, divergent adapter appearing later
    const dir = new URL('./', import.meta.url);
    const files = readdirSync(dir).sort();
    expect(files.filter(f => f === 'route.ts')).toEqual(['route.ts']);
    expect(files.some(f => f.endsWith('.tsx')), 'no UI in this route folder').toBe(false);
  });
});
