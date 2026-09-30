// Opportunity Qualification v0.1 — orchestrator.
//
//   DURABLE EVIDENCE → SIGNAL → EVIDENCE CLUSTER → OPPORTUNITY CANDIDATE
//     → QUALIFICATION DECISION → TECHNICAL PRIORITY → CONFIDENCE
//       → CLAIM PERMISSIONS → OUTREACH SUITABILITY
//
// Pure and deterministic. Makes ZERO network requests, requires no raw HTML,
// writes nothing, and persists nothing. There is no approval state: the highest
// outreach state it can produce is ELIGIBLE_FOR_HUMAN_REVIEW.

import { catalogFor, remediationDescriptor, verificationDescriptor } from './catalog';
import { buildClaims, prohibitedClaimClasses } from './claims';
import { buildClusters } from './clusters';
import { evaluateGates, type GateContext } from './gates';
import { evaluateOutreachGates, outreachSuitability, presentationEvidence } from './outreach';
import { technicalPriority } from './priority';
import { deriveSignals } from './signals';
import { QUALIFICATION_VERSION } from './versions';
import type { OpportunityResult, QualificationInput, QualificationResult } from './types';

function completeAnalysisUrlSet(input: QualificationInput): Set<string> {
  return new Set(
    input.scanUrls
      .filter(r => r.analysisState === 'complete' && r.urlNormalized !== null)
      .map(r => r.urlNormalized!),
  );
}

export function qualify(input: QualificationInput): QualificationResult {
  const signals = deriveSignals(input);
  const clusters = buildClusters(signals);
  const ctx: GateContext = {
    coverage: input.coverage,
    completeAnalysisUrls: completeAnalysisUrlSet(input),
  };

  const opportunities: OpportunityResult[] = clusters.map(cluster => {
    const { results: gateResults, firstFailedGate } = evaluateGates(cluster, ctx);
    const status = firstFailedGate === null ? 'QUALIFIED' : 'NOT_QUALIFIED';
    const entry = catalogFor(cluster);
    const claims = buildClaims(cluster, input.coverage);
    const outreachGateResults = evaluateOutreachGates(cluster, claims);
    const presentation = presentationEvidence(cluster);
    const priority = technicalPriority(cluster);

    return {
      opportunityKey: cluster.opportunityKey,
      evidenceFingerprint: cluster.evidenceFingerprint,
      scanId: cluster.scanId,
      scanMode: input.scanMode,
      detector: cluster.detector,
      detectorVersion: cluster.detectorVersion,
      subject: cluster.subject,
      condition: cluster.condition,
      polarity: cluster.polarity,
      scopeLevel: cluster.scopeLevel,
      numerator: cluster.numerator,
      denominator: cluster.denominator,
      affectedPageCount: cluster.affectedPageCount,
      sourceLinkCount: cluster.sourceLinkCount,
      signalKeys: cluster.signalKeys,
      evidenceRefs: cluster.evidenceRefs,
      facts: cluster.facts,

      status,
      gateResults,
      firstFailedGate,

      technicalPriority: priority.priority,
      confidence: cluster.provenance,

      outreachSuitability: outreachSuitability(status, outreachGateResults, presentation.available),
      outreachGateResults,

      presentationEvidenceAvailable: presentation.available,
      presentationEvidenceReason: presentation.reason,

      // Only qualified opportunities carry a presentable claim set. A
      // non-qualified candidate keeps its claims for internal explanation, but
      // nothing about it is externally presentable.
      allowedClaims: status === 'QUALIFIED' ? claims : claims.map(c => ({ ...c, externallyPresentable: false })),
      prohibitedClaimClasses: [...prohibitedClaimClasses()],

      remediation: remediationDescriptor(entry),
      verification: verificationDescriptor(entry),

      coverage: input.coverage,
    };
  });

  return {
    qualificationVersion: QUALIFICATION_VERSION,
    scanId: input.scanId,
    scanMode: input.scanMode,
    domain: input.domain,
    coverage: input.coverage,
    signals,
    clusters,
    // Structural: nothing in this module or its imports performs I/O.
    networkRequestsMade: 0,
    opportunities: opportunities.sort((a, b) =>
      a.opportunityKey.localeCompare(b.opportunityKey)),
  };
}

export { QUALIFICATION_VERSION } from './versions';
export type { QualificationInput, QualificationResult, OpportunityResult } from './types';
