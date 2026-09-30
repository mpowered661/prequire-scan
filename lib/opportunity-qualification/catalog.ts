// Opportunity Qualification v0.1 — the opportunity-type catalog.
//
// One static, frozen entry per (detector, condition). Gates, priority, claims
// and outreach all read this registry, so every decision traces to a declared
// property of the type rather than to ad-hoc logic. An unlisted type fails
// closed: no remediation, no verification path, no claim template.

import type { EvidenceCluster, RemediationDescriptor, VerificationDescriptor } from './types';

export interface CatalogEntry {
  /** A remediation class, or null when nothing can be remediated. */
  remediationClass: string | null;
  requiredCapability: string | null;
  /** How a later tranche would re-measure this condition. null ⇒ no path. */
  verificationMethod: string | null;
  /**
   * True when the condition only matters if one also asserts an effect on
   * traffic, ranking, indexing, citation, revenue or compliance. Such a type
   * cannot pass outreach gate O9.
   */
  requiresImpactInference: boolean;
  /**
   * True when stating the headline without additional context would mislead by
   * omission. Such a type cannot pass outreach gate O10.
   */
  misleadingWithoutContext: boolean;
  /** Context that must accompany the claim when misleadingWithoutContext. */
  requiredContext: string | null;
  /**
   * True when a third party could independently reproduce the condition from
   * the named subject alone, using only durable evidence.
   */
  independentlyReproducible: boolean;
  /** Why presentation evidence is or is not available. */
  presentationReason: string;
  /** True when a non-specialist understands the statement without training. */
  plainLanguage: boolean;
  /** Human-readable noun phrase for claim templates. */
  label: string;
}

const UNKNOWN: CatalogEntry = Object.freeze({
  remediationClass: null,
  requiredCapability: null,
  verificationMethod: null,
  requiresImpactInference: true,
  misleadingWithoutContext: true,
  requiredContext: null,
  independentlyReproducible: false,
  presentationReason: 'unknown_opportunity_type',
  plainLanguage: false,
  label: 'an unrecognized condition',
});

export const CATALOG: Readonly<Record<string, CatalogEntry>> = Object.freeze({
  'broken_internal_target:broken_4xx': Object.freeze({
    remediationClass: 'link_destination_repair',
    requiredCapability: 'site_content_edit',
    verificationMethod: 're_check_target_and_compare_classification',
    requiresImpactInference: false,
    misleadingWithoutContext: false,
    requiredContext: null,
    independentlyReproducible: true,
    presentationReason: 'the destination URL can be requested by anyone and returns the recorded status',
    plainLanguage: true,
    label: 'a link destination that returned an error when checked',
  }),
  'broken_internal_target:server_failure_5xx': Object.freeze({
    remediationClass: 'link_destination_repair',
    requiredCapability: 'site_content_edit',
    verificationMethod: 're_check_target_and_compare_classification',
    requiresImpactInference: false,
    misleadingWithoutContext: false,
    requiredContext: null,
    independentlyReproducible: true,
    presentationReason: 'the destination URL can be requested by anyone and returns the recorded status',
    plainLanguage: true,
    label: 'a link destination that returned a server error when checked',
  }),
  'page_check_failure:check_failed': Object.freeze({
    remediationClass: 'content_entity_clarification',
    requiredCapability: 'site_content_edit',
    verificationMethod: 'rerun_same_engine_version_and_compare_check_status',
    requiresImpactInference: false,
    misleadingWithoutContext: false,
    requiredContext: null,
    // Tranche D2 deliberately does not retain the offending text, so no
    // concrete example can be shown from durable evidence.
    independentlyReproducible: false,
    presentationReason: 'durable evidence records that the check failed but retains no example, by design (Tranche D2)',
    plainLanguage: false,
    label: 'a page-analysis check that did not pass',
  }),
  'extraction_band:fragile': Object.freeze({
    remediationClass: 'content_entity_clarification',
    requiredCapability: 'site_content_edit',
    verificationMethod: 'rerun_same_engine_version_and_compare_band',
    requiresImpactInference: false,
    misleadingWithoutContext: false,
    requiredContext: null,
    independentlyReproducible: false,
    presentationReason: 'the band is a composite engine verdict; durable evidence retains no showable instance',
    plainLanguage: false,
    label: 'an extraction-resilience band',
  }),
  'content_delivery_condition:client_side_rendered': Object.freeze({
    remediationClass: 'content_architecture',
    requiredCapability: 'site_build_change',
    verificationMethod: 'rerun_delivery_measurement_and_compare_ratio',
    // This condition is only meaningful to a prospect if one also asserts that
    // some crawler or AI system therefore fails to read the page. That
    // assertion is not supported by v0.1 evidence.
    requiresImpactInference: true,
    misleadingWithoutContext: true,
    requiredContext: 'the same pages were also recorded as containing rendered content',
    independentlyReproducible: true,
    presentationReason: 'the ratio is recomputable from the page, but the headline requires unsupported context',
    plainLanguage: false,
    label: 'a low text-to-HTML ratio',
  }),
  'structured_data_presence:structured_data_absent': Object.freeze({
    remediationClass: 'structured_data_remediation',
    requiredCapability: 'site_content_edit',
    verificationMethod: 'rerun_structured_data_extraction_and_compare_presence',
    requiresImpactInference: false,
    misleadingWithoutContext: false,
    requiredContext: null,
    independentlyReproducible: true,
    presentationReason: 'absence of a JSON-LD block is reproducible from the page source',
    plainLanguage: true,
    label: 'pages carrying no structured data',
  }),
  'structured_data_presence:structured_data_malformed': Object.freeze({
    remediationClass: 'structured_data_remediation',
    requiredCapability: 'site_content_edit',
    verificationMethod: 'rerun_structured_data_extraction_and_compare_malformed',
    requiresImpactInference: false,
    misleadingWithoutContext: false,
    requiredContext: null,
    independentlyReproducible: true,
    presentationReason: 'a malformed JSON-LD block is reproducible from the page source',
    plainLanguage: true,
    label: 'structured data that could not be parsed',
  }),
  // A healthy state. There is nothing to remediate and nothing to verify, so it
  // can never become an adverse opportunity.
  'structured_data_presence:structured_data_present': Object.freeze({
    remediationClass: null,
    requiredCapability: null,
    verificationMethod: null,
    requiresImpactInference: false,
    misleadingWithoutContext: false,
    requiredContext: null,
    independentlyReproducible: true,
    presentationReason: 'healthy state; no adverse condition to demonstrate',
    plainLanguage: true,
    label: 'structured data present',
  }),
  // The measurement could not establish a state. Not a failure.
  'page_check_undeterminable:check_undeterminable': Object.freeze({
    remediationClass: null,
    requiredCapability: null,
    verificationMethod: null,
    requiresImpactInference: false,
    misleadingWithoutContext: true,
    requiredContext: 'the check could not establish a state; this is not a failure',
    independentlyReproducible: false,
    presentationReason: 'undeterminable state; there is no established condition to demonstrate',
    plainLanguage: false,
    label: 'a check that could not be determined',
  }),
});

export function catalogKey(cluster: Pick<EvidenceCluster, 'detector' | 'condition'>): string {
  return `${cluster.detector}:${cluster.condition}`;
}

/** Unknown types fail closed to UNKNOWN rather than throwing. */
export function catalogFor(cluster: Pick<EvidenceCluster, 'detector' | 'condition'>): CatalogEntry {
  return CATALOG[catalogKey(cluster)] ?? UNKNOWN;
}

export function isKnownType(cluster: Pick<EvidenceCluster, 'detector' | 'condition'>): boolean {
  return Object.prototype.hasOwnProperty.call(CATALOG, catalogKey(cluster));
}

export function remediationDescriptor(entry: CatalogEntry): RemediationDescriptor | null {
  if (!entry.remediationClass || !entry.requiredCapability) return null;
  return {
    remediationClass: entry.remediationClass,
    requiredCapability: entry.requiredCapability,
    authorizationRequired: true,
    performed: false,
  };
}

export function verificationDescriptor(entry: CatalogEntry): VerificationDescriptor | null {
  if (!entry.verificationMethod) return null;
  return {
    method: entry.verificationMethod,
    comparesAgainst: 'remediation_baseline',
    possibleOutcomes: ['measured_change', 'unchanged_result', 'no_longer_comparable', 'unknown'],
    performed: false,
    baselineCaptured: false,
  };
}
