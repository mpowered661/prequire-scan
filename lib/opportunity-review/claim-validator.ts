// Opportunity Review & Presentation v0.1 — deterministic claim validator.
//
// A future writing layer may rephrase prose. It may never alter canonical
// meaning. This validator is the enforcement point, and it uses NO LLM and no
// semantic inference.
//
// DOCUMENTED BOUNDARY: this does not attempt unrestricted natural-language
// semantic equivalence. It validates the STRUCTURED claim (ending in claimHash
// equality) plus bounded surface checks on the prose. A future writing layer
// must therefore return the structured claim fields ALONGSIDE its prose, which
// is exactly what `ClaimSubmission` requires. Validating arbitrary free-form
// prose without structured fields would need semantic inference and is
// deliberately out of scope.

import { canonicalJson, claimHashOf, subjectMentionOf } from './canonical-claim';
import { isExternallyPresentable } from './permissions';
import {
  BARE_MAGNITUDE_PATTERN,
  FORBIDDEN_SCOPE_WORDS,
  MAX_PROSE_CHARS,
  PROHIBITED_LEXICON,
  SCOPE_WORDS,
} from './versions';
import type {
  CanonicalClaim,
  ClaimSubmission,
  DemonstrabilityStatus,
  PresentationMode,
  ValidationCode,
  ValidationResult,
} from './types';

export interface ClaimBaseline {
  canonicalClaim: CanonicalClaim;
  claimHash: string;
  presentationMode: PresentationMode;
  demonstrabilityStatus: DemonstrabilityStatus;
}

const MARKUP_PATTERN = /<[^>]*>|<\/|&lt;|&#x3c;/i;
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function scopeWordFor(scopeLevel: string): string | null {
  return (SCOPE_WORDS as Record<string, string>)[scopeLevel] ?? null;
}

const ISO_DATE_PATTERN = /\d{4}-\d{2}-\d{2}/g;

/**
 * Every integer appearing in the prose, as a multiset. ISO dates are removed
 * first: an observation date is evidence-derived provenance, not a figure the
 * writing layer invented, and it is validated separately against
 * `canonicalClaim.observedAt`.
 */
function numbersIn(text: string): number[] {
  const withoutDates = text.replace(ISO_DATE_PATTERN, ' ');
  return (withoutDates.match(/\d+/g) ?? []).map(n => Number(n)).sort((a, b) => a - b);
}

/** Any ISO date in the prose must be the claim's own observation date. */
function datesIn(text: string): string[] {
  return (text.match(ISO_DATE_PATTERN) ?? []).sort();
}

/** Numbers the canonical claim licenses the prose to state. */
function licensedNumbers(c: CanonicalClaim): number[] {
  const out: number[] = [];
  for (const p of c.populations) {
    out.push(p.numerator, p.denominator);
  }
  const observed = Number(c.observedValue);
  if (Number.isFinite(observed)) out.push(observed);
  return out.sort((a, b) => a - b);
}

/**
 * Validates a writing layer's submission against a claim baseline. The
 * baseline is the derived canonical claim; whether a human ever approved it is a
 * FUTURE concern and is deliberately not asserted by this type's name.
 * Ends in canonical claimHash equality.
 */
export function validateClaimSubmission(
  submission: ClaimSubmission,
  baseline: ClaimBaseline,
): ValidationResult {
  const failures: { code: ValidationCode; detail: string }[] = [];
  const fail = (code: ValidationCode, detail: string) => failures.push({ code, detail });

  const c = submission.canonicalClaim;
  const b = baseline.canonicalClaim;

  // ── immutable structured fields ────────────────────────────
  if (c.subject !== b.subject) fail('claim_hash_mismatch', `subject ${b.subject} -> ${c.subject}`);
  if (c.scopeLevel !== b.scopeLevel) fail('claim_hash_mismatch', `scopeLevel ${b.scopeLevel} -> ${c.scopeLevel}`);
  if (c.condition !== b.condition) fail('claim_hash_mismatch', `condition ${b.condition} -> ${c.condition}`);
  if (c.metric !== b.metric) fail('claim_hash_mismatch', `metric ${b.metric} -> ${c.metric}`);
  if (c.observedValue !== b.observedValue) fail('claim_hash_mismatch', `observedValue ${b.observedValue} -> ${c.observedValue}`);
  if (c.observedAt !== b.observedAt) fail('claim_hash_mismatch', `observedAt ${b.observedAt} -> ${c.observedAt}`);
  if (c.claimType !== b.claimType) fail('claim_hash_mismatch', `claimType ${b.claimType} -> ${c.claimType}`);
  if (c.detector !== b.detector || c.detectorVersion !== b.detectorVersion) {
    fail('claim_hash_mismatch', 'detector provenance changed');
  }
  if (c.evidenceRefsHash !== b.evidenceRefsHash) fail('claim_hash_mismatch', 'evidence references changed');
  if (c.temporalFrame !== b.temporalFrame) fail('temporal_frame_changed', `${b.temporalFrame} -> ${c.temporalFrame}`);
  if (c.epistemicClass !== b.epistemicClass) fail('epistemic_class_changed', `${b.epistemicClass} -> ${c.epistemicClass}`);
  if (c.presentationPermission !== b.presentationPermission) {
    fail('presentation_permission_changed', `${b.presentationPermission} -> ${c.presentationPermission}`);
  }

  // Populations: label, numerator and denominator must all survive.
  const bPops = [...b.populations].sort((x, y) => x.label.localeCompare(y.label));
  const cPops = [...c.populations].sort((x, y) => x.label.localeCompare(y.label));
  if (bPops.length !== cPops.length) fail('claim_hash_mismatch', 'population count changed');
  else {
    for (let i = 0; i < bPops.length; i += 1) {
      if (bPops[i].label !== cPops[i].label) fail('claim_hash_mismatch', `population label ${bPops[i].label} -> ${cPops[i].label}`);
      if (bPops[i].numerator !== cPops[i].numerator) fail('claim_hash_mismatch', `numerator ${bPops[i].numerator} -> ${cPops[i].numerator}`);
      if (bPops[i].denominator !== cPops[i].denominator) fail('claim_hash_mismatch', `denominator ${bPops[i].denominator} -> ${cPops[i].denominator}`);
    }
  }

  // Qualifiers: a required qualifier may not be dropped.
  const bQual = [...b.qualifiers].sort();
  const cQual = [...c.qualifiers].sort();
  if (bQual.join('|') !== cQual.join('|')) fail('claim_hash_mismatch', `qualifiers [${bQual}] -> [${cQual}]`);

  // ── mode and demonstrability ───────────────────────────────
  if (submission.presentationMode !== baseline.presentationMode) {
    fail('presentation_mode_changed', `${baseline.presentationMode} -> ${submission.presentationMode}`);
  }
  if (submission.demonstrabilityStatus !== baseline.demonstrabilityStatus) {
    fail('demonstrability_changed', `${baseline.demonstrabilityStatus} -> ${submission.demonstrabilityStatus}`);
  }

  // ── prose surface checks ───────────────────────────────────
  const prose = submission.prose;
  if (!isExternallyPresentable(b.presentationPermission)) {
    fail('not_externally_presentable', `permission is ${b.presentationPermission}`);
  }
  if (prose.length > MAX_PROSE_CHARS) fail('prose_too_long', `${prose.length} > ${MAX_PROSE_CHARS}`);
  if (CONTROL_CHAR_PATTERN.test(prose)) fail('control_characters_present', 'control character in prose');
  if (MARKUP_PATTERN.test(prose)) fail('markup_present', 'markup or angle brackets in prose');
  if (BARE_MAGNITUDE_PATTERN.test(prose)) fail('bare_magnitude', 'bare percentage or vague magnitude');

  const lower = prose.toLowerCase();
  for (const term of PROHIBITED_LEXICON) {
    if (lower.includes(term)) fail('prohibited_lexicon', `contains "${term}"`);
  }
  for (const word of FORBIDDEN_SCOPE_WORDS) {
    if (lower.includes(word)) fail('forbidden_scope_word', `contains "${word}"`);
  }
  const subjectMention = subjectMentionOf(b.subject);
  if (!prose.includes(subjectMention)) fail('subject_missing_from_prose', subjectMention);

  const scopeWord = scopeWordFor(b.scopeLevel);
  // The prose must name a scope word for each population it states. For a
  // two-population claim the analyzed-pages population supplies 'analyzed'.
  const needed = new Set<string>();
  if (scopeWord) needed.add(scopeWord);
  for (const p of bPops) {
    if (p.label === 'analyzed_pages') needed.add(SCOPE_WORDS.analyzed_sample);
    if (p.label === 'checked_link_destinations') needed.add(SCOPE_WORDS.checked_targets);
  }
  for (const w of needed) {
    if (!lower.includes(w)) fail('scope_word_missing_from_prose', `missing scope word "${w}"`);
  }

  for (const p of bPops) {
    if (!prose.includes(String(p.denominator))) {
      fail('denominator_missing_from_prose', `missing denominator ${p.denominator} for ${p.label}`);
    }
  }

  // No number may appear that the canonical claim does not license.
  const licensed = new Set(licensedNumbers(b));
  for (const n of numbersIn(prose)) {
    if (!licensed.has(n)) fail('unexpected_number_in_prose', `${n} is not licensed by the canonical claim`);
  }
  // Any date stated must be the claim's own observation date.
  for (const d of datesIn(prose)) {
    if (d !== b.observedAt) fail('unexpected_number_in_prose', `date ${d} is not the observation date ${b.observedAt}`);
  }

  // ── the terminal check ─────────────────────────────────────
  const recomputed = claimHashOf(c);
  if (recomputed !== baseline.claimHash) {
    fail('claim_hash_mismatch', `${baseline.claimHash} -> ${recomputed}`);
  }

  return { valid: failures.length === 0, failures };
}

/** Exposed so a test can prove canonical serialization is order-independent. */
export { canonicalJson };
