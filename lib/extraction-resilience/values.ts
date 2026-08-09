import type { UnitAnnotation, Qualifier, QualifierSource, AnnotationSource } from './types';

// Parsing of factual values, the units they are measured in, and the claim
// qualifiers that condition them.
//
// Units and qualifiers are deliberately different things. "$4.2M" has a
// currency and a scale; "up to $4.2M, unaudited" additionally has an
// approximation and a restriction. A table column header is neither — it is
// attribution, handled as a Dimension in extract-a.

const CURRENCY_SYMBOLS: Record<string, string> = {
  $: '$', '€': '€', '£': '£', '¥': '¥',
};

const SCALE_WORDS = new Set([
  'million', 'millions', 'billion', 'billions', 'thousand', 'thousands',
  'trillion', 'trillions',
]);

const TIME_UNITS = new Set([
  'second', 'seconds', 'minute', 'minutes', 'hour', 'hours', 'day', 'days',
  'week', 'weeks', 'month', 'months', 'year', 'years', 'quarter', 'quarters',
]);

// Words that follow a number without being its unit.
const UNIT_STOPWORDS = new Set([
  'to', 'and', 'or', 'of', 'in', 'for', 'the', 'a', 'an', 'per', 'from',
  'is', 'was', 'are', 'were', 'with', 'at', 'on', 'by', 'up', 'over',
  'under', 'than', 'plus', 'but', 'as', 'that', 'this', 'it', 'we', 'you',
]);

// ── Claim qualifier vocabulary ───────────────────────────────
// Longest-first within each group so "up to" wins over "to" and
// "individual results may vary" wins over "results vary".

const APPROXIMATION_PHRASES = [
  'approximately', 'approx.', 'approx', 'up to', 'as much as', 'as little as',
  'starting at', 'starting from', 'from as low as', 'at least', 'at most',
  'more than', 'less than', 'nearly', 'almost', 'around', 'roughly', 'about',
  'average', 'on average', 'median', 'typical', 'typically', 'estimated',
  'estimate', 'projected', 'may reach', 'or more', 'or less',
];

const DISCLAIMER_PHRASES = [
  'individual results may vary', 'results may vary', 'results vary',
  'not guaranteed', 'no guarantee', 'terms apply', 'terms and conditions apply',
  'restrictions apply', 'conditions apply', 'your mileage may vary',
  'for illustrative purposes', 'illustrative only', 'past performance',
];

const RESTRICTION_PHRASES = [
  'unaudited', 'self-reported', 'self reported', 'internal data',
  'based on a sample', 'based on a survey', 'sample size', 'survey of',
  'as of', 'eligibility', 'eligible customers', 'qualifying customers',
  'where available', 'select markets', 'subject to', 'excludes', 'excluding',
  'new customers only', 'first year only', 'limited time',
];

export interface ParsedValue {
  value: string; // numeric core, e.g. "4.2" or "250,000"
  units: UnitAnnotation[];
  start: number;
  end: number; // exclusive; end of the full expression including units
}

const NUMBER_RE = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

/**
 * Finds numeric expressions in a string, splitting each into its numeric core
 * and the currency / scale / unit annotations physically attached to it.
 */
export function parseValues(text: string): ParsedValue[] {
  const out: ParsedValue[] = [];
  if (!text) return out;

  NUMBER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = NUMBER_RE.exec(text)) !== null) {
    const core = m[0];
    let start = m.index;
    let end = m.index + core.length;
    const units: UnitAnnotation[] = [];

    // Currency immediately before, optionally separated by one space.
    const before = text.slice(Math.max(0, start - 2), start);
    const symbolMatch = /([$€£¥])\s?$/.exec(before);
    if (symbolMatch) {
      units.push({
        kind: 'currency',
        text: CURRENCY_SYMBOLS[symbolMatch[1]],
        source: 'unit_suffix',
      });
      start -= symbolMatch[0].length;
    }

    const rest = text.slice(end);

    // Percent sign binds tightest.
    const pct = /^\s?%/.exec(rest);
    if (pct) {
      units.push({ kind: 'unit', text: '%', source: 'unit_suffix' });
      end += pct[0].length;
    } else {
      // Compact scale suffix: 4.2M, 300K — uppercase only, not followed by more letters.
      const compact = /^([KMB])(?![A-Za-z])/.exec(rest);
      if (compact) {
        units.push({ kind: 'scale', text: compact[1], source: 'unit_suffix' });
        end += compact[0].length;
      } else {
        const word = /^\s+([A-Za-z][A-Za-z-]{0,20})/.exec(rest);
        if (word) {
          const lower = word[1].toLowerCase();
          if (SCALE_WORDS.has(lower)) {
            units.push({ kind: 'scale', text: word[1], source: 'unit_suffix' });
            end += word[0].length;
          } else if (!UNIT_STOPWORDS.has(lower)) {
            units.push({
              kind: 'unit',
              text: word[1],
              source: 'unit_suffix',
            });
            end += word[0].length;
          }
        }
      }
    }

    out.push({ value: core, units, start, end });
    NUMBER_RE.lastIndex = end;
  }

  return out;
}

/** True when the whole string is exactly one value expression and nothing else. */
export function isBareValue(text: string): ParsedValue | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const parsed = parseValues(trimmed);
  if (parsed.length !== 1) return null;
  const p = parsed[0];
  return p.start === 0 && p.end === trimmed.length ? p : null;
}

/** Whether a header/caption string names a time period (used for dimensions). */
export function looksLikePeriod(text: string): boolean {
  const t = text.trim().toLowerCase();
  return /^(fy\s?)?(19|20)\d{2}$/.test(t) || /^q[1-4]\b/.test(t);
}

/**
 * Units stated in a caption or header that apply to the values beneath it —
 * e.g. "Revenue in $ millions".
 */
export function unitsFromContext(
  text: string,
  source: AnnotationSource,
): UnitAnnotation[] {
  const out: UnitAnnotation[] = [];
  if (!text) return out;

  const symbol = /[$€£¥]/.exec(text);
  if (symbol) out.push({ kind: 'currency', text: symbol[0], source });

  const lower = text.toLowerCase();
  for (const w of SCALE_WORDS) {
    if (new RegExp(`\\b${w}\\b`).test(lower)) {
      const match = new RegExp(`\\b${w}\\b`, 'i').exec(text);
      out.push({ kind: 'scale', text: match ? match[0] : w, source });
      break;
    }
  }

  return out;
}

/**
 * Every distinct phrase from `phrases` present in `haystack`, with overlapping
 * matches collapsed to the longest one.
 *
 * A claim can legitimately carry more than one hedge ("average annual saving of
 * up to $1,200" has two), so this returns all of them. But "individual results
 * may vary" must not also count as "results may vary" — that would inflate the
 * denominator with the same caveat twice.
 */
function matchedPhrases(haystack: string, phrases: string[]): string[] {
  const lower = haystack.toLowerCase();
  const found = phrases.filter((p) => lower.includes(p));
  return found.filter(
    (p) => !found.some((other) => other !== p && other.length > p.length && other.includes(p)),
  );
}

/**
 * Claim qualifiers found in a piece of text. Deliberately narrow: hedging,
 * disclaimers, and restrictions only. Never table headers, never units.
 */
export function qualifiersFromText(
  text: string,
  source: QualifierSource,
): Qualifier[] {
  const out: Qualifier[] = [];
  if (!text) return out;

  for (const t of matchedPhrases(text, APPROXIMATION_PHRASES)) {
    out.push({ kind: 'approximation', text: t, source });
  }
  for (const t of matchedPhrases(text, DISCLAIMER_PHRASES)) {
    out.push({ kind: 'disclaimer', text: t, source });
  }
  for (const t of matchedPhrases(text, RESTRICTION_PHRASES)) {
    out.push({ kind: 'restriction', text: t, source });
  }

  return out;
}

/**
 * Collapses qualifiers that say the same thing, so a caveat stated both inline
 * and in a referenced footnote enters the denominator exactly once.
 */
export function dedupeQualifiers(qualifiers: Qualifier[]): Qualifier[] {
  const seen = new Set<string>();
  const out: Qualifier[] = [];
  for (const q of qualifiers) {
    const key = `${q.kind}:${q.text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }
  return out;
}

/** Same collapsing for unit annotations. */
export function dedupeUnits(units: UnitAnnotation[]): UnitAnnotation[] {
  const seen = new Set<string>();
  const out: UnitAnnotation[] = [];
  for (const u of units) {
    const key = `${u.kind}:${u.text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u);
  }
  return out;
}

/** Exported for tests and for the qualifier documentation. */
export const QUALIFIER_VOCABULARY = {
  approximation: APPROXIMATION_PHRASES,
  disclaimer: DISCLAIMER_PHRASES,
  restriction: RESTRICTION_PHRASES,
};

export { TIME_UNITS };
