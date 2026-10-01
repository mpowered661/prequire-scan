// Human authentication for presentation review. Server-side only.
//
// THIS MODULE ANSWERS ONE QUESTION: which verified Supabase user, if any, is
// making this request? It returns a plain `auth.users.id` string and
// DELIBERATELY CANNOT mint a TrustedReviewerIdentity — identity alone is not
// authorization. The branded type is minted only in ./capability.ts, and only
// after an active capability has also been proven.
//
// SEPARATION OF RESPONSIBILITY. Verification uses an ANON-KEY client. A
// service-role credential is never adjacent to token verification, and
// possessing the service-role key never establishes who a human is.
// `auth.getUser(token)` validates the token that is passed to it, so no
// privilege is required to perform the check.
//
// FAIL CLOSED. Unlike app/api/aeo-readiness-check/route.ts — which treats
// authentication as optional and only tiers rate limits — every failure here is
// fatal. There is no anonymous downgrade path.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Environment contract. `NEXT_PUBLIC_SUPABASE_ANON_KEY` is the standard
 * companion to the already-used `NEXT_PUBLIC_SUPABASE_URL`; no competing
 * variable is introduced. SUPABASE_SERVICE_ROLE_KEY is deliberately NOT read by
 * this module.
 */
const SUPABASE_URL_VAR = 'NEXT_PUBLIC_SUPABASE_URL';
const SUPABASE_ANON_KEY_VAR = 'NEXT_PUBLIC_SUPABASE_ANON_KEY';

export type AuthFailureCode =
  | 'auth_not_configured'
  | 'authorization_header_missing'
  | 'authorization_scheme_not_bearer'
  | 'bearer_token_empty'
  | 'bearer_token_malformed'
  | 'token_rejected'
  | 'auth_transport_error'
  | 'no_user_for_token'
  | 'user_id_malformed';

export type AuthOutcome =
  | { ok: true; userId: string }
  | { ok: false; code: AuthFailureCode; detail: string };

/** Result of parsing the Authorization header. A clean discriminated union. */
export type BearerParse =
  | { ok: true; token: string }
  | { ok: false; code: AuthFailureCode; detail: string };

/** A verified Supabase user id is a UUID. Anything else is refused. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Strict `Authorization: Bearer <token>` parsing.
 *
 * Refuses a missing header, a non-Bearer scheme, an empty or whitespace-only
 * token, and a header carrying more than one credential — a comma indicates
 * either multiple credentials or duplicate headers joined by the runtime, and
 * either case is ambiguous rather than something to guess at.
 */
export function parseBearerToken(headerValue: string | null): BearerParse {
  if (headerValue === null || headerValue.trim().length === 0) {
    return { ok: false, code: 'authorization_header_missing', detail: 'no Authorization header' };
  }
  if (headerValue.includes(',')) {
    return { ok: false, code: 'bearer_token_malformed', detail: 'ambiguous or duplicated credential' };
  }
  const match = /^Bearer[ \t]+(\S.*)$/.exec(headerValue.trim());
  if (!match) {
    if (/^Bearer[ \t]*$/i.test(headerValue.trim())) {
      return { ok: false, code: 'bearer_token_empty', detail: 'Bearer scheme with no token' };
    }
    return { ok: false, code: 'authorization_scheme_not_bearer', detail: 'scheme is not Bearer' };
  }
  const token = match[1].trim();
  if (token.length === 0) {
    return { ok: false, code: 'bearer_token_empty', detail: 'token is empty' };
  }
  if (/\s/.test(token)) {
    return { ok: false, code: 'bearer_token_malformed', detail: 'token contains whitespace' };
  }
  return { ok: true, token };
}

let cachedAuthClient: SupabaseClient | null = null;

/** Anon-key client, created lazily so an unconfigured environment fails closed. */
function authClient(): SupabaseClient | null {
  if (cachedAuthClient) return cachedAuthClient;
  const url = process.env[SUPABASE_URL_VAR];
  const anonKey = process.env[SUPABASE_ANON_KEY_VAR];
  if (!url || !anonKey) return null;
  cachedAuthClient = createClient(url, anonKey, { auth: { persistSession: false } });
  return cachedAuthClient;
}

/** Test seam: inject a client without reaching Supabase. Never used in production. */
export function UNSAFE_setAuthClientForTests(client: SupabaseClient | null): void {
  cachedAuthClient = client;
}

/**
 * Verifies a bearer token and returns the Supabase `auth.users.id`.
 *
 * The token is the ONLY input. Nothing from the request body, query string,
 * cookies or environment can influence the returned identity, and the token
 * itself is never logged or echoed in a failure detail.
 */
export async function authenticateReviewer(authorizationHeader: string | null): Promise<AuthOutcome> {
  const parsed = parseBearerToken(authorizationHeader);
  if (!parsed.ok) return parsed;

  const client = authClient();
  if (!client) {
    return { ok: false, code: 'auth_not_configured', detail: `${SUPABASE_ANON_KEY_VAR} is not configured` };
  }

  let data: { user: { id?: unknown } | null } | null = null;
  let error: unknown = null;
  try {
    const result = await client.auth.getUser(parsed.token);
    data = result.data as { user: { id?: unknown } | null } | null;
    error = result.error;
  } catch {
    return { ok: false, code: 'auth_transport_error', detail: 'auth verification failed to complete' };
  }

  // The existing readiness route destructures only `data` and ignores `error`.
  // An expired or invalid token surfaces here, so it must be inspected.
  if (error) return { ok: false, code: 'token_rejected', detail: 'token was not accepted' };
  const user = data?.user ?? null;
  if (!user) return { ok: false, code: 'no_user_for_token', detail: 'no user for this token' };
  if (typeof user.id !== 'string' || !UUID.test(user.id)) {
    return { ok: false, code: 'user_id_malformed', detail: 'verified user id is not a uuid' };
  }
  return { ok: true, userId: user.id };
}
