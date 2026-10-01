// Opportunity Review & Presentation v0.1 — review packet derivation.
//
// DERIVE-ONLY. This module derives what a human COULD review. It never records
// that a human did review, and it cannot construct an approval: see
// `future-contract.ts`.
//
// Atomic: one packet = one opportunity key = one evidence fingerprint = one
// canonical claim = one claim hash = one demonstrability result = one mode.
// Opportunities are never merged or aggregated.

import {
  buildCanonicalClaim,
  claimHashOf,
  normalizeRefs,
  proseHashOf,
  type CoverageForClaim,
  type OpportunityView,
} from './canonical-claim';
import { demonstrabilityOf, meetsScoutEvidenceRequirements, presentationModeOf } from './demonstrability';
import { reviewEligibilityOf, uncertaintiesOf } from './eligibility';
import { carriesRequiredContext, isExternallyPresentable, presentationPermissionOf } from './permissions';
import { HUMAN_APPROVAL_STATE, REVIEW_CONTRACT_VERSION, SCOPE_WORDS } from './versions';
import type {
  ClaimCandidate,
  CoverageView,
  EpistemicClass,
  EvidenceRefView,
  GateTraceEntry,
  ReviewDerivation,
  ReviewPacket,
} from './types';

// ── structural input view (no import from the qualification module) ──

export interface QualificationClaimView {
  claimClass: string;
  text: string;
  evidenceRefs: EvidenceRefView[];
}

export interface QualificationOpportunityView extends OpportunityView {
  opportunityKey: string;
  evidenceFingerprint: string;
  scanId: string;
  scanMode: string;
  polarity: string;
  status: string;
  gateResults: GateTraceEntry[];
  firstFailedGate: string | null;
  technicalPriority: string;
  confidence: string;
  outreachSuitability: string;
  presentationEvidenceAvailable: boolean;
  presentationEvidenceReason: string;
  allowedClaims: QualificationClaimView[];
  prohibitedClaimClasses: string[];
  remediation: { remediationClass: string } | null;
  coverage: CoverageView;
}

export interface QualificationResultView {
  qualificationVersion: string;
  scanId: string;
  domain: string;
  coverage: CoverageView;
  opportunities: QualificationOpportunityView[];
}

const EPISTEMIC_CLASSES: readonly EpistemicClass[] = ['DIRECT_OBSERVATION', 'BOUNDED_INTERPRETATION', 'HYPOTHESIS', 'PROHIBITED'];

function epistemicClassOf(raw: string): EpistemicClass {
  // Fail closed: an unrecognized class is treated as PROHIBITED.
  return (EPISTEMIC_CLASSES as readonly string[]).includes(raw) ? (raw as EpistemicClass) : 'PROHIBITED';
}

/**
 * Template prose derived from the canonical claim. Deterministic, bounded, and
 * never the claim's identity. Every stated count carries its own denominator
 * and that population's scope word; two populations are stated separately.
 */
function proseFor(o: QualificationOpportunityView, canonical: ReturnType<typeof buildCanonicalClaim>, claimText: string): string {
  if (!canonical) return claimText;
  // Qualification's own DIRECT_OBSERVATION text already satisfies the language
  // rules and carries both populations where applicable, so it is reused rather
  // than re-worded — re-wording here would risk drifting from the evidence.
  return claimText;
}

function coverageForClaim(c: CoverageView): CoverageForClaim {
  return { analysisComplete: c.analysisComplete, targetsChecked: c.targetsChecked };
}

export function deriveReviewPacket(
  o: QualificationOpportunityView,
  qualificationVersion: string,
  domain: string,
): { packet: ReviewPacket | null; eligibility: ReviewPacket['reviewEligibility'] } {
  const refs = normalizeRefs(o.evidenceRefs);
  const demonstration = demonstrabilityOf({
    detector: o.detector,
    presentationEvidenceAvailable: o.presentationEvidenceAvailable,
    presentationEvidenceReason: o.presentationEvidenceReason,
    evidenceRefs: refs,
  });
  const presentationMode = presentationModeOf(demonstration.status);

  // Claim candidates, sorted deterministically by class then text.
  const candidates: ClaimCandidate[] = [...o.allowedClaims]
    .sort((a, b) => a.claimClass.localeCompare(b.claimClass) || a.text.localeCompare(b.text))
    .map(raw => {
      const epistemicClass = epistemicClassOf(raw.claimClass);
      const permission = presentationPermissionOf({
        epistemicClass,
        qualificationStatus: o.status,
        outreachSuitability: o.outreachSuitability,
        carriesRequiredContext: carriesRequiredContext(raw.text),
      });
      const qualifiers = demonstration.requiresAdditionalContext ? ['requires_context'] : [];
      const canonical = buildCanonicalClaim(o, coverageForClaim(o.coverage), epistemicClass, permission, qualifiers);
      if (!canonical) return null;
      const prose = proseFor(o, canonical, raw.text);
      return {
        canonicalClaim: canonical,
        claimHash: claimHashOf(canonical),
        epistemicClass,
        presentationPermission: permission,
        prose,
        proseHash: proseHashOf(prose),
        externallyPresentable: isExternallyPresentable(permission),
        evidenceRefs: normalizeRefs(raw.evidenceRefs),
      } satisfies ClaimCandidate;
    })
    .filter((c): c is ClaimCandidate => c !== null);

  const eligibility = reviewEligibilityOf({
    qualificationStatus: o.status,
    outreachSuitability: o.outreachSuitability,
    claimPermissions: candidates.map(c => c.presentationPermission),
    polarity: o.polarity,
    firstFailedGate: o.firstFailedGate,
  });

  if (eligibility.entry !== 'ELIGIBLE_FOR_REVIEW') return { packet: null, eligibility };

  // The packet's canonical claim is the presentable DIRECT_OBSERVATION — the
  // proposition a reviewer is being asked about.
  const primary = candidates.find(c => c.epistemicClass === 'DIRECT_OBSERVATION' && c.externallyPresentable)
    ?? candidates.find(c => c.externallyPresentable);
  if (!primary) {
    return {
      packet: null,
      eligibility: { entry: 'NOT_ELIGIBLE_FOR_REVIEW', blockingReasons: ['no presentable primary claim'] },
    };
  }

  const packet: ReviewPacket = {
    reviewContractVersion: REVIEW_CONTRACT_VERSION,
    qualificationVersion,

    opportunityKey: o.opportunityKey,
    evidenceFingerprint: o.evidenceFingerprint,
    scanId: o.scanId,
    scanMode: o.scanMode,
    domain,

    detector: o.detector,
    detectorVersion: o.detectorVersion,
    subject: o.subject,
    condition: o.condition,
    polarity: o.polarity,
    scopeLevel: o.scopeLevel,
    populations: primary.canonicalClaim.populations,

    qualificationStatus: o.status,
    technicalPriority: o.technicalPriority,
    confidence: o.confidence,
    // The full gate trace is mandatory: without it a reviewer cannot see WHY
    // the engine qualified the opportunity.
    gateTrace: o.gateResults.map(g => ({ gate: g.gate, name: g.name, passed: g.passed, reason: g.reason })),
    firstFailedGate: o.firstFailedGate,
    outreachSuitability: o.outreachSuitability,

    evidenceRefs: refs,

    canonicalClaim: primary.canonicalClaim,
    claimHash: primary.claimHash,
    claimCandidates: candidates,
    demonstration,
    presentationMode,

    meetsScoutEvidenceRequirements: meetsScoutEvidenceRequirements(presentationMode),
    humanApprovalState: HUMAN_APPROVAL_STATE,

    reviewEligibility: eligibility,
    uncertainties: uncertaintiesOf({
      siteTotalKnown: o.coverage.siteTotalKnown,
      scopeLevel: o.scopeLevel,
      presentationEvidenceAvailable: o.presentationEvidenceAvailable,
      requiresAdditionalContext: demonstration.requiresAdditionalContext,
      undeterminableCountPresent: o.confidence === 'undeterminable',
      remediationClass: o.remediation ? o.remediation.remediationClass : null,
      populationCount: primary.canonicalClaim.populations.length,
    }),
    prohibitedClaimClasses: [...o.prohibitedClaimClasses].sort(),
    coverage: o.coverage,
  };
  return { packet, eligibility };
}

/** Deterministic: packets and refusals are sorted by opportunity key. */
export function deriveReview(result: QualificationResultView): ReviewDerivation {
  const packets: ReviewPacket[] = [];
  const refused: ReviewDerivation['refused'] = [];

  for (const o of [...result.opportunities].sort((a, b) => a.opportunityKey.localeCompare(b.opportunityKey))) {
    const { packet, eligibility } = deriveReviewPacket(o, result.qualificationVersion, result.domain);
    if (packet) packets.push(packet);
    else refused.push({ opportunityKey: o.opportunityKey, detector: o.detector, subject: o.subject, eligibility });
  }

  return {
    reviewContractVersion: REVIEW_CONTRACT_VERSION,
    qualificationVersion: result.qualificationVersion,
    scanId: result.scanId,
    domain: result.domain,
    packets: packets.sort((a, b) => a.opportunityKey.localeCompare(b.opportunityKey)),
    refused: refused.sort((a, b) => a.opportunityKey.localeCompare(b.opportunityKey)),
    // Structural: nothing in this module or its imports performs I/O.
    networkRequestsMade: 0,
    persistedRecords: 0,
    completedApprovals: 0,
    reviewDecisionsInstantiated: 0,
    presentationSnapshotsInstantiated: 0,
  };
}

export { SCOPE_WORDS };
