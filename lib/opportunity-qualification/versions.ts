// Opportunity Qualification v0.1 — frozen versions and registries.

export const QUALIFICATION_VERSION = 'oq-0.1.1';

/** Detector ids and their versions. An unknown detector fails closed. */
export const DETECTORS = Object.freeze({
  broken_internal_target: 'det-broken-target-0.1',
  page_check_failure: 'det-page-check-0.1',
  page_check_undeterminable: 'det-page-check-undet-0.1',
  extraction_band: 'det-extraction-band-0.1',
  content_delivery_condition: 'det-content-delivery-0.1',
  structured_data_presence: 'det-structured-data-0.1',
} as const);

export type DetectorId = keyof typeof DETECTORS;

export const KNOWN_DETECTORS: readonly string[] = Object.freeze(Object.keys(DETECTORS));

/** Scope levels a v0.1 signal may carry. Anything else fails closed. */
export const KNOWN_SCOPE_LEVELS: readonly string[] = Object.freeze([
  'page', 'analyzed_sample', 'checked_targets', 'discovered', 'site',
]);

/**
 * A condition is counted as repeated across the analyzed sample when it holds
 * on MORE than half of it. Used only by technical priority (T2 vs T3).
 */
export const MAJORITY_THRESHOLD = 0.5;

/** Engine names whose durable observations v0.1 reads. */
export const READ_ENGINES: readonly string[] = Object.freeze([
  'extraction_resilience', 'structured_data', 'content_delivery', 'meta_tags',
]);

/** Claim classes that may never be presented externally. */
export const NEVER_EXTERNAL: readonly string[] = Object.freeze(['HYPOTHESIS', 'PROHIBITED']);

/**
 * Claim propositions that are prohibited in every context, for every
 * opportunity type, regardless of evidence available in v0.1.
 */
export const PROHIBITED_CLAIM_CLASSES: readonly string[] = Object.freeze([
  'full_site_coverage',
  'search_ranking_impact',
  'traffic_impact',
  'conversion_impact',
  'ai_citation_impact',
  'ai_recommendation_impact',
  'revenue_impact',
  'causation',
  'competitive_disadvantage',
  'customer_loss',
  'seo_penalty',
  'legal_compliance_failure',
  'accessibility_compliance_failure',
]);
