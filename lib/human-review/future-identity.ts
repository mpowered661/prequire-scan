// Human Review & Approval v0.1 — the trust boundary for reviewer identity.
//
// `TrustedReviewerIdentity` represents a reviewer identity that a FUTURE
// authenticated server boundary (Phase 2b) has already verified by calling
// `supabase.auth.getUser(token)` and then checking the operator capability.
//
// THIS MODULE DELIBERATELY PROVIDES NO WAY TO CREATE ONE.
//
// There is no `trustedReviewerFromString`, `fromEmail`, `fromRequest`,
// `fromBody`, `fromUuid`, `asTrustedReviewer`, or any equivalent escape hatch.
// The brand is a unique symbol that is declared but never assigned, so the only
// way to produce the type is a deliberate type assertion — which is visible in
// code review and is confined to test-only builders by the adversarial suite.
//
// Phase 2a authenticates nobody. It validates already-trusted identities only
// where a supplied fixture or a future server boundary would provide one.

declare const TRUSTED_REVIEWER_BRAND: unique symbol;

/**
 * A Prequire OPERATOR identity, verified server-side. Never the observed
 * subject, the website owner, the customer, the prospect, or a scan identifier.
 *
 * Phase 2b alone may mint this, inside a route, after:
 *   1. supabase.auth.getUser(bearer)  -> auth.users.id
 *   2. operator capability lookup     -> presentation.approve
 */
export type TrustedReviewerIdentity = string & {
  readonly [TRUSTED_REVIEWER_BRAND]: 'verified_prequire_operator';
};

/**
 * The capability a reviewer must have held AT DECISION TIME. Phase 2a does not
 * verify this against any store — it only validates that a supplied trusted
 * decision records it. Real authorization is Phase 2b.
 */
export type ReviewerCapability = 'presentation.approve';

/**
 * Whether a supplied decision records the capability the contract requires.
 * This is a validation of supplied data, not an authorization check.
 */
export function recordsRequiredCapability(capability: string): capability is ReviewerCapability {
  return capability === 'presentation.approve';
}

/**
 * Read-only inspection of a trusted identity, for audit rendering. Takes an
 * already-trusted value; it cannot create one.
 */
export function reviewerIdentityValue(identity: TrustedReviewerIdentity): string {
  return identity as string;
}
