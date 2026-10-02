// Phase 2b-C3 — the HTTP adapter for a human presentation review.
//
// THIS ROUTE DECIDES NOTHING. It parses JSON once, hands the Authorization
// header and the raw body to the accepted Phase 2b-C2 service, and maps that
// service's bounded result class to a status code. Every contract — forbidden
// fields, UUIDv4, decision types, binding, rejection vocabulary, REVOKE target
// rules — belongs to C2, and is deliberately NOT restated here. A second copy
// would be a second thing to keep in sync, and the weaker copy would win.
//
// THE BODY IS PASSED AS `unknown`, ON PURPOSE. C2's entry point accepts
// `unknown` so that forbidden-field rejection lives inside its trust boundary.
// Casting the body to a typed request here would move that boundary into this
// file and let one `as` defeat it. So the body is neither narrowed, filtered,
// sanitised nor reshaped before the call.
//
// NO IDENTITY IS ESTABLISHED HERE. The header is forwarded verbatim.
// requirePresentationApprove, inside C2, remains the only authority. This route
// never parses a bearer token, never calls auth.getUser, never reads
// operator_capabilities, and never touches a database or an internal shared
// secret. SCAN_INTERNAL_TOKEN and STUDY_MODE_TOKEN gate other, unrelated
// endpoints and are not reviewer authority; neither appears here.
//
// APPROVE_PRESENTATION still authorizes only that one evidence-bound
// proposition for governed external presentation. It authorizes no delivery and
// no execution: nothing is sent, published, remediated or verified by this
// route, and no response field may be read as permission to act.

import { NextResponse, type NextRequest } from 'next/server';
import {
  reviewPresentation,
  type ReviewFailureClass,
} from '@/lib/human-review-server/presentation-review-service';

/**
 * Exhaustive C2-class to status map.
 *
 * Typed as Record<ReviewFailureClass, number> on purpose: if C2 ever adds a
 * nineteenth class, this file stops compiling instead of silently defaulting a
 * new failure to some status nobody chose.
 *
 * Status is selected by CLASS ONLY. `reasons` carries the lower layers' stable
 * codes for an operator to read, and is never consulted here — mapping on it
 * would make the HTTP contract depend on text that belongs to other layers.
 */
const STATUS_BY_FAILURE: Record<ReviewFailureClass, number> = {
  // 400 — the caller sent something this endpoint cannot accept at all.
  request_invalid: 400,

  // 401 / 403 — who is asking, and may they approve.
  unauthenticated: 401,
  forbidden: 403,

  // 404 — the named thing does not exist. Safe to reveal: the caller is already
  // an authenticated operator holding presentation.approve, so existence is not
  // a secret from them.
  scan_not_found: 404,
  opportunity_not_found: 404,

  // 409 — the request is intelligible but conflicts with server state.
  // binding_mismatch is the stale-review case: the human reviewed an older
  // packet. ambiguous_opportunity is conflicting server state. The REVOKE class
  // is predominantly a state conflict (target is itself a revocation, is not
  // strictly earlier, binds different evidence, or nothing stands), so it maps
  // here as one deterministic class rather than being split by reason.
  binding_mismatch: 409,
  ambiguous_opportunity: 409,
  revoke_target_invalid: 409,
  idempotency_conflict: 409,

  // 422 — well-formed, server healthy, but the decision cannot be performed
  // under the current review contract. Two kinds share this, under one rule:
  //   the decision itself is not representable or not permitted
  //     decision_invalid, approval_not_eligible, snapshot_not_derivable
  //   the persisted evidence or history cannot be faithfully reconstructed
  //     rederivation_failed, invalid_packet_identity, history_failed
  // The second kind is not the caller's fault, but it is also not an outage or
  // a misconfiguration: the stored material simply cannot yield a decision, and
  // retrying the same request will not change that.
  decision_invalid: 422,
  approval_not_eligible: 422,
  snapshot_not_derivable: 422,
  rederivation_failed: 422,
  invalid_packet_identity: 422,
  history_failed: 422,

  // 500 — this deployment or this server is at fault, not the caller.
  // persistence_failed covers write refusals that mean C2 handed the database a
  // payload it should never have built, which is a server defect.
  server_misconfiguration: 500,
  persistence_failed: 500,

  // 502 — a dependency failed: token verification, the capability store, the
  // history read, or the write RPC, including an unrecognised RPC outcome.
  upstream_failure: 502,
};

/**
 * Route-level reason codes, for the two conditions that never reach C2.
 *
 * `malformed_json_body` reuses C2's own `request_invalid` class rather than
 * inventing a nineteenth one, so a caller sees one closed vocabulary.
 * `unexpected_error` is its own class because no C2 class honestly describes
 * "this route caught something it did not anticipate"; reusing one would
 * mislabel the fault.
 */
const MALFORMED_JSON = Object.freeze({
  ok: false as const, failure: 'request_invalid' as const, reasons: ['malformed_json_body'],
});
const UNEXPECTED = Object.freeze({
  ok: false as const, failure: 'unexpected_error' as const, reasons: [] as string[],
});

/**
 * POST only. The App Router exposes just the methods a module exports, so any
 * other verb already returns 405 and no method machinery is added here.
 */
export async function POST(req: NextRequest) {
  // Parsed once, before C2 is reached, and refused without echoing the parser's
  // own message — which can quote the offending bytes.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(MALFORMED_JSON, { status: 400 });
  }

  try {
    // Header forwarded verbatim, body forwarded unnarrowed.
    const result = await reviewPresentation(req.headers.get('authorization'), body);

    if (result.ok) {
      // Returned exactly as C2 produced it. No field is added, renamed or
      // reinterpreted, so nothing here can imply an action was taken.
      return NextResponse.json(result, { status: 200 });
    }

    return NextResponse.json(result, { status: STATUS_BY_FAILURE[result.failure] });
  } catch {
    // The HTTP containment boundary. Whatever was thrown is deliberately not
    // read: no message, no stack, no cause, no database text. Nothing is logged
    // either, because the value could carry a token or a connection string.
    return NextResponse.json(UNEXPECTED, { status: 500 });
  }
}
