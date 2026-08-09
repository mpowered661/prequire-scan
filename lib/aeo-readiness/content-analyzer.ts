import type {
  ContentDeliveryResult,
  MetaTagsResult,
  CloakingResult,
} from './types';

const JS_CHALLENGE_INDICATORS = [
  'javascript is required',
  'please enable javascript',
  'checking your browser',
  'cf-browser-verification',
  'just a moment',
  '_cf_chl',
  'challenge-platform',
  'ray id',
] as const;

// Exported so the Extraction Resilience EXTRACT_B path can reuse this exact
// flattening rather than reimplementing a second lossy extractor. Behavior is
// unchanged for existing callers.
export function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectJsChallenge(body: string): { detected: boolean; indicators: string[] } {
  const lower = body.toLowerCase();
  const found = JS_CHALLENGE_INDICATORS.filter((indicator) =>
    lower.includes(indicator),
  );
  return { detected: found.length > 0, indicators: [...found] };
}

function detectContentPresence(body: string): boolean {
  const hasArticle = /<article[\s>]/i.test(body);
  const hasMain = /<main[\s>]/i.test(body);
  const hasH1 = /<h1[\s>]/i.test(body);

  const pMatches = [...body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)];
  const substantialParagraphs = pMatches.filter(
    (m) => stripHtml(m[1]).length > 20,
  ).length;

  return hasArticle || hasMain || hasH1 || substantialParagraphs >= 3;
}

export function analyzeContentDelivery(body: string): ContentDeliveryResult {
  const htmlBytes = Buffer.byteLength(body, 'utf8');
  const stripped = stripHtml(body);
  const textBytes = Buffer.byteLength(stripped, 'utf8');
  const text_html_ratio = htmlBytes > 0 ? textBytes / htmlBytes : 0;

  const { detected: js_challenge_detected, indicators: challenge_indicators } =
    detectJsChallenge(body);
  const content_appears_rendered = detectContentPresence(body);

  let status: ContentDeliveryResult['status'] = 'ok';
  if (htmlBytes === 0) {
    status = 'empty';
  } else if (js_challenge_detected) {
    status = 'js_challenge';
  } else if (text_html_ratio < 0.05) {
    status = 'client_side_rendered';
  }

  return {
    html_bytes: htmlBytes,
    text_bytes: textBytes,
    text_html_ratio: Math.round(text_html_ratio * 1000) / 1000,
    js_challenge_detected,
    challenge_indicators,
    content_appears_rendered,
    status,
  };
}

function parseMetaContent(body: string, nameAttr: string): string | null {
  // Handles both name="x" content="y" and content="y" name="x" orderings
  const pattern = new RegExp(
    `<meta[^>]+name=["']${nameAttr}["'][^>]+content=["']([^"']+)["']` +
      `|<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${nameAttr}["']`,
    'i',
  );
  const match = body.match(pattern);
  return match ? (match[1] ?? match[2] ?? null) : null;
}

function parseCanonical(body: string): string | null {
  const match = body.match(
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']|<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i,
  );
  return match ? (match[1] ?? match[2] ?? null) : null;
}

export function analyzeMetaTags(body: string, crawlerName: string): MetaTagsResult {
  const robotsContent = parseMetaContent(body, 'robots');
  const botSpecificContent = parseMetaContent(body, crawlerName);
  const canonical = parseCanonical(body);

  const directivesToCheck = [
    robotsContent ?? '',
    botSpecificContent ?? '',
  ]
    .join(',')
    .toLowerCase();

  // noai and noimageai are informational — they signal intent but are not
  // enforced by crawlers today. noarchive is a caching directive, not a block.
  const AI_BLOCKING_DIRECTIVES = ['noai', 'noimageai', 'noarchive'];
  const ai_blocking_directives = AI_BLOCKING_DIRECTIVES.filter((d) =>
    directivesToCheck.includes(d),
  );

  const isHardBlocked =
    directivesToCheck.includes('noindex') ||
    directivesToCheck.includes('none') ||
    directivesToCheck.includes('nofollow');

  let status: MetaTagsResult['status'] = 'ok';
  if (!robotsContent && !botSpecificContent) {
    status = 'missing';
  } else if (isHardBlocked || directivesToCheck.includes('noai')) {
    // noai is treated as a blocking directive for AEO purposes
    status = 'blocked_via_meta';
  }

  return {
    robots_directive: robotsContent,
    ai_blocking_directives,
    canonical,
    status,
  };
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

export function analyzeCloaking(
  botBody: string,
  browserBody: string,
): CloakingResult {
  if (!botBody || !browserBody) {
    return { divergence_pct: 0, status: 'not_tested' };
  }

  const botText = stripHtml(botBody).slice(0, 2000);
  const browserText = stripHtml(browserBody).slice(0, 2000);

  const botWords = tokenize(botText);
  const browserWords = tokenize(browserText);

  if (botWords.length === 0 && browserWords.length === 0) {
    return { divergence_pct: 0, status: 'not_tested' };
  }

  const botSet = new Set(botWords);
  const browserSet = new Set(browserWords);

  // Dice coefficient: 2 * |intersection| / (|A| + |B|)
  // Using unique word sets to reduce noise from repeated boilerplate
  let shared = 0;
  for (const word of botSet) {
    if (browserSet.has(word)) shared++;
  }

  const overlap = (2 * shared) / (botSet.size + browserSet.size);
  const divergence_pct = Math.round((1 - overlap) * 100) / 100;

  return {
    divergence_pct,
    status: divergence_pct > 0.3 ? 'potential_cloaking' : 'ok',
  };
}
