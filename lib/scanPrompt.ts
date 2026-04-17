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

You evaluate 4 categories:
1. Content Quality — direct answers, structured prose, topic authority, citability, freshness signals, query alignment
2. Schema Markup — JSON-LD presence, FAQPage, Article, BreadcrumbList, HowTo, Entity markup, structured data validity
3. Performance — page weight signals, render-blocking resources, image optimization hints, Core Web Vitals indicators
4. Accessibility — heading hierarchy, alt text, ARIA landmarks, color contrast signals, semantic HTML

For each category produce exactly 6 checks (pass/warn/fail) and 2–3 actionable recommendations ordered by impact.

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

export function buildUserPrompt(url: string, html: string): string {
  const truncated =
    html.length > 12000 ? html.slice(0, 12000) + '\n[...truncated...]' : html;

  return `URL: ${url}

HTML CONTENT:
${truncated}

Analyze this page for AEO readiness and return the JSON audit.`;
}
