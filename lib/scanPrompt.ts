export interface CheckItem {
  label: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}

export interface CategoryResult {
  score: number; // 0–100
  checks: CheckItem[]; // exactly 6
  recommendations: string[]; // 2–3 items
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
4. Accessibility — evaluate exactly these 6 checks in this order:
   1. Heading Hierarchy: single H1 present, no skipped levels (H1>H2>H3), logical semantic flow
   2. Alt Text: all images have descriptive alt text or explicit alt="" if decorative; no missing alt attributes
   3. ARIA Landmarks: explicit nav, main, header, footer landmarks present; no roleless div used where semantic HTML applies
   4. Color Contrast: text contrast signals visible (dark text on light backgrounds, no light-on-light combinations evident from HTML/CSS); explicit contrast failure indicators flagged
   5. Semantic HTML and Form Labels: native button and anchor elements used for interactive controls; form inputs have associated labels; no div or span used as interactive element
   6. Keyboard Navigation and Focus Management: skip link present as first focusable element; focus indicators not suppressed; interactive elements reachable without mouse

For each category produce exactly 6 checks (pass/warn/fail) and 2–3 actionable recommendations ordered by impact.

ACCESSIBILITY SCORING RUBRIC — apply this deterministic formula for the accessibility category only:
- Each check is worth 16 points (6 checks = 96 points base, round final score to nearest whole number)
- PASS: full 16 points
- WARN: 8 points
- FAIL: 0 points
- Apply a 4-point accessibility bonus if all 6 checks pass (making 100 achievable)
- Never return a score outside 0-100
- Always return exactly 6 checks with exactly 2 recommendations ordered by impact

Return ONLY valid JSON matching this exact shape, no markdown fences:
{
  "overallScore": <0-100>,
  "summary": "<one sentence overall assessment>",
  "categories": {
    "contentQuality": {
      "score": <0-100>,
      "checks": [
        {"label": "<check name>", "status": "pass|warn|fail", "detail": "<brief explanation>"},
        ... (6 total)
      ],
      "recommendations": ["<rec 1>", "<rec 2>", "<optional rec 3>"]
    },
    "schemaMarkup": { ... same shape ... },
    "performance": { ... same shape ... },
    "accessibility": { ... same shape ... }
  }
}`;

interface ExtractedSchema {
  blocksText: string;   // raw JSON text of all ld+json blocks, ready for the prompt
  types: string[];      // deduplicated list of all @type values found across all nodes
  hasSchema: boolean;
  hasMalformed: boolean;
}

export function extractJsonLd(rawHtml: string): ExtractedSchema {
  // Match <script type="application/ld+json"> regardless of attribute order or extra
  // attributes (e.g. class="yoast-schema-graph"). The type attribute may appear anywhere.
  const blockRegex = /<script\b[^>]*\btype=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const blocks: string[] = [];
  const types = new Set<string>();
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

  return { blocksText, types: [...types], hasSchema, hasMalformed };
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
