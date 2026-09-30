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
