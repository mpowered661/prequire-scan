// Human Review & Approval v0.1 — frozen versions, vocabularies and bounds.

export const HRA_VERSION = 'hra-0.1';

/** The only approval capability in v0.1. */
export const PRESENTATION_APPROVE_CAPABILITY = 'presentation.approve';

/** Contract versions this layer accepts. A mismatch fails closed. */
export const ACCEPTED_OPPORTUNITY_REVIEW_VERSION = 'or-0.1';
export const ACCEPTED_QUALIFICATION_VERSION = 'oq-0.1.1';

/**
 * The only temporal frame expressible. BEFORE / AFTER / IMPROVED / FIXED /
 * VERIFIED are deliberately absent, so no retroactive baseline and no
 * verification claim can be represented.
 */
export const TEMPORAL_FRAME = 'CURRENT_STATE' as const;

/** The only presentation mode approvable in v0.1. */
export const APPROVABLE_PRESENTATION_MODE = 'STATEMENT_WITH_DEMONSTRATION' as const;

/** The only demonstrability status approvable in v0.1. */
export const APPROVABLE_DEMONSTRABILITY = 'DEMONSTRABLE' as const;

/** Qualification status required before a claim may be approved. */
export const REQUIRED_QUALIFICATION_STATUS = 'QUALIFIED' as const;

/** Presentation permissions that permit external use. */
export const EXTERNALLY_PRESENTABLE_PERMISSIONS: readonly string[] = Object.freeze([
  'PRESENTABLE',
  'PRESENTABLE_WITH_QUALIFIER',
]);

/** Bounded structured rejection reasons. Not a taxonomy. */
export const REJECTION_REASONS: readonly string[] = Object.freeze([
  'insufficient_presentation_evidence',
  'claim_not_suitable_for_external_use',
  'scope_or_wording_concern',
  'evidence_not_convincing',
  'other_bounded',
]);

/** Bounds. Oversized input is REJECTED, never silently truncated. */
export const MAX_REVIEWER_NOTE_CHARS = 500;
export const MAX_REVIEWED_PROSE_CHARS = 400;

/**
 * Placeholder identities that must never stand in for a reviewer. Retained so a
 * test can assert none of them is reachable as a reviewer identity.
 */
export const FORBIDDEN_REVIEWER_IDENTITIES: readonly string[] = Object.freeze([
  'system', 'admin', 'human', 'reviewer', 'operator', 'prequire', 'unknown', '',
]);

/**
 * States that must remain unrepresentable in this layer. Exported as a negative
 * list so tests can assert absence.
 */
export const UNREPRESENTABLE_STATES: readonly string[] = Object.freeze([
  'APPROVE_WITH_EDIT',
  'REQUEST_MORE_EVIDENCE',
  'APPROVED_FOR_OUTREACH',
  'EMAIL_READY',
  'SEND_READY',
  'CONTACT_READY',
  'CRM_READY',
  'BEFORE',
  'AFTER',
  'IMPROVED',
  'FIXED',
  'VERIFIED',
]);

/** Rejected in any free-text field a reviewer may supply. */
export const MARKUP_PATTERN = /<[^>]*>|<\/|&lt;|&#x3c;/i;
