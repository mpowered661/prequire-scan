import { parseValues } from './values';
import type {
  StructuredExtraction,
  FlattenedExtraction,
  ResilienceMeasure,
  ResilienceMeasures,
  Contradiction,
  ValueBinding,
} from './types';

// Compares EXTRACT_A (structure intact) against EXTRACT_B (flattened) and
// reports what survived. Numerator and denominator are always retained: 1/1 and
// 40/40 are not the same evidence, and collapsing both to "100%" would hide it.
//
// The three measures count three different things and must not be mixed:
//   structural_resilience — relationships between elements
//   factual_resilience    — whole facts (label + every dimension + value)
//   qualifier_resilience  — claim qualifiers only (hedges, disclaimers,
//                           restrictions, footnotes). Table headers are
//                           attribution, not qualifiers, and never appear here.

// How far from a value its label may drift and still be recoverable.
const LABEL_WINDOW = 6;
// A dimension or annotation must stay genuinely adjacent to remain attributable.
const ATTRIBUTION_WINDOW = 4;
const LOST_EXAMPLE_CAP = 10;

const CHART_HINTS = [
  'chart', 'graph', 'infographic', 'diagram', 'figure', 'plot',
  'stats', 'statistics', 'dashboard', 'visualization', 'viz', 'table',
];

const PRICE_KEYS = ['price', 'lowprice', 'highprice', 'ratingvalue', 'amount'];

// Labels that legitimately carry one value per offer, variant, or product card
// on the same page. Same-label differences under these are different facts,
// never a duplicate-label conflict.
const COMMERCE_MULTIVALUE_LABELS = ['price', 'amount', 'rating'];

function emptyMeasure(): ResilienceMeasure {
  return {
    preserved: 0,
    assessed: 0,
    undeterminable: 0,
    notApplicable: true,
    ratio: null,
    lost: [],
  };
}

function finalize(m: ResilienceMeasure): ResilienceMeasure {
  m.notApplicable = m.assessed === 0;
  m.ratio = m.assessed === 0 ? null : m.preserved / m.assessed;
  if (m.lost.length > LOST_EXAMPLE_CAP) m.lost = m.lost.slice(0, LOST_EXAMPLE_CAP);
  return m;
}

function normalizeToken(t: string): string {
  return t.toLowerCase().replace(/^[^\w$%€£¥]+|[^\w$%€£¥]+$/g, '');
}

/** Indices of tokens whose numeric core equals `value`. */
function valueIndices(tokens: string[], value: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (parseValues(tokens[i]).some((p) => p.value === value)) out.push(i);
  }
  return out;
}

function labelHead(label: string): string | null {
  const words = label.toLowerCase().replace(/[^\w\s-]/g, ' ').split(/\s+/).filter(Boolean);
  return words.length ? words[words.length - 1] : null;
}

function labelNearBefore(normTokens: string[], idx: number, label: string): boolean {
  const head = labelHead(label);
  if (!head) return false;
  for (let i = Math.max(0, idx - LABEL_WINDOW); i < idx; i++) {
    if (normTokens[i] === head) return true;
  }
  return false;
}

/** Nearest distance from a value occurrence to a token matching `text`. */
function nearestDistance(
  normTokens: string[],
  valueIdx: number,
  text: string,
): number | null {
  const needle = normalizeToken(text);
  if (!needle) return null;
  let best: number | null = null;
  const from = Math.max(0, valueIdx - ATTRIBUTION_WINDOW);
  const to = Math.min(normTokens.length - 1, valueIdx + ATTRIBUTION_WINDOW);
  for (let i = from; i <= to; i++) {
    if (i === valueIdx) continue;
    if (normTokens[i] === needle || normTokens[i].includes(needle)) {
      const d = Math.abs(i - valueIdx);
      if (best === null || d < best) best = d;
    }
  }
  return best;
}

/**
 * Is a dimension label still unambiguously attributable to this value?
 *
 * Proximity alone is not enough. In "North 4.2 5.1" the header 2025 may sit
 * near 4.2, but 2026 sits just as near, so nothing in the flattened stream says
 * which figure is which. A competing term from the same axis at comparable
 * distance means the attribution is lost.
 */
function dimensionSurvives(
  normTokens: string[],
  valueIdx: number,
  dimensionLabel: string,
  rivalLabels: Set<string>,
): boolean {
  const own = nearestDistance(normTokens, valueIdx, dimensionLabel);
  if (own === null) return false;

  for (const rival of rivalLabels) {
    if (normalizeToken(rival) === normalizeToken(dimensionLabel)) continue;
    const d = nearestDistance(normTokens, valueIdx, rival);
    if (d !== null && d <= own + 1) return false;
  }
  return true;
}

/**
 * Does the whole fact survive? A fact is the tuple (label, dimensions, value).
 * "South 9.8" without the year is not the fact `South | 2025 | 9.8`.
 */
function factSurvives(
  tokens: string[],
  normTokens: string[],
  b: ValueBinding,
  rivalLabels: Set<string>,
): { survived: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!b.label) return { survived: false, missing: ['label'] };

  const idxs = valueIndices(tokens, b.value);
  if (idxs.length === 0) return { survived: false, missing: ['value'] };

  // The fact survives if ANY occurrence of the value carries the full tuple.
  for (const idx of idxs) {
    const labelOk = labelNearBefore(normTokens, idx, b.label);
    const lostDims = b.dimensions.filter(
      (d) => !dimensionSurvives(normTokens, idx, d.label, rivalLabels),
    );
    if (labelOk && lostDims.length === 0) return { survived: true, missing: [] };
  }

  // Report what was missing at the best occurrence.
  const idx = idxs[0];
  if (!labelNearBefore(normTokens, idx, b.label)) missing.push(`label "${b.label}"`);
  for (const d of b.dimensions) {
    if (!dimensionSurvives(normTokens, idx, d.label, rivalLabels)) {
      missing.push(`${d.source.replace('_', ' ')} "${d.label}"`);
    }
  }
  return { survived: false, missing };
}

function countUndeterminableVisuals(a: StructuredExtraction): number {
  let n = 0;
  for (const img of a.assets.imageCandidates) {
    const haystack = `${img.src} ${img.alt ?? ''}`.toLowerCase();
    if (CHART_HINTS.some((h) => haystack.includes(h))) n += 1;
  }
  n += a.assets.canvas;
  return n;
}

function detectContradictions(a: StructuredExtraction): Contradiction[] {
  const out: Contradiction[] = [];

  for (const declared of a.schema.declaredValues) {
    const key = declared.path.split('.').pop()?.toLowerCase() ?? '';
    if (!PRICE_KEYS.some((k) => key.includes(k))) continue;

    const declaredNum = parseValues(declared.value)[0]?.value;
    if (!declaredNum) continue;

    // A page may legitimately state several values of the same kind — a sale
    // price beside the regular price, one price per offer or variant. Those are
    // different facts, not two values for one fact, so a declared value is
    // contradicted only when the page states this kind of value somewhere and
    // NONE of those statements corroborates it.
    const needle = key.replace('value', '');
    const matching = a.bindings.filter(
      (b) => b.label && b.label.toLowerCase().includes(needle),
    );
    if (matching.length === 0) continue;
    if (matching.some((b) => b.value === declaredNum)) continue;

    const shown = matching[0];
    out.push({
      kind: 'schema_body_value',
      detail: `Structured data declares ${declared.path} as ${declaredNum}, but the page states "${shown.label}" as ${shown.value}.`,
      left: `${declared.path}=${declaredNum}`,
      right: `${shown.label}=${shown.value}`,
      important: true,
    });
  }

  const schemaName = a.identity.schemaOrgName;
  const ogName = a.identity.ogSiteName;
  if (schemaName && ogName) {
    const s = schemaName.toLowerCase();
    const o = ogName.toLowerCase();
    if (!s.includes(o) && !o.includes(s)) {
      out.push({
        kind: 'entity_name',
        detail: `Structured data names the organization "${schemaName}" while og:site_name says "${ogName}".`,
        left: schemaName,
        right: ogName,
        important: true,
      });
    }
  }

  // The same label carrying two different values. The key includes dimensions,
  // because "North" legitimately has one value per column in a matrix table.
  // Price-like labels are excluded entirely: "Price" repeats across offers,
  // variants, and product cards, and without entity identity a difference
  // between those is not two values for the same fact.
  const byLabel = new Map<string, Map<string, ValueBinding>>();
  for (const b of a.bindings) {
    if (!b.label) continue;
    const lowerLabel = b.label.toLowerCase().trim();
    if (COMMERCE_MULTIVALUE_LABELS.some((t) => lowerLabel.includes(t))) continue;
    const dims = b.dimensions.map((d) => d.label.toLowerCase()).sort().join('|');
    const key = `${lowerLabel}#${dims}`;
    const bucket = byLabel.get(key) ?? new Map<string, ValueBinding>();
    if (!bucket.has(b.value)) bucket.set(b.value, b);
    byLabel.set(key, bucket);
  }
  for (const [key, values] of byLabel) {
    if (values.size < 2) continue;
    const label = key.split('#')[0];
    const [first, second] = [...values.keys()];
    out.push({
      kind: 'duplicate_label_conflict',
      detail: `"${label}" appears with more than one value (${[...values.keys()].join(', ')}).`,
      left: `${label}=${first}`,
      right: `${label}=${second}`,
      important: false,
    });
  }

  return out;
}

export function computeMeasures(
  a: StructuredExtraction,
  b: FlattenedExtraction,
): ResilienceMeasures {
  const tokens = b.tokens;
  const normTokens = tokens.map(normalizeToken);

  // Every column header across dimensioned tables competes for attribution.
  const rivalLabels = new Set<string>();
  for (const t of a.tables) {
    if (!t.hasColumnDimension) continue;
    for (const h of t.columnHeaders) if (h) rivalLabels.add(h);
  }

  // ── factual resilience ─────────────────────────────────────
  const factual = emptyMeasure();
  factual.undeterminable = countUndeterminableVisuals(a);
  for (const binding of a.bindings) {
    // Column attribution defeated by rowspan/colspan: not credited, not
    // penalised, surfaced as undeterminable.
    if (binding.dimensionUnresolved) {
      factual.undeterminable += 1;
      continue;
    }
    factual.assessed += 1;
    if (!binding.label) {
      factual.lost.push(`${binding.value} (no label in source)`);
      continue;
    }
    const { survived, missing } = factSurvives(tokens, normTokens, binding, rivalLabels);
    if (survived) factual.preserved += 1;
    else {
      factual.lost.push(
        `${binding.label} = ${binding.value} — lost ${missing.join(', ') || 'attribution'}`,
      );
    }
  }

  // ── qualifier resilience ───────────────────────────────────
  // Claim qualifiers only. A page with none reports not_applicable, never 0/N.
  const qualifier = emptyMeasure();
  for (const binding of a.bindings) {
    const idxs = valueIndices(tokens, binding.value);
    for (const q of binding.qualifiers) {
      qualifier.assessed += 1;

      // A footnote reference cannot survive flattening: the marker becomes a
      // bare digit indistinguishable from data, and the small print is
      // attributable to no particular value.
      if (q.kind === 'footnote') {
        qualifier.lost.push(`${binding.label ?? binding.value}: footnote "${q.text}" is orphaned`);
        continue;
      }

      // Hedging and disclaimer wording is plain text; it survives if it stays
      // near the value it conditions.
      const survives =
        idxs.length > 0 &&
        idxs.some((idx) => nearestDistance(normTokens, idx, q.text.split(/\s+/)[0]) !== null);

      if (survives) qualifier.preserved += 1;
      else qualifier.lost.push(`${binding.label ?? binding.value}: ${q.kind} "${q.text}"`);
    }
  }

  // ── structural resilience ──────────────────────────────────
  const structural = emptyMeasure();
  for (const rel of a.relations) {
    structural.assessed += 1;
    let survives: boolean;
    switch (rel.kind) {
      case 'heading_to_content':
        // Linear order is exactly what flattening preserves.
        survives = true;
        break;
      case 'definition_term_to_value':
      case 'table_cell_to_row_header': {
        const value = parseValues(rel.from)[0]?.value ?? rel.from;
        survives = valueIndices(tokens, value).some((idx) =>
          labelNearBefore(normTokens, idx, rel.to),
        );
        break;
      }
      case 'table_cell_to_column_header':
        // A column header is separated from its cells by every other row.
        survives = false;
        break;
      case 'figure_to_caption':
        // The image contributes no text, so nothing anchors the caption to it.
        survives = false;
        break;
      case 'footnote_ref_to_text':
        survives = false;
        break;
      default:
        survives = false;
    }
    if (survives) structural.preserved += 1;
    else structural.lost.push(`${rel.kind}: ${rel.from} → ${rel.to}`);
  }

  const contradictions = detectContradictions(a);

  return {
    structural_resilience: finalize(structural),
    factual_resilience: finalize(factual),
    qualifier_resilience: finalize(qualifier),
    contradiction_count: contradictions.length,
    contradictions,
    delta: {
      aTextLength: a.text.length,
      bTextLength: b.length,
      bindingLossRatio:
        factual.assessed === 0 ? null : 1 - factual.preserved / factual.assessed,
      structuralRelationsLost: structural.assessed - structural.preserved,
      structuralRelationsTotal: structural.assessed,
    },
  };
}
