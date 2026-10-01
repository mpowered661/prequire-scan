// Opportunity Review & Presentation v0.1 — frozen versions and bounds.

export const REVIEW_CONTRACT_VERSION = 'or-0.1';

/**
 * Human approval is NOT representable in v0.1. This literal is carried on every
 * derived packet so a consumer cannot mistake technical eligibility for a
 * recorded human decision.
 */
export const HUMAN_APPROVAL_STATE = 'UNREPRESENTABLE_IN_V0_1' as const;

/** The only temporal frame v0.1 may express. No retroactive BEFORE/AFTER. */
export const TEMPORAL_FRAME = 'CURRENT_STATE' as const;

/** Maximum characters of approved prose a future writing layer may submit. */
export const MAX_PROSE_CHARS = 400;

/** Maximum characters of a reviewer note (never externally presentable). */
export const MAX_NOTE_CHARS = 500;

/** Scope words that must accompany a stated count, keyed by scope level. */
export const SCOPE_WORDS = Object.freeze({
  page: 'page',
  analyzed_sample: 'analyzed',
  checked_targets: 'checked',
  discovered: 'discovered',
  site: 'site',
} as const);

/**
 * Scope words that may never appear in externally presentable prose while the
 * site total is unknown.
 */
export const FORBIDDEN_SCOPE_WORDS: readonly string[] = Object.freeze([
  'website', 'whole site', 'entire site', 'all pages', 'every page',
  'across the site', 'sitewide', 'site-wide', 'your links', 'all links',
]);

/**
 * Business-impact and causation lexicon. Stem-matched. None of these may appear
 * in externally presentable prose, because no durable evidence establishes them.
 */
export const PROHIBITED_LEXICON: readonly string[] = Object.freeze([
  'revenue', 'sales', 'customer', 'lead', 'conversion', 'convert',
  'ranking', 'rank', 'seo', 'penalt', 'google', 'index', 'traffic',
  'ai visibility', 'citation', 'cited', 'discoverab',
  'compliance', 'ada', 'wcag', 'lawsuit', 'legal',
  'costing', 'losing', 'lost', 'abandon', 'because of this',
]);

/** No bare percentage or vague magnitude may appear. */
export const BARE_MAGNITUDE_PATTERN = /%|\bpercent\b|\bmost of\b|\bnearly all\b|\ballmost\b|\bmany of your\b/i;

/**
 * v0.1 interface marker between the qualification claims layer and this layer.
 * Qualification embeds required context inline with this prefix; it does not yet
 * expose a structured required-context flag. Documented in the report as a known
 * interface limitation rather than duplicating the qualification catalog here.
 */
export const REQUIRED_CONTEXT_MARKER = 'For completeness:';

/**
 * How a third party could reproduce a condition, per detector. Demonstrability
 * is THIS layer's concern: qualification answers "is the condition real", this
 * answers "can it be shown without inventing anything".
 */
export const REPRODUCTION_METHODS = Object.freeze({
  broken_internal_target: 'request_url_and_observe_status',
  content_delivery_condition: 'recompute_measure_from_page',
  structured_data_presence: 'inspect_page_source',
  extraction_band: 'none_available',
  page_check_failure: 'none_available',
  page_check_undeterminable: 'none_available',
} as const);

/**
 * Detectors whose headline cannot stand without additional context, so their
 * reproducible measurement still yields only LIMITED_DEMONSTRABILITY.
 */
export const CONTEXT_DEPENDENT_DETECTORS: readonly string[] = Object.freeze([
  'content_delivery_condition',
]);

/** Population labels. Two populations must never be conflated. */
export const POPULATION_LABELS = Object.freeze({
  analyzed_pages: 'analyzed_pages',
  checked_link_destinations: 'checked_link_destinations',
} as const);
