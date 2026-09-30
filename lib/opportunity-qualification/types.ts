// Opportunity Qualification v0.1 — types.
//
// Input types are declared STRUCTURALLY here rather than imported from the
// scanner modules, so that qualification depends only on DURABLE evidence
// shapes and can never acquire a hidden dependency on a transient Tranche D
// artifact (raw HTML, an engine instance, a fetch response). The accepted
// Tranche A coupling guard in discover.test.ts enforces this boundary by
// scanning for the scanner's module path, so this file must not name it.

// ── input: durable A+B+C+D evidence ──────────────────────────

/** One durable page-engine observation row (Tranche D, post-projection). */
export interface DurablePageObservation {
  scanId: string;
  requestedUrl: string;
  finalUrl: string;
  engine: string;
  engineVersion: string;
  contentSha256: string;
  status: 'ok' | 'failed';
  errorReason: string | null;
  observedAt: string;
  scope: 'page';
  /** The projected durable evidence. Never raw HTML, never page prose. */
  observation: unknown;
}

/** One durable link-target observation row (Tranche C). */
export interface DurableTargetObservation {
  targetUrlNormalized: string;
  checkState: 'checked' | 'unchecked';
  uncheckedReason: string | null;
  classification: 'healthy' | 'redirected' | 'broken_4xx' | 'server_failure_5xx' | 'blocked' | 'timeout' | 'undeterminable' | null;
  httpStatus: number | null;
  redirectTargetUrl: string | null;
  redirectLeftOrigin: boolean | null;
  redirectHops: number;
  methodUsed: string | null;
  sourceLinkCount: number;
  checkedAt: string | null;
}

/** One durable source→target link relationship (Tranche C). */
export interface DurableLinkRelationship {
  sourceUrl: string;
  targetUrlNormalized: string | null;
  anchorText: string | null;
  placement: 'footer' | 'nav' | 'body' | 'unknown';
  internal: boolean;
}

/** One durable inventory row (Tranches A+B+D). */
export interface DurableScanUrl {
  urlNormalized: string | null;
  httpStatus: number | null;
  contentSha256: string | null;
  fetchState: string;
  analysisState: 'not_attempted' | 'partial' | 'complete' | 'failed';
  analyzed: boolean;
}

/** Coverage context. Every denominator a claim may use lives here. */
export interface CoverageContext {
  discovered: number;
  selected: number;
  fetched: number;
  analysisComplete: number;
  uniqueInternalTargets: number;
  targetsChecked: number;
  targetsUnchecked: number;
  /** False whenever the site's true page count is not established. */
  siteTotalKnown: boolean;
}

export interface QualificationInput {
  scanId: string;
  scanMode: 'prospect_observation' | 'authorized_customer_scan';
  domain: string;
  coverage: CoverageContext;
  scanUrls: DurableScanUrl[];
  pageObservations: DurablePageObservation[];
  linkTargets: DurableTargetObservation[];
  linkRelationships: DurableLinkRelationship[];
}

// ── evidence references ──────────────────────────────────────

export type EvidenceKind = 'page_observation' | 'link_target' | 'link_relationship';

export interface EvidenceRef {
  kind: EvidenceKind;
  scanId: string;
  /** The URL the evidence is bound to: a page URL or a normalized target URL. */
  subjectUrl: string;
  engine: string | null;
  engineVersion: string | null;
  contentSha256: string | null;
  scope: 'page' | 'link_target' | 'link_relationship';
  observedAt: string | null;
}

// ── scope ────────────────────────────────────────────────────

export type ScopeLevel = 'page' | 'analyzed_sample' | 'checked_targets' | 'discovered' | 'site';

/**
 * Bounded scalar facts a claim template may cite. Scalars only — never page
 * prose, never raw HTML, never a free-text excerpt from the source page.
 */
export type ScalarFacts = Readonly<Record<string, string | number | boolean | null>>;

// ── signal ───────────────────────────────────────────────────

/** Whether the observed state is adverse, healthy, or not established. */
export type ConditionPolarity = 'adverse' | 'healthy' | 'indeterminate';

/**
 * A normalized condition derived from observations. A signal is a fact about
 * the evidence. It carries no severity, no outreach decision and no claim.
 */
export interface Signal {
  detector: string;
  detectorVersion: string;
  signalKey: string;
  subject: string;
  condition: string;
  polarity: ConditionPolarity;
  scopeLevel: ScopeLevel;
  numerator: number | null;
  denominator: number | null;
  /** False when the underlying measurement could not establish the state. */
  determinable: boolean;
  undeterminableCount: number;
  evidenceRefs: EvidenceRef[];
  /** Provenance class contributed by this signal's evidence. */
  provenance: ProvenanceClass;
  facts: ScalarFacts;
}

// ── confidence ───────────────────────────────────────────────

/** Canonical six-class customer-facing provenance vocabulary. */
export type ProvenanceClass =
  | 'verified'
  | 'customer_provided'
  | 'extracted'
  | 'inferred'
  | 'unverified'
  | 'undeterminable';

// ── cluster ──────────────────────────────────────────────────

export interface EvidenceCluster {
  clusterKey: string;
  opportunityKey: string;
  evidenceFingerprint: string;
  scanId: string;
  detector: string;
  detectorVersion: string;
  subject: string;
  condition: string;
  polarity: ConditionPolarity;
  scopeLevel: ScopeLevel;
  numerator: number | null;
  denominator: number | null;
  /** Distinct pages exhibiting the condition. */
  affectedPageCount: number;
  /** Source link relationships pointing at the subject, where applicable. */
  sourceLinkCount: number;
  determinable: boolean;
  undeterminableCount: number;
  signalKeys: string[];
  evidenceRefs: EvidenceRef[];
  provenance: ProvenanceClass;
  facts: ScalarFacts;
}

// ── gates ────────────────────────────────────────────────────

export type GateId = 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6' | 'G7' | 'G8' | 'G9' | 'G10' | 'G11' | 'G12';

export interface GateResult {
  gate: GateId;
  name: string;
  passed: boolean;
  reason: string;
}

// ── priority / outreach ──────────────────────────────────────

export type TechnicalPriority = 'T1' | 'T2' | 'T3' | 'T_NONE';

export type OutreachGateId = 'O1' | 'O2' | 'O3' | 'O4' | 'O5' | 'O6' | 'O7' | 'O8' | 'O9' | 'O10';

export type OutreachGateVerdict = 'pass' | 'uncertain' | 'fail';

export interface OutreachGateResult {
  gate: OutreachGateId;
  name: string;
  verdict: OutreachGateVerdict;
  reason: string;
}

/**
 * The highest state software alone may reach is ELIGIBLE_FOR_HUMAN_REVIEW.
 * APPROVED_FOR_OUTREACH is not representable in v0.1 — approval belongs to a
 * later persistent workflow tranche.
 */
export type OutreachSuitability = 'ELIGIBLE_FOR_HUMAN_REVIEW' | 'NEEDS_HUMAN_REVIEW' | 'NOT_ELIGIBLE';

// ── claims ───────────────────────────────────────────────────

export type ClaimClass = 'DIRECT_OBSERVATION' | 'BOUNDED_INTERPRETATION' | 'HYPOTHESIS' | 'PROHIBITED';

export interface Claim {
  claimClass: ClaimClass;
  text: string;
  /** Evidence refs backing this exact sentence. Empty ⇒ PROHIBITED. */
  evidenceRefs: EvidenceRef[];
  /** HYPOTHESIS and PROHIBITED are never externally presentable. */
  externallyPresentable: boolean;
}

// ── remediation / verification descriptors (descriptors only) ─

export interface RemediationDescriptor {
  remediationClass: string;
  requiredCapability: string;
  authorizationRequired: true;
  /** Remediation is NOT performed by this tranche. Always false. */
  performed: false;
}

export interface VerificationDescriptor {
  method: string;
  comparesAgainst: 'remediation_baseline';
  possibleOutcomes: readonly ['measured_change', 'unchanged_result', 'no_longer_comparable', 'unknown'];
  /** Verification is NOT performed by this tranche. Always false. */
  performed: false;
  baselineCaptured: false;
}

// ── result ───────────────────────────────────────────────────

export type QualificationStatus = 'QUALIFIED' | 'NOT_QUALIFIED';

export interface OpportunityResult {
  opportunityKey: string;
  evidenceFingerprint: string;
  scanId: string;
  scanMode: string;
  detector: string;
  detectorVersion: string;
  subject: string;
  condition: string;
  polarity: ConditionPolarity;
  scopeLevel: ScopeLevel;
  numerator: number | null;
  denominator: number | null;
  affectedPageCount: number;
  sourceLinkCount: number;
  signalKeys: string[];
  evidenceRefs: EvidenceRef[];
  facts: ScalarFacts;

  status: QualificationStatus;
  gateResults: GateResult[];
  firstFailedGate: GateId | null;

  technicalPriority: TechnicalPriority;
  confidence: ProvenanceClass;

  outreachSuitability: OutreachSuitability;
  outreachGateResults: OutreachGateResult[];

  /**
   * Whether current durable evidence contains an externally showable instance
   * of the condition. Never affects qualification.
   */
  presentationEvidenceAvailable: boolean;
  presentationEvidenceReason: string;

  allowedClaims: Claim[];
  prohibitedClaimClasses: string[];

  remediation: RemediationDescriptor | null;
  verification: VerificationDescriptor | null;

  coverage: CoverageContext;
}

export interface QualificationResult {
  qualificationVersion: string;
  scanId: string;
  scanMode: string;
  domain: string;
  coverage: CoverageContext;
  signals: Signal[];
  clusters: EvidenceCluster[];
  opportunities: OpportunityResult[];
  /** Zero-network is a hard property of this engine. */
  networkRequestsMade: 0;
}
