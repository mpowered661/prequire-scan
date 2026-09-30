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
