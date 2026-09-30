// Opportunity Qualification v0.1 — claim permissions.
//
// Four classes: DIRECT_OBSERVATION, BOUNDED_INTERPRETATION, HYPOTHESIS,
// PROHIBITED. HYPOTHESIS is internal-only. A claim with no traceable evidence
// refs is PROHIBITED. No free-form sales copy is generated: every sentence
// comes from a template bound to a catalog entry.

import { catalogFor, isKnownType } from './catalog';
import { PROHIBITED_CLAIM_CLASSES } from './versions';
import type { Claim, CoverageContext, EvidenceCluster, ScopeLevel } from './types';

/** The scope word that must accompany a count at each scope level. */
const SCOPE_WORD: Readonly<Record<ScopeLevel, string>> = Object.freeze({
  page: 'page',
  analyzed_sample: 'analyzed',
  checked_targets: 'checked',
  discovered: 'discovered',
  site: 'site',
});

export function scopeWordFor(scope: ScopeLevel): string {
  return SCOPE_WORD[scope];
}

function claim(
  claimClass: Claim['claimClass'],
  text: string,
  cluster: EvidenceCluster,
): Claim {
  const refs = cluster.evidenceRefs;
  // A claim with no traceable evidence is PROHIBITED regardless of its text.
  if (refs.length === 0) {
    return { claimClass: 'PROHIBITED', text, evidenceRefs: [], externallyPresentable: false };
  }
  return {
    claimClass,
    text,
    evidenceRefs: refs,
    externallyPresentable: claimClass === 'DIRECT_OBSERVATION' || claimClass === 'BOUNDED_INTERPRETATION',
  };
}

function fact(cluster: EvidenceCluster, key: string): string | null {
  const v = cluster.facts[key];
  return v === null || v === undefined ? null : String(v);
}

/**
 * Builds the permitted claim set. Only DIRECT_OBSERVATION and approved
 * BOUNDED_INTERPRETATION sentences are externally presentable, and every count
 * carries its denominator and scope word.
 */
export function buildClaims(cluster: EvidenceCluster, coverage: CoverageContext): Claim[] {
  if (!isKnownType(cluster)) {
    return [claim('PROHIBITED', 'no claim template exists for this condition', cluster)];
  }
  const entry = catalogFor(cluster);
  const word = scopeWordFor(cluster.scopeLevel);
  const out: Claim[] = [];

  if (cluster.detector === 'broken_internal_target') {
    const status = fact(cluster, 'httpStatus') ?? 'an error status';
    const method = fact(cluster, 'methodUsed') ?? 'a request';
    const when = fact(cluster, 'checkedAt');
    // Two populations are involved and must never be conflated: the source
    // pages carrying the link (denominator = analyzed pages) and the checked
    // destinations (denominator = targets checked).
    const pages = cluster.sourceLinkCount;
    out.push(claim(
      'DIRECT_OBSERVATION',
      `Prequire found links to ${cluster.subject} on ${pages} of the ${coverage.analysisComplete} analyzed pages. ` +
      `That destination is 1 of the ${cluster.denominator} ${word} link destinations; when it was requested by ` +
      `${method}${when ? ` on ${when.slice(0, 10)}` : ''} it returned HTTP ${status}.`,
      cluster,
    ));
    out.push(claim(
      'BOUNDED_INTERPRETATION',
      `A visitor or crawler following that link reaches an error response rather than the intended destination.`,
      cluster,
    ));
  } else if (cluster.detector === 'page_check_failure') {
    out.push(claim(
      'DIRECT_OBSERVATION',
      `On ${cluster.numerator} of the ${cluster.denominator} ${word} pages, the ${cluster.subject} check did not pass ` +
      `(engine ${fact(cluster, 'engine') ?? 'extraction_resilience'}).`,
      cluster,
    ));
    out.push(claim(
      'HYPOTHESIS',
      `This may affect how automated systems reproduce facts from these pages.`,
      cluster,
    ));
  } else if (cluster.detector === 'extraction_band') {
    out.push(claim(
      'DIRECT_OBSERVATION',
      `On ${cluster.numerator} of the ${cluster.denominator} ${word} pages, the extraction-resilience engine ` +
      `assigned the band "${fact(cluster, 'band') ?? cluster.condition}".`,
      cluster,
    ));
    out.push(claim(
      'HYPOTHESIS',
      `A fragile band may indicate that meaning is lost when these pages are flattened for extraction.`,
      cluster,
    ));
  } else if (cluster.detector === 'content_delivery_condition') {
    const context = entry.requiredContext;
    out.push(claim(
      'DIRECT_OBSERVATION',
      `On ${cluster.numerator} of the ${cluster.denominator} ${word} pages, the text-to-HTML ratio fell below the ` +
      `content-delivery engine's 0.05 threshold, which it classifies as "${cluster.condition}".` +
      (context ? ` For completeness: ${context}.` : ''),
      cluster,
    ));
  } else if (cluster.detector === 'structured_data_presence') {
    out.push(claim(
      'DIRECT_OBSERVATION',
      `On ${cluster.numerator} of the ${cluster.denominator} ${word} pages, the condition "${cluster.condition}" was recorded.`,
      cluster,
    ));
  } else if (cluster.detector === 'page_check_undeterminable') {
    out.push(claim(
      'HYPOTHESIS',
      `On ${cluster.numerator} of the ${cluster.denominator} ${word} pages, the ${cluster.subject} check returned ` +
      `undeterminable. This is not a failure and no condition is established.`,
      cluster,
    ));
  }

  return out;
}

/** Claims that may leave the system for a given cluster. */
export function externallyPresentableClaims(claims: readonly Claim[]): Claim[] {
  return claims.filter(c => c.externallyPresentable);
}

export function prohibitedClaimClasses(): readonly string[] {
  return PROHIBITED_CLAIM_CLASSES;
}

/**
 * Gate O5 check: every externally presentable sentence that states a count must
 * also state its denominator and a scope word.
 */
export function claimStatesACount(claim: Claim): boolean {
  return /\d/.test(claim.text);
}

export function claimCarriesDenominator(claim: Claim, cluster: EvidenceCluster): boolean {
  // A claim that states no count is vacuously compliant: O5 constrains stated
  // counts, not every sentence.
  if (!claimStatesACount(claim)) return true;
  if (cluster.denominator === null) return true;
  const hasDenominator = claim.text.includes(String(cluster.denominator));
  const hasScopeWord = claim.text.includes(scopeWordFor(cluster.scopeLevel));
  return hasDenominator && hasScopeWord;
}

/** No externally presentable claim may contain a bare percentage. */
export function claimHasBarePercentage(claim: Claim): boolean {
  return /%|\bpercent\b|\bmost of the (website|site)\b/i.test(claim.text);
}
