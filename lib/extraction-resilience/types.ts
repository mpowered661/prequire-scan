// Extraction Resilience — Increment 1
//
// The measurable question: **does important meaning survive machine extraction?**
//
// Two extractions of the same page are compared:
//   EXTRACT_A — DOM-aware structural extraction (the reference).
//   EXTRACT_B — Prequire's existing flattened `stripHtml` output, used
//               deliberately as a degraded stress-test path.
//
// EXTRACT_B is NOT "what AI sees". It is a lossy baseline. A large A/B delta
// means the page is vulnerable to lossy extraction; it does not by itself mean
// the page is badly authored.

// ── Status contract ──────────────────────────────────────────
// Deliberately distinct from the scanner's existing CheckItem statuses
// ('pass' | 'warn' | 'fail' | 'not_assessable'). This contract needs five
// states, and it needs 'warning' and the undeterminable/not_applicable split.
// The existing CheckItem type is left untouched so no existing scoring moves.
export type ResilienceStatus =
  | 'pass'
  | 'warning'
  | 'fail'
  // Cannot be determined from available evidence (e.g. facts that may be
  // trapped in images). Surfaced, and excluded from denominators — never
  // silently treated as a pass.
  | 'undeterminable'
  // The page has nothing of this kind to assess. Must not penalize the page.
  | 'not_applicable';

export interface ResilienceCheck {
  id: string;
  label: string;
  status: ResilienceStatus;
  detail: string;
  // Concrete instances behind the status, for the UI. Capped.
  evidence: string[];
}

// ── EXTRACT_A: structural model ──────────────────────────────

export type LabelSource =
  | 'row_header'
  | 'column_header'
  | 'definition_term'
  | 'inline_label'
  | 'list_item_label'
  | 'caption'
  | 'none';

export type BindingOrigin =
  | 'table'
  | 'definition_list'
  | 'paragraph'
  | 'list'
  | 'schema';

// Three different things attach to a value, and conflating them was a real
// defect: a column header is *attribution* (which year is this?), "$ millions"
// is a *unit* (what is it measured in?), and "up to" or "unaudited" is a
// *claim qualifier* (how much should this be trusted?). Each is measured
// separately, and a table with ordinary headers has no claim qualifiers at all.

export type AnnotationSource =
  | 'inline'
  | 'unit_suffix'
  | 'column_header'
  | 'row_header'
  | 'caption'
  | 'footnote_ref';

/** What the value is measured in. Feeds the unit-preservation check. */
export interface UnitAnnotation {
  kind: 'currency' | 'unit' | 'scale';
  text: string;
  source: AnnotationSource;
}

/**
 * An additional attribution axis beyond the primary label — most often a table
 * column header. Part of identifying *which* fact this is, never a qualifier.
 */
export interface Dimension {
  label: string;
  source: 'column_header' | 'row_header' | 'caption';
}

/**
 * A claim qualifier: wording that limits, hedges, or conditions the value.
 * Table headers and ordinary row/column attribution are explicitly NOT
 * qualifiers — they are Dimensions.
 */
export type QualifierKind =
  | 'footnote' // a reference to small print
  | 'approximation' // up to, average, approximately, starting at
  | 'disclaimer' // results vary, terms apply
  | 'restriction'; // eligibility, sample/date limits, unaudited, self-reported

export type QualifierSource = AnnotationSource;

export interface Qualifier {
  kind: QualifierKind;
  text: string;
  source: QualifierSource;
}

/**
 * A number (or other factual value) bound to what it refers to.
 *
 * A fact is only fully identified by the whole tuple: its label, every
 * dimension that distinguishes it from its neighbours, and the value itself.
 * `South | 2025 | 9.8` is not the same fact as `South | 2026 | 3.3`, and an
 * extraction that preserves "South 9.8" without the year has not preserved it.
 */
export interface ValueBinding {
  id: string;
  label: string | null;
  labelSource: LabelSource;
  value: string;
  units: UnitAnnotation[];
  dimensions: Dimension[];
  qualifiers: Qualifier[];
  // True when rowspan/colspan prevented safe column attribution. Such a fact is
  // reported undeterminable rather than credited or penalised on a guess.
  dimensionUnresolved: boolean;
  origin: BindingOrigin;
  context: string;
}

export type StructuralRelationKind =
  | 'heading_to_content'
  | 'table_cell_to_row_header'
  | 'table_cell_to_column_header'
  | 'definition_term_to_value'
  | 'figure_to_caption'
  | 'footnote_ref_to_text';

export interface StructuralRelation {
  id: string;
  kind: StructuralRelationKind;
  // Orientation is fixed across every kind: `from` is the dependent element
  // (a cell, a value, a caption) and `to` is the anchor it must stay attached
  // to (its row header, its defining term, its figure). Survival testing relies
  // on this, so emitting a relation the other way round silently inverts it.
  from: string;
  to: string;
}

export interface TableModel {
  index: number;
  caption: string | null;
  columnHeaders: string[];
  rowHeaders: string[];
  // rows[r][c] — body cell text, excluding any row-header cell.
  rows: string[][];
  hasColumnDimension: boolean;
  isKeyValue: boolean;
}

export interface FigureModel {
  index: number;
  imageSrc: string | null;
  imageAlt: string | null;
  caption: string | null;
}

export interface FootnoteModel {
  marker: string;
  targetId: string | null;
  text: string | null;
  reachable: boolean;
}

export interface HeadingNode {
  level: number;
  text: string;
}

export interface SchemaModel {
  types: string[];
  blockCount: number;
  hasMalformed: boolean;
  // Numeric/short values declared in structured data, for contradiction checks.
  declaredValues: { path: string; value: string }[];
  organizationNames: string[];
}

export interface AssetCounts {
  images: { total: number; withAlt: number; withoutAlt: number; decorative: number };
  // Increment 2 input queue: images a vision pass would need to interpret.
  // Increment 1 records that they exist and never looks inside them.
  imageCandidates: { src: string; alt: string | null; hasAlt: boolean }[];
  tables: number;
  svg: number;
  canvas: number;
  iframes: number;
  jsonLdBlocks: number;
}

export interface IdentitySignals {
  canonicalUrl: string | null;
  title: string | null;
  metaDescription: string | null;
  primaryH1: string | null;
  ogSiteName: string | null;
  ogTitle: string | null;
  schemaOrgName: string | null;
  titleSuffix: string | null;
  resolvedEntity: string | null;
  entitySource: 'json_ld' | 'og_site_name' | 'title_suffix' | 'none';
  pageTopic: string | null;
  topicSource: 'h1' | 'og_title' | 'title' | 'none';
}

/** EXTRACT_A — the DOM-aware reference extraction. */
export interface StructuredExtraction {
  url: string;
  identity: IdentitySignals;
  outline: HeadingNode[];
  bindings: ValueBinding[];
  relations: StructuralRelation[];
  tables: TableModel[];
  figures: FigureModel[];
  footnotes: FootnoteModel[];
  schema: SchemaModel;
  assets: AssetCounts;
  semanticSections: string[];
  text: string;
}

/** EXTRACT_B — the deliberately lossy flattened extraction. */
export interface FlattenedExtraction {
  text: string;
  tokens: string[];
  length: number;
}

// ── Measures ─────────────────────────────────────────────────

/**
 * Numerator and denominator are retained rather than collapsed to a ratio, so a
 * 1/1 result is never presented with the same authority as 40/40.
 * `undeterminable` items are excluded from the denominator and reported.
 */
export interface ResilienceMeasure {
  preserved: number; // numerator
  assessed: number; // denominator — excludes undeterminable and n/a
  undeterminable: number;
  notApplicable: boolean;
  ratio: number | null; // null when assessed === 0
  lost: string[]; // capped examples of what did not survive
}

export type ContradictionKind =
  | 'schema_body_value'
  | 'entity_name'
  | 'duplicate_label_conflict';

export interface Contradiction {
  kind: ContradictionKind;
  detail: string;
  left: string;
  right: string;
  important: boolean;
}

export type ResilienceBand =
  | 'resilient'
  | 'mostly_resilient'
  | 'fragile'
  // Too little was assessable to state a resilience verdict. Never presented as
  // a pass — low coverage must not be able to produce a strong band.
  | 'insufficient_evidence';

export interface ExtractionDelta {
  aTextLength: number;
  bTextLength: number;
  // Share of EXTRACT_A bindings whose label association does not survive B.
  bindingLossRatio: number | null;
  structuralRelationsLost: number;
  structuralRelationsTotal: number;
}

export interface ResilienceMeasures {
  structural_resilience: ResilienceMeasure;
  factual_resilience: ResilienceMeasure;
  qualifier_resilience: ResilienceMeasure;
  contradiction_count: number;
  contradictions: Contradiction[];
  delta: ExtractionDelta;
}

// ── Increment 2 forward declarations (vision deferred) ───────

export interface VisualClaim {
  subject: string;
  value: string;
  context: string;
  source: 'visual';
}

export type ClaimMatchStatus =
  | 'exact_match'
  | 'semantic_match'
  | 'partial'
  | 'absent'
  | 'conflict';

export interface ClaimComparison {
  visual: VisualClaim;
  html: ValueBinding | null;
  status: ClaimMatchStatus;
}

export interface VisualParityReport {
  status: ResilienceStatus;
  claims: VisualClaim[];
  comparisons: ClaimComparison[];
  notes: string[];
}

// ── Reported result ──────────────────────────────────────────

export interface ExtractionResilienceResult {
  band: ResilienceBand;
  // Stable id of the ordered rule that produced the band, so the trigger is
  // machine-checkable and not inferred from prose.
  bandRule: string;
  bandReason: string;
  measures: ResilienceMeasures;
  checks: ResilienceCheck[];
  extractA: StructuredExtraction;
  // EXTRACT_B is reproducible from the page and can be large; only its shape is
  // retained for the report.
  extractB: { length: number; tokenCount: number; sample: string };
  // Always null in Increment 1 — vision is deferred, never fabricated.
  visualParity: VisualParityReport | null;
  meta: {
    increment: 1;
    engine_version: string;
    extract_a: 'dom_structural';
    extract_b: 'flattened_striphtml';
    vision_assessed: false;
    scoring: 'deterministic_band_rules';
  };
}
