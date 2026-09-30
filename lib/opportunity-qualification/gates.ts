// Opportunity Qualification v0.1 — the 12 qualification gates.
//
// Ordered, deterministic, explainable. Every gate returns its own pass/fail
// and a reason. There is no aggregate score: a candidate qualifies only when
// every gate passes, and the first failing gate is reported.

import { catalogFor, isKnownType } from './catalog';
import { canSatisfyGate } from './confidence';
import { KNOWN_DETECTORS, KNOWN_SCOPE_LEVELS } from './versions';
import type { CoverageContext, EvidenceCluster, GateId, GateResult } from './types';

export interface GateContext {
  coverage: CoverageContext;
  /** URLs whose page analysis completed. Gate G4. */
  completeAnalysisUrls: ReadonlySet<string>;
}

interface GateDef {
  gate: GateId;
  name: string;
  evaluate: (c: EvidenceCluster, ctx: GateContext) => { passed: boolean; reason: string };
}

const GENERIC_SUBJECTS = new Set(['', 'site', 'website', 'the website', 'all', 'everything', '*']);

export const GATES: readonly GateDef[] = Object.freeze([
  {
    gate: 'G1',
    name: 'Evidence exists',
    evaluate: c => c.evidenceRefs.length > 0
      ? { passed: true, reason: `${c.evidenceRefs.length} evidence reference(s)` }
      : { passed: false, reason: 'no evidence references' },
  },
  {
    gate: 'G2',
    name: 'Evidence integrity',
    evaluate: c => {
      for (const ref of c.evidenceRefs) {
        if (!ref.scanId) return { passed: false, reason: `ref ${ref.subjectUrl} has no scanId` };
        if (!ref.subjectUrl) return { passed: false, reason: 'ref has no subject URL' };
        if (!ref.observedAt) return { passed: false, reason: `ref ${ref.subjectUrl} has no observedAt` };
        if (ref.kind === 'page_observation') {
          if (!ref.engine || !ref.engineVersion) return { passed: false, reason: `ref ${ref.subjectUrl} missing engine provenance` };
          if (!ref.contentSha256 || !/^[a-f0-9]{64}$/.test(ref.contentSha256)) {
            return { passed: false, reason: `ref ${ref.subjectUrl} has no valid content hash` };
          }
        }
      }
      // One URL must not contribute observations from two different page
      // versions to a single proposition.
      const hashByUrl = new Map<string, string>();
      for (const ref of c.evidenceRefs) {
        if (ref.kind !== 'page_observation' || !ref.contentSha256) continue;
        const prior = hashByUrl.get(ref.subjectUrl);
        if (prior && prior !== ref.contentSha256) {
          return { passed: false, reason: `content hash mismatch for ${ref.subjectUrl}` };
        }
        hashByUrl.set(ref.subjectUrl, ref.contentSha256);
      }
      // Engine versions must be consistent within one engine's contribution.
      const versionsByEngine = new Map<string, Set<string>>();
      for (const ref of c.evidenceRefs) {
        if (!ref.engine || !ref.engineVersion) continue;
        const set = versionsByEngine.get(ref.engine) ?? new Set<string>();
        set.add(ref.engineVersion);
        versionsByEngine.set(ref.engine, set);
      }
      for (const [engine, set] of versionsByEngine) {
        if (set.size > 1) return { passed: false, reason: `engine ${engine} contributed ${set.size} versions` };
      }
      return { passed: true, reason: 'all references carry provenance and are internally consistent' };
    },
  },
  {
    gate: 'G3',
    name: 'Determinable',
    evaluate: c => {
      if (!c.determinable) return { passed: false, reason: 'the measurement did not establish a state; undeterminable is not a failure' };
      if (c.polarity === 'indeterminate') return { passed: false, reason: 'condition polarity is indeterminate' };
      return { passed: true, reason: 'the condition is an established observed state' };
    },
  },
  {
    gate: 'G4',
    name: 'Analysis completeness',
    evaluate: (c, ctx) => {
      const pageRefs = c.evidenceRefs.filter(r => r.kind === 'page_observation');
      const incomplete = pageRefs.filter(r => !ctx.completeAnalysisUrls.has(r.subjectUrl));
      return incomplete.length === 0
        ? { passed: true, reason: `${pageRefs.length} page reference(s), all from pages with analysis_state=complete` }
        : { passed: false, reason: `${incomplete.length} page reference(s) come from pages without complete analysis` };
    },
  },
  {
    gate: 'G5',
    name: 'Scope honesty',
    evaluate: (c, ctx) => {
      if (!KNOWN_SCOPE_LEVELS.includes(c.scopeLevel)) return { passed: false, reason: `unknown scope level ${c.scopeLevel}` };
      if (c.scopeLevel === 'site' && !ctx.coverage.siteTotalKnown) {
        return { passed: false, reason: 'site scope is unreachable while the site total is unknown' };
      }
      if (c.scopeLevel === 'analyzed_sample' || c.scopeLevel === 'checked_targets' || c.scopeLevel === 'discovered') {
        if (c.denominator === null || c.denominator <= 0) return { passed: false, reason: 'aggregate scope without a denominator' };
        if (c.numerator === null) return { passed: false, reason: 'aggregate scope without a numerator' };
        if (c.numerator > c.denominator) return { passed: false, reason: `numerator ${c.numerator} exceeds denominator ${c.denominator}` };
      }
      const expected = c.scopeLevel === 'analyzed_sample' ? ctx.coverage.analysisComplete
        : c.scopeLevel === 'checked_targets' ? ctx.coverage.targetsChecked
          : c.scopeLevel === 'discovered' ? ctx.coverage.discovered
            : null;
      if (expected !== null && c.denominator !== expected) {
        return { passed: false, reason: `denominator ${c.denominator} does not match the ${c.scopeLevel} population ${expected}` };
      }
      return { passed: true, reason: `${c.numerator} of ${c.denominator} (${c.scopeLevel})` };
    },
  },
  {
    gate: 'G6',
    name: 'Repeatability',
    evaluate: c => {
      if (!KNOWN_DETECTORS.includes(c.detector)) return { passed: false, reason: `unknown detector ${c.detector}` };
      if (!c.detectorVersion) return { passed: false, reason: 'detector version missing' };
      return { passed: true, reason: `${c.detector} at ${c.detectorVersion} re-derives the same signal from the same evidence` };
    },
  },
  {
    gate: 'G7',
    name: 'Specificity',
    evaluate: c => GENERIC_SUBJECTS.has(c.subject.trim().toLowerCase())
      ? { passed: false, reason: `subject "${c.subject}" is not specific` }
      : { passed: true, reason: `subject is ${c.subject}` },
  },
  {
    gate: 'G8',
    name: 'Explainability',
    evaluate: c => isKnownType(c)
      ? { passed: true, reason: 'a direct-observation statement can be made from the evidence alone' }
      : { passed: false, reason: `no claim template for ${c.detector}:${c.condition}` },
  },
  {
    gate: 'G9',
    name: 'Remediation known',
    evaluate: c => {
      const entry = catalogFor(c);
      if (c.polarity !== 'adverse') return { passed: false, reason: `polarity is ${c.polarity}; there is nothing to remediate` };
      return entry.remediationClass
        ? { passed: true, reason: `remediation class ${entry.remediationClass}` }
        : { passed: false, reason: 'no known remediation class' };
    },
  },
  {
    gate: 'G10',
    name: 'Verification path',
    evaluate: c => {
      const entry = catalogFor(c);
      return entry.verificationMethod
        ? { passed: true, reason: `verification method ${entry.verificationMethod}` }
        : { passed: false, reason: 'no verification path would distinguish changed from unchanged' };
    },
  },
  {
    gate: 'G11',
    name: 'Evidence class sufficient without inference',
    evaluate: c => canSatisfyGate(c.provenance)
      ? { passed: true, reason: `provenance ${c.provenance} is a directly observed class` }
      : { passed: false, reason: `provenance ${c.provenance} cannot independently satisfy a gate` },
  },
  {
    gate: 'G12',
    name: 'Not solely absence of evidence',
    evaluate: c => {
      if (c.polarity === 'healthy') return { passed: false, reason: 'a healthy observed state is not an adverse condition' };
      if (c.polarity === 'indeterminate') return { passed: false, reason: 'a missing measurement is not negative evidence' };
      if ((c.numerator ?? 0) <= 0) return { passed: false, reason: 'the condition was not positively observed anywhere' };
      return { passed: true, reason: `positively observed on ${c.numerator} subject(s)` };
    },
  },
]);

export function evaluateGates(cluster: EvidenceCluster, ctx: GateContext): {
  results: GateResult[];
  firstFailedGate: GateId | null;
} {
  const results: GateResult[] = [];
  let firstFailedGate: GateId | null = null;
  for (const def of GATES) {
    const { passed, reason } = def.evaluate(cluster, ctx);
    results.push({ gate: def.gate, name: def.name, passed, reason });
    if (!passed && firstFailedGate === null) firstFailedGate = def.gate;
  }
  return { results, firstFailedGate };
}
