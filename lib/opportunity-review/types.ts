// Opportunity Review & Presentation v0.1 — types.
//
// Derive-only. Nothing here can represent a completed human approval: see
// `future-contract.ts` for why ReviewDecision and PresentationSnapshot are
// structurally unconstructible in v0.1.

import type { HUMAN_APPROVAL_STATE, TEMPORAL_FRAME } from './versions';

// ── claim axes — orthogonal, never collapsed ─────────────────

/** Axis 1, inherited unchanged from Qualification v0.1. */
export type EpistemicClass = 'DIRECT_OBSERVATION' | 'BOUNDED_INTERPRETATION' | 'HYPOTHESIS' | 'PROHIBITED';

/** Axis 2, introduced by this layer. */
export type PresentationPermission =
  | 'PRESENTABLE'
  | 'PRESENTABLE_WITH_QUALIFIER'
  | 'INTERNAL_ONLY'
  | 'NOT_PRESENTABLE';

// ── demonstrability ──────────────────────────────────────────

export type DemonstrabilityStatus = 'DEMONSTRABLE' | 'LIMITED_DEMONSTRABILITY' | 'NOT_DEMONSTRABLE';

export type ReproductionMethod =
  | 'request_url_and_observe_status'
  | 'recompute_measure_from_page'
  | 'inspect_page_source'
  | 'none_available';

export type PresentationMode = 'STATEMENT_ONLY' | 'STATEMENT_WITH_DEMONSTRATION';

export interface DemonstrationEvidence {
  status: DemonstrabilityStatus;
  /** Carried verbatim from qualification; never rewritten. */
  reason: string;
  reproductionMethod: ReproductionMethod;
  /** Subset of evidence refs a third party could verify. Refs only. */
  showableRefs: EvidenceRefView[];
  requiresAdditionalContext: boolean;
}

// ── evidence, refs only — never content ──────────────────────

export interface EvidenceRefView {
  kind: string;
  scanId: string;
  subjectUrl: string;
  engine: string | null;
  engineVersion: string | null;
  contentSha256: string | null;
  scope: string;
  observedAt: string | null;
}

// ── canonical claim — the structured, hashable meaning ───────

export interface Population {
  label: string;
  numerator: number;
  denominator: number;
}

export type ClaimType =
  | 'checked_target_status'
  | 'sample_check_failure'
  | 'sample_band_assignment'
  | 'sample_measure_threshold'
  | 'sample_condition_presence';

export type ClaimMetric =
  | 'http_status'
  | 'check_status'
  | 'band'
  | 'text_html_ratio_threshold'
  | 'condition_present';

/**
 * The structured meaning of a claim, separate from its prose. Approval binds
 * this — not the wording — so a copy-edit cannot invalidate an approval while a
 * meaning-changing rewrite cannot slip through.
 */
export interface CanonicalClaim {
  claimType: ClaimType;
  subject: string;
  scopeLevel: string;
  condition: string;
  metric: ClaimMetric;
  observedValue: string;
  /** Observation date from the evidence. Never a wall clock. */
  observedAt: string | null;
  temporalFrame: typeof TEMPORAL_FRAME;
  /** Ordered by label. Two populations are never conflated. */
  populations: Population[];
  /** Ordered enum list. */
  qualifiers: string[];
  epistemicClass: EpistemicClass;
  presentationPermission: PresentationPermission;
  detector: string;
  detectorVersion: string;
  /** Hash of the deduplicated, sorted evidence refs. */
  evidenceRefsHash: string;
}

export interface ClaimCandidate {
  canonicalClaim: CanonicalClaim;
  claimHash: string;
  epistemicClass: EpistemicClass;
  presentationPermission: PresentationPermission;
  /** Template prose derived from the canonical claim. Not the identity. */
  prose: string;
  proseHash: string;
  externallyPresentable: boolean;
  evidenceRefs: EvidenceRefView[];
}

// ── review packet ────────────────────────────────────────────

export type ReviewEntry = 'ELIGIBLE_FOR_REVIEW' | 'NOT_ELIGIBLE_FOR_REVIEW';

export interface ReviewEligibility {
  entry: ReviewEntry;
  /** Ordered, deterministic reasons. Empty when eligible. */
  blockingReasons: string[];
}

export type UncertaintyCode =
  | 'site_total_unknown'
  | 'sampled_population_only'
  | 'presentation_evidence_absent'
  | 'condition_requires_context'
  | 'undeterminable_measurements_present'
  | 'single_scan_only'
  | 'remediation_class_generic'
  | 'denominators_differ_across_claim';

export interface CoverageView {
  discovered: number;
  selected: number;
  fetched: number;
  analysisComplete: number;
  uniqueInternalTargets: number;
  targetsChecked: number;
  targetsUnchecked: number;
  siteTotalKnown: boolean;
}

export interface GateTraceEntry {
  gate: string;
  name: string;
  passed: boolean;
  reason: string;
}

/**
 * Exactly one opportunity, one evidence fingerprint, one canonical proposition.
 * Derived and never stored.
 */
export interface ReviewPacket {
  reviewContractVersion: string;
  qualificationVersion: string;

  opportunityKey: string;
  evidenceFingerprint: string;
  scanId: string;
  scanMode: string;
  domain: string;

  detector: string;
  detectorVersion: string;
  subject: string;
  condition: string;
  polarity: string;
  scopeLevel: string;
  populations: Population[];

  qualificationStatus: string;
  technicalPriority: string;
  confidence: string;
  gateTrace: GateTraceEntry[];
  firstFailedGate: string | null;
  outreachSuitability: string;

  evidenceRefs: EvidenceRefView[];

  canonicalClaim: CanonicalClaim;
  claimHash: string;
  claimCandidates: ClaimCandidate[];
  demonstration: DemonstrationEvidence;
  presentationMode: PresentationMode;

  /**
   * True only when this packet has the technical characteristics required to
   * enter a FUTURE Scout approval flow. It is NOT approval of any kind — not
   * for Scout, presentation, outreach, sending, or commercial use.
   */
  meetsScoutEvidenceRequirements: boolean;

  /** Always 'UNREPRESENTABLE_IN_V0_1'. */
  humanApprovalState: typeof HUMAN_APPROVAL_STATE;

  reviewEligibility: ReviewEligibility;
  uncertainties: UncertaintyCode[];
  prohibitedClaimClasses: string[];
  coverage: CoverageView;
}

export interface ReviewDerivation {
  reviewContractVersion: string;
  qualificationVersion: string;
  scanId: string;
  domain: string;
  /** One per opportunity that passed the entry rules. */
  packets: ReviewPacket[];
  /** One per opportunity refused entry, with its reasons. */
  refused: {
    opportunityKey: string;
    detector: string;
    subject: string;
    eligibility: ReviewEligibility;
  }[];
  /** Zero-network is a hard property of this layer. */
  networkRequestsMade: 0;
  /** Nothing is persisted by this layer. */
  persistedRecords: 0;
  /** No human approval is representable. */
  completedApprovals: 0;
  reviewDecisionsInstantiated: 0;
  presentationSnapshotsInstantiated: 0;
}

// ── claim validation ─────────────────────────────────────────

/**
 * What a future writing layer must submit: the structured claim fields
 * ALONGSIDE the prose, so validation stays deterministic without an LLM.
 */
export interface ClaimSubmission {
  canonicalClaim: CanonicalClaim;
  prose: string;
  presentationMode: PresentationMode;
  demonstrabilityStatus: DemonstrabilityStatus;
}

export type ValidationCode =
  | 'claim_hash_mismatch'
  | 'epistemic_class_changed'
  | 'presentation_permission_changed'
  | 'presentation_mode_changed'
  | 'demonstrability_changed'
  | 'temporal_frame_changed'
  | 'subject_missing_from_prose'
  | 'denominator_missing_from_prose'
  | 'scope_word_missing_from_prose'
  | 'forbidden_scope_word'
  | 'prohibited_lexicon'
  | 'bare_magnitude'
  | 'markup_present'
  | 'control_characters_present'
  | 'prose_too_long'
  | 'not_externally_presentable'
  | 'unexpected_number_in_prose';

export interface ValidationResult {
  valid: boolean;
  failures: { code: ValidationCode; detail: string }[];
}
