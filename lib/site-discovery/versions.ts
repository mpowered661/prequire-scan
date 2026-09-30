export const DISCOVERY_VERSION = 'sd-0.1';
export const NORMALIZATION_VERSION = 'norm-0.1';
export const MANIFEST_VERSION = 'cm-0.1';

// HARD SAFETY CEILINGS. Configuration may LOWER these. Nothing may raise them.
export const MAX_CHILD_SITEMAPS = 10;
export const MAX_SITEMAP_DEPTH = 3;
export const MAX_LOC_ENTRIES = 5000;
export const MAX_DISCOVERY_REQUESTS = 20;
export const MAX_SITEMAP_BYTES = 5 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 15000;
export const MAX_REDIRECTS = 3;

// Tranche B: selection
export const SELECTOR_VERSION = 'sel-0.1';
export const ROLE_PATTERNS_VERSION = 'roles-0.1';
export const EXCLUSIONS_VERSION = 'excl-0.1';
export const ROBOTS_RULES_VERSION = 'robots-0.1';
export const FETCHER_VERSION = 'fetch-0.1';

export const DEFAULT_PAGE_BUDGET = 25;
export const HARD_MAX_SELECTED_PAGES = 50;
export const TIER1_NAV_LIMIT = 12;
export const TIER2_ROLE_LIMIT = 8;

// Tranche B: fetch
export const HARD_MAX_PAGE_FETCHES = 60;
export const HARD_MAX_TOTAL_REQUESTS = 120;
export const MAX_CONCURRENCY = 2;
export const MIN_REQUEST_DELAY_MS = 250;
export const MAX_CRAWL_DELAY_MS = 5000;
export const MAX_RETRIES = 1;
export const RETRY_BACKOFF_MS = 2000;
export const PAGE_FETCH_TIMEOUT_MS = 15000;
export const MAX_PAGE_BYTES = 2 * 1024 * 1024;
export const HARD_MAX_ANALYSIS_BYTES = 786432; // 768 KiB

// Tranche C: link integrity
export const LINK_EXTRACT_VERSION = 'linkx-0.1';
export const TARGET_CHECK_VERSION = 'tcheck-0.1';
export const LINK_INTEGRITY_VERSION = 'li-0.1';
export const DEFAULT_TARGET_CHECK_BUDGET = 40;
export const HARD_MAX_TARGET_CHECKS = 40;
export const MAX_LINKS_PER_PAGE = 500;
export const MAX_ANCHOR_TEXT_CHARS = 200;
export const MAX_HREF_CHARS = 2048;

// Tranche D / Amendment D2: durable evidence minimization.
// RICH TRANSIENT ANALYSIS -> MINIMAL DURABLE EVIDENCE.
export const EVIDENCE_PROJECTION_VERSION = 'evproj-0.1';
export const MAX_EVIDENCE_STRING_CHARS = 200;
// A canonical URL is evidence; 512 is far above any real canonical and well
// below a useful prose payload. Distinct from Tranche C's MAX_HREF_CHARS, which
// bounds a link target Prequire must re-fetch.
export const MAX_EVIDENCE_URL_CHARS = 512;
export const MAX_EVIDENCE_TOKEN_CHARS = 64;
export const MAX_EVIDENCE_LIST_ITEMS = 25;
export const MAX_SCHEMA_TYPES = 25;
export const MAX_SCHEMA_PROPERTY_NAMES = 50;
export const MAX_SCHEMA_WALK_NODES = 500;
// Per page-engine observation, serialized. Distinct from HARD_MAX_ANALYSIS_BYTES,
// which bounds analysis INPUT. See CONTRACT AMENDMENT D2 for the derivation.
export const MAX_DURABLE_OBSERVATION_BYTES = 4096;
