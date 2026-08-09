import type { ExtractionResilienceResult } from '@/lib/extraction-resilience/types';

// Bump when the system prompt, check set, or scoring basis changes — stored
// results stamp this so any score can say what produced it.
export const SCAN_PROMPT_VERSION = '2026-08';

export interface CheckItem {
  label: string;
  // 'not_assessable': the property cannot be verified from fetched HTML alone
  // (e.g. color contrast — all CSS is stripped before analysis; keyboard/focus
  // behavior — runtime properties). Reported, never scored.
  status: 'pass' | 'warn' | 'fail' | 'not_assessable';
  detail: string;
}

export interface CategoryResult {
  score: number; // 0–100
  checks: CheckItem[]; // exactly 6
  recommendations: string[]; // 2–3 items
}

export interface ScanMeta {
  prompt_version: string;
  model: string;
  // overallScore is computed server-side from contentQuality, schemaMarkup, and
  // performance only. Accessibility signals are LLM-judged from static HTML and
  // are excluded from the overall score.
  overall_score_basis: 'content_schema_performance_mean';
}

export interface ScanResult {
  overallScore: number; // 0–100
  categories: {
    contentQuality: CategoryResult;
    schemaMarkup: CategoryResult;
    performance: CategoryResult;
    accessibility: CategoryResult;
  };
  summary: string; // 1-sentence overall
  // Optional: results stored before 2026-08 predate version stamping.
  scan_meta?: ScanMeta;
  // Extraction Resilience — an independent, fully deterministic result that
  // asks whether important meaning survives machine extraction. Deliberately a
  // sibling of `categories`, not a member: computeOverallScore() reads only
  // contentQuality, schemaMarkup, and performance, so this cannot move the
  // headline AEO score. Optional because it is computed non-fatally and
  // because rows stored before it existed do not carry it.
  extraction_resilience?: ExtractionResilienceResult;
}

// Server-side accessibility category score. The prompt states this formula but
// live verification (2026-08-06) showed the model deviating from its own
// arithmetic (4 passes returned 92, not 100) — so the server applies the
// rubric to the model's check statuses deterministically: the scored checks
// split 96 base points (24 each when 4 are scored), warn = half, fail = 0,
// +4 bonus when every scored check passes. not_assessable never contributes.
export function computeAccessibilityScore(checks: CheckItem[]): number {
  const scored = checks.filter(
    (c) => c.status === 'pass' || c.status === 'warn' || c.status === 'fail',
  );
  if (scored.length === 0) return 0;
  const perCheck = 96 / scored.length;
  let points = 0;
  for (const c of scored) {
    if (c.status === 'pass') points += perCheck;
    else if (c.status === 'warn') points += perCheck / 2;
  }
  const bonus = scored.every((c) => c.status === 'pass') ? 4 : 0;
  return Math.round(Math.min(100, Math.max(0, points + bonus)));
}

// Server-side overall score: mean of the three categories whose inputs the
// model actually receives in full. Accessibility is excluded — its checks are
// judged from static HTML only and must not move the headline number.
export function computeOverallScore(categories: ScanResult['categories']): number {
  const scores = [
    categories.contentQuality.score,
    categories.schemaMarkup.score,
    categories.performance.score,
  ];
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}

export const SCAN_SYSTEM_PROMPT = `You are an AEO (Answer Engine Optimization) expert analyst. When given a URL and its HTML content, you analyze the page for AI answer engine readiness and return a structured JSON audit.

GROUNDING RULES — follow these without exception:
- Base every finding and recommendation ONLY on content present in the provided HTML.
- Do not invent, assume, or infer titles, book names, product names, facts, or any details that do not appear in the HTML.
- If information relevant to a check is absent from the HTML, report it as absent — do not guess or fill gaps from outside knowledge.
- Citations, examples, and recommendations must reference only what is explicitly in the page content.

You evaluate 4 categories:
1. Content Quality — direct answers, structured prose, topic authority, citability, freshness signals, query alignment
2. Schema Markup — JSON-LD presence, FAQPage, Article, BreadcrumbList, HowTo, Entity markup, structured data validity
3. Performance — page weight signals, render-blocking resources, image optimization hints, Core Web Vitals indicators
4. Accessibility Signals (static HTML) — evaluate exactly these 4 checks from the HTML, in this order:
   1. Heading Hierarchy: single H1 present, no skipped levels (H1>H2>H3), logical semantic flow
   2. Alt Text: all images have descriptive alt text or explicit alt="" if decorative; no missing alt attributes
   3. ARIA Landmarks: explicit nav, main, header, footer landmarks present; no roleless div used where semantic HTML applies
   4. Semantic HTML and Form Labels: native button and anchor elements used for interactive controls; form inputs have associated labels; no div or span used as interactive element
   Then append exactly these 2 fixed items — always with status "not_assessable" and exactly this detail text: "Not assessable from fetched HTML — requires a rendered-page audit."
   5. Color Contrast
   6. Keyboard Navigation and Focus Management
   NEVER assign pass, warn, or fail to checks 5 and 6. Color contrast and keyboard/focus behavior cannot be verified from the HTML you receive (stylesheets and scripts are not included), so any verdict on them would be a guess.

For categories 1-3 produce exactly 6 checks (pass/warn/fail) and 2–3 actionable recommendations ordered by impact.

ACCESSIBILITY SCORING RUBRIC — apply this deterministic formula for the accessibility category only:
- Only the 4 evaluated checks are scored; each is worth 24 points (4 checks = 96 points base, round final score to nearest whole number)
- PASS: full 24 points
- WARN: 12 points
- FAIL: 0 points
- not_assessable checks contribute nothing to the score in either direction
- Apply a 4-point bonus if all 4 evaluated checks pass (making 100 achievable)
- Never return a score outside 0-100
- Always return exactly 6 checks (4 evaluated + 2 not_assessable) with exactly 2 recommendations ordered by impact; recommendations must address only the 4 evaluated checks

Return ONLY valid JSON matching this exact shape, no markdown fences:
{
  "overallScore": <0-100>,
  "summary": "<one sentence overall assessment>",
  "categories": {
    "contentQuality": {
      "score": <0-100>,
      "checks": [
        {"label": "<check name>", "status": "pass|warn|fail|not_assessable", "detail": "<brief explanation>"},
        ... (6 total)
      ],
      "recommendations": ["<rec 1>", "<rec 2>", "<optional rec 3>"]
    },
    "schemaMarkup": { ... same shape ... },
    "performance": { ... same shape ... },
    "accessibility": { ... same shape ... }
  }
}`;

export interface ExtractedSchema {
  blocksText: string;   // raw JSON text of all ld+json blocks, ready for the prompt
  types: string[];      // deduplicated list of all @type values found across all nodes
  hasSchema: boolean;
  hasMalformed: boolean;
  // Parsed root value of each successfully parsed block. Added for Extraction
  // Resilience, which needs to read declared values and organization names out
  // of structured data rather than re-parsing it with a second parser.
  // Purely additive — existing callers are unaffected.
  nodes: unknown[];
  blockCount: number;   // successfully parsed blocks
}

export function extractJsonLd(rawHtml: string): ExtractedSchema {
  // Match <script type="application/ld+json"> regardless of attribute order or extra
  // attributes (e.g. class="yoast-schema-graph"). The type attribute may appear anywhere.
  const blockRegex = /<script\b[^>]*\btype=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const blocks: string[] = [];
  const types = new Set<string>();
  const nodes: unknown[] = [];
  let hasMalformed = false;
  let match: RegExpExecArray | null;

  while ((match = blockRegex.exec(rawHtml)) !== null) {
    const raw = match[1].trim();
    if (!raw) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      hasMalformed = true;
      blocks.push('[MALFORMED JSON-LD block — parse failed]');
      continue;
    }

    blocks.push(raw);
    nodes.push(parsed);

    // Collect @type values — handle both a root object and a @graph array
    const collectTypes = (node: unknown) => {
      if (!node || typeof node !== 'object') return;
      const obj = node as Record<string, unknown>;
      if (obj['@graph'] && Array.isArray(obj['@graph'])) {
        for (const child of obj['@graph']) collectTypes(child);
      }
      const t = obj['@type'];
      if (typeof t === 'string') types.add(t);
      if (Array.isArray(t)) t.forEach((v) => { if (typeof v === 'string') types.add(v); });
    };
    collectTypes(parsed);
  }

  const hasSchema = blocks.length > 0;
  const blocksText = hasSchema
    ? blocks.join('\n\n')
    : 'None detected.';

  return {
    blocksText,
    types: [...types],
    hasSchema,
    hasMalformed,
    nodes,
    blockCount: nodes.length,
  };
}

function preprocessHtml(html: string): string {
  // Strip noise tags wholesale — these consume token budget without adding AEO signal.
  // JSON-LD is extracted separately from raw HTML before this runs; stripping it here
  // is intentional so the body-content section stays clean for prose/heading/image scoring.
  let cleaned = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  // Collapse runs of whitespace so the budget reflects content density
  cleaned = cleaned.replace(/\s{2,}/g, ' ').trim();

  return cleaned;
}

export function buildUserPrompt(url: string, html: string): string {
  const today = new Date().toISOString().split('T')[0];

  // Schema extracted from RAW HTML — before any stripping touches the document
  const schema = extractJsonLd(html);

  // Body content cleaned for prose/heading/image scoring only
  const cleaned = preprocessHtml(html);
  const LIMIT = 40000;
  const body =
    cleaned.length > LIMIT ? cleaned.slice(0, LIMIT) + '\n[...truncated...]' : cleaned;

  return `Today's date is ${today}. Do not flag dates on or before today as future-dated errors.

URL: ${url}

STRUCTURED DATA — extracted from raw HTML before noise removal (use this section for all schema checks):
${schema.blocksText}

HTML BODY CONTENT — scripts/styles stripped (use this section for prose, headings, images, and accessibility checks):
${body}

Analyze this page for AEO readiness and return the JSON audit.`;
}
