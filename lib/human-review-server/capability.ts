// The ONE production minting boundary for TrustedReviewerIdentity.
//
// ████████████████████████████████████████████████████████████████████████
// ██  THIS FILE CONTAINS THE ONLY PRODUCTION ASSERTION THAT CAN PRODUCE   ██
// ██  A TrustedReviewerIdentity. Nothing else in production may cast.     ██
// ████████████████████████████████████████████████████████████████████████
//
// There is deliberately NO exported function that takes an arbitrary string and
// brands it. The mint is COUPLED to proof: a caller cannot obtain the branded
// type without having already passed a bearer token through
// `authenticateReviewer`, and without an active capability row existing for the
// resulting user id. Route code therefore has no reachable path that brands
// request data.
//
// What this does NOT establish: that any human may be approved of, that the
// reviewer may act on a particular packet, or that any decision has been made.
// Capability is a gate on being ASKED, exactly as the frozen layer's
// `impliesApproval: false` makes explicit.
//
// TRUST SEPARATION. The anon-key client in ./trusted-reviewer.ts answers WHO.
// The service-role client here answers WHETHER THAT USER HOLDS THE CAPABILITY,
// and it receives ONLY an already-verified user id as input — never a request
// body, header, email, scan id or opportunity id.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { TrustedReviewerIdentity } from '../human-review/future-identity';
import { PRESENTATION_APPROVE_CAPABILITY } from '../human-review/versions';
import { authenticateReviewer, type AuthFailureCode } from './trusted-reviewer';

const TABLE = 'operator_capabilities';

export type CapabilityFailureCode =
  | AuthFailureCode
  | 'capability_store_not_configured'
  | 'capability_absent'
  | 'capability_revoked'
  | 'capability_lookup_failed'
  | 'capability_row_malformed';

export type ReviewerAuthorization =
  | { ok: true; reviewer: TrustedReviewerIdentity; userId: string }
  | { ok: false; code: CapabilityFailureCode; detail: string };

let cachedStoreClient: SupabaseClient | null = null;

/** Privileged client, lazily built so an unconfigured environment fails closed. */
function storeClient(): SupabaseClient | null {
  if (cachedStoreClient) return cachedStoreClient;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  cachedStoreClient = createClient(url, serviceKey);
  return cachedStoreClient;
}

/** Test seam: inject a client without reaching Supabase. Never used in production. */
export function UNSAFE_setCapabilityClientForTests(client: SupabaseClient | null): void {
  cachedStoreClient = client;
}

export type CapabilityState =
  | { ok: true }
  | { ok: false; code: CapabilityFailureCode; detail: string };

/**
 * Does this ALREADY-VERIFIED user id currently hold an active
 * `presentation.approve`?
 *
 * Active means a row exists for (user_id, capability) with `revoked_at IS NULL`.
 * The composite primary key makes duplicate rows structurally impossible, so a
 * single-row read is sufficient; a malformed or unexpected row is refused
 * rather than interpreted.
 *
 * Fails closed on every uncertainty: absent row, revoked row, lookup error,
 * unconfigured store, or a row whose capability is not the expected one.
 */
export async function hasActivePresentationApprove(verifiedUserId: string): Promise<CapabilityState> {
  const client = storeClient();
  if (!client) {
    return { ok: false, code: 'capability_store_not_configured', detail: 'capability store is not configured' };
  }
  try {
    const { data, error } = await client
      .from(TABLE)
      .select('user_id, capability, revoked_at')
      .eq('user_id', verifiedUserId)
      .eq('capability', PRESENTATION_APPROVE_CAPABILITY)
      .maybeSingle();

    if (error) return { ok: false, code: 'capability_lookup_failed', detail: error.code ?? 'unknown' };
    if (!data) return { ok: false, code: 'capability_absent', detail: 'no presentation.approve for this user' };

    const row = data as Record<string, unknown>;
    if (row.user_id !== verifiedUserId || row.capability !== PRESENTATION_APPROVE_CAPABILITY) {
      return { ok: false, code: 'capability_row_malformed', detail: 'row does not match the requested identity' };
    }
    if (row.revoked_at !== null && row.revoked_at !== undefined) {
      return { ok: false, code: 'capability_revoked', detail: 'presentation.approve was revoked' };
    }
    return { ok: true };
  } catch {
    return { ok: false, code: 'capability_lookup_failed', detail: 'transport' };
  }
}

/**
 * THE MINT. Authenticates the bearer token, proves active capability, and only
 * then brands the verified user id as a TrustedReviewerIdentity.
 *
 * The single assertion below is the one production mint in the repository. It is
 * unreachable without both proofs above, which is why no string-taking factory
 * is exported.
 */
export async function requirePresentationApprove(
  authorizationHeader: string | null,
): Promise<ReviewerAuthorization> {
  const authenticated = await authenticateReviewer(authorizationHeader);
  if (!authenticated.ok) return { ok: false, code: authenticated.code, detail: authenticated.detail };

  const capability = await hasActivePresentationApprove(authenticated.userId);
  if (!capability.ok) return { ok: false, code: capability.code, detail: capability.detail };

  // ── the only production mint ───────────────────────────────────────────────
  // Verified by Supabase AND confirmed to hold an active presentation.approve.
  const reviewer = authenticated.userId as unknown as TrustedReviewerIdentity;
  // ──────────────────────────────────────────────────────────────────────────

  return { ok: true, reviewer, userId: authenticated.userId };
}
