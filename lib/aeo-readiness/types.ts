export type CrawlerTier = 'critical' | 'important' | 'other' | 'seo';

export type RobotsTxtStatus = 'allowed' | 'disallowed' | 'no_robots_txt' | 'error';
// 'refused' = HTTP-layer refusal (403/429/other 4xx). A UA simulation cannot present
// verified crawler IPs, so a refusal never proves the real crawler is blocked.
export type HttpResponseStatus = 'ok' | 'refused' | 'challenged' | 'error' | 'not_applicable';
export type ContentDeliveryStatus = 'ok' | 'js_challenge' | 'client_side_rendered' | 'empty' | 'not_applicable';
export type MetaTagsStatus = 'ok' | 'blocked_via_meta' | 'missing' | 'not_applicable';
export type CloakingStatus = 'ok' | 'potential_cloaking' | 'not_tested' | 'not_applicable';
// 'blocked' is reserved for declarative blocks (robots.txt disallow, meta robots).
// HTTP-layer refusals and challenges are 'undeterminable via UA simulation'.
export type OverallStatus = 'accessible' | 'partial' | 'blocked' | 'undeterminable';
export type BlockerLayer =
  | 'robots_txt'
  | 'waf'
  | 'cdn'
  | 'meta_tags'
  | 'client_render'
  | 'server_error'
  | 'unknown'
  | 'none';
export type FixPriority = 'critical' | 'high' | 'medium' | 'low';

export interface RobotsTxtResult {
  status: RobotsTxtStatus;
  matched_rule: string | null;
  details: string;
  malformed?: boolean;
}

export interface HttpResponseResult {
  status_code: number;
  response_time_ms: number;
  server: string | null;
  waf_detected: string | null;
  status: HttpResponseStatus;
}

export interface ContentDeliveryResult {
  html_bytes: number;
  text_bytes: number;
  text_html_ratio: number;
  js_challenge_detected: boolean;
  challenge_indicators: string[];
  content_appears_rendered: boolean;
  status: ContentDeliveryStatus;
}

export interface MetaTagsResult {
  robots_directive: string | null;
  ai_blocking_directives: string[];
  canonical: string | null;
  status: MetaTagsStatus;
}

export interface CloakingResult {
  divergence_pct: number;
  status: CloakingStatus;
}

export interface CrawlerTests {
  robots_txt: RobotsTxtResult;
  http_response: HttpResponseResult;
  content_delivery: ContentDeliveryResult;
  meta_tags: MetaTagsResult;
  cloaking: CloakingResult;
}

export interface CrawlerResult {
  crawler_name: string;
  user_agent: string;
  tests: CrawlerTests;
  overall_status: OverallStatus;
  blocker_layer: BlockerLayer;
  blocker_detail: string;
}

export interface Fix {
  priority: FixPriority;
  issue: string;
  affected_crawlers: string[];
  fix_summary: string;
  fix_steps: string[];
  fix_platform: string | null;
}

export interface DetectedStack {
  web_server: string | null;
  cdn: string | null;
  waf: string | null;
  cms: string | null;
  cms_theme: string | null;
}

export interface LlmsTxt {
  present: boolean;
  url: string | null;
}

export interface ReportSummary {
  total_crawlers_tested: number;
  accessible: number;
  partial: number;
  blocked: number;
  // Verdicts a UA simulation cannot make: HTTP refusals and browser challenges.
  // Excluded from the score denominator. Optional because reports stored before
  // 2026-07 predate the concept — legacy reports must render with no basis line
  // rather than asserting a coverage they never measured.
  undeterminable?: number;
  primary_blocker: string | null;
}

export interface AeoReadinessReport {
  url: string;
  tested_at: string;
  aeo_readiness_score: number;
  summary: ReportSummary;
  crawler_results: CrawlerResult[];
  detected_stack: DetectedStack;
  fixes: Fix[];
  llms_txt: LlmsTxt;
}

export interface CrawlerDefinition {
  name: string;
  user_agent: string;
  tier: CrawlerTier;
  // 'robots_only': a robots.txt directive token, not a fetchable bot (Google-Extended).
  // Never fetched over HTTP; verdict comes from the robots.txt check alone.
  check_type?: 'http' | 'robots_only';
}

export interface RawCrawlerFetch {
  crawler_name: string;
  user_agent: string;
  status_code: number;
  response_time_ms: number;
  headers: Record<string, string>;
  body: string;
  error: string | null;
}

export interface HttpTesterOptions {
  include_seo_bots?: boolean;
}
