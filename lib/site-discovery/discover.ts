import { buildManifest } from './coverage-manifest';
import { validateUrl } from './egress-policy';
import { Inventory, type DiscoveryMethod } from './inventory';
import { normalizeUrl } from './normalize-url';
import { extractSitemapDirectives } from './robots-sitemaps';
import { parseSitemap } from './sitemap-parser';
import type { DiscoveryConfig, DiscoveryResult, RunDiscoveryInput } from './types';
import {
  FETCH_TIMEOUT_MS,
  MAX_CHILD_SITEMAPS,
  MAX_DISCOVERY_REQUESTS,
  MAX_LOC_ENTRIES,
  MAX_REDIRECTS,
  MAX_SITEMAP_BYTES,
  MAX_SITEMAP_DEPTH,
} from './versions';

const USER_AGENT = 'Prequire-SiteDiscovery/0.1 (+https://prequire.ai)';

interface FetchOutcome {
  ok: boolean;
  status: number | null;
  body: string | null;
  finalUrl: string;
  error?: string;
}

type BodyOutcome =
  | { ok: true; body: string }
  | { ok: false; error: 'oversize' };

export async function runDiscovery(input: RunDiscoveryInput): Promise<DiscoveryResult> {
  const startedAt = new Date().toISOString();
  const scanMode = input.scanMode ?? 'prospect_observation';
  const config = clampConfig(input.config);
  const inventory = new Inventory();
  const methodsUsed: DiscoveryMethod[] = [];
  const queuedSitemaps: Array<{ url: string; method: DiscoveryMethod; depth: number; discoveredFrom: string | null }> = [];
  let requestsMade = 0;
  let sitemapsFound = 0;
  let sitemapsParsed = 0;
  // True once normal discovery has produced USABLE sitemap discovery: a sitemap
  // document parsed successfully, or a sitemap URL queued. A valid <urlset>
  // queues nothing, so an empty queue alone must never imply discovery failed.
  let discoveryYieldedSitemap = false;
  let sitemapsSkippedCrossOrigin = 0;
  let sitemapEntriesSeen = 0;
  let childSitemapsQueued = 0;
  let discoveryComplete = true;
  let truncationReason: string | null = null;
  let partial = false;

  const validated = await validateUrl(input.seedUrl);
  if (!validated.ok) {
    const manifest = buildManifest({
      scanId: input.scanId,
      scanMode,
      domain: '',
      seedUrl: input.seedUrl,
      startedAt,
      completedAt: new Date().toISOString(),
      status: 'aborted',
      abortReason: validated.reason,
      config,
      urls: [],
      methodsUsed: [],
      sitemapsFound: 0,
      sitemapsParsed: 0,
      sitemapsSkippedCrossOrigin: 0,
      sitemapEntriesSeen: 0,
      discoveryComplete: true,
      truncationReason: null,
      requestsMade: 0,
    });
    return { manifest, urls: [], robots: { body: null, httpStatus: null, determinable: false } };
  }

  const seed = new URL(validated.url);
  const scopeOrigin = seed.origin;
  const now = () => new Date().toISOString();
  const markMethod = (method: DiscoveryMethod) => {
    if (!methodsUsed.includes(method)) methodsUsed.push(method);
  };
  const setTruncated = (reason: string) => {
    discoveryComplete = false;
    truncationReason ??= reason;
  };
  const addUrl = (raw: string, method: DiscoveryMethod, discoveredFromUrl: string | null, sitemapSourceUrl: string | null, linkDepth: number | null) => {
    markMethod(method);
    const normalized = normalizeUrl(raw, sitemapSourceUrl ?? scopeOrigin);
    if (!normalized.ok) {
      inventory.add({
        urlRaw: raw,
        urlNormalized: null,
        discoveryMethod: method,
        discoveredFromUrl,
        sitemapSourceUrl,
        linkDepth,
        inScope: false,
        excludedReason: normalized.reason,
        fetchState: 'not_attempted',
        httpStatus: null,
        analyzed: false,
        firstSeenAt: now(),
      });
      return;
    }
    const inScope = new URL(normalized.normalized).origin === scopeOrigin;
    inventory.add({
      urlRaw: raw,
      urlNormalized: normalized.normalized,
      discoveryMethod: method,
      discoveredFromUrl,
      sitemapSourceUrl,
      linkDepth,
      inScope,
      excludedReason: inScope ? null : 'cross_origin',
      fetchState: 'not_attempted',
      httpStatus: null,
      analyzed: false,
      firstSeenAt: now(),
    });
  };

  addUrl(seed.toString(), 'seed', null, null, 0);

  const isScopeOrigin = (url: string): boolean => {
    try {
      return new URL(url, scopeOrigin).origin === scopeOrigin;
    } catch {
      return false;
    }
  };
  const skipCrossOriginSitemap = (url: string): boolean => {
    if (isScopeOrigin(url)) return false;
    sitemapsSkippedCrossOrigin += 1;
    return true;
  };
  const queueSitemap = (url: string, method: DiscoveryMethod, depth: number, discoveredFrom: string | null): void => {
    if (skipCrossOriginSitemap(url)) return;
    queuedSitemaps.push({ url, method, depth, discoveredFrom });
    sitemapsFound += 1;
    discoveryYieldedSitemap = true;
  };
  const fetchWithBudget = async (url: string, requiredOrigin?: string): Promise<FetchOutcome> => {
    return discoveryFetch(url, {
      requiredOrigin,
      canRequest: () => requestsMade < config.maxDiscoveryRequests,
      recordRequest: () => {
        requestsMade += 1;
      },
      onBudgetExceeded: () => {
        setTruncated('max_discovery_requests');
      },
    });
  };
  const fetchSitemapWithBudget = async (url: string): Promise<FetchOutcome> => {
    if (skipCrossOriginSitemap(url)) {
      return { ok: false, status: null, body: null, finalUrl: url, error: 'cross_origin_sitemap' };
    }
    if (requestsMade >= config.maxDiscoveryRequests) {
      setTruncated('max_discovery_requests');
      return { ok: false, status: null, body: null, finalUrl: url, error: 'max_discovery_requests' };
    }
    return fetchWithBudget(url, scopeOrigin);
  };

  const robotsUrl = new URL('/robots.txt', scopeOrigin).toString();
  const robots = await fetchWithBudget(robotsUrl);
  const robotsObservation = observeRobots(robots);
  if (robots.ok && robots.status === 200 && robots.body !== null) {
    for (const directive of extractSitemapDirectives(robots.body)) {
      queueSitemap(directive, 'robots_sitemap', 0, robotsUrl);
      markMethod('robots_sitemap');
    }
  }

  if (queuedSitemaps.length === 0) {
    const sitemapUrl = new URL('/sitemap.xml', scopeOrigin).toString();
    const probe = await fetchSitemapWithBudget(sitemapUrl);
    if (probe.ok && probe.status === 200 && probe.body !== null) {
      sitemapsFound += 1;
      processSitemapBody(probe.body, probe.finalUrl, 'sitemap', 0, null);
    }
  }

  if (!discoveryYieldedSitemap && requestsMade < config.maxDiscoveryRequests) {
    for (const path of ['/wp-sitemap.xml', '/sitemap_index.xml']) {
      const probeUrl = new URL(path, scopeOrigin).toString();
      const probe = await fetchSitemapWithBudget(probeUrl);
      if (probe.ok && probe.status === 200 && probe.body !== null) {
        sitemapsFound += 1;
        processSitemapBody(probe.body, probe.finalUrl, 'wp_convention', 0, null);
        break;
      }
    }
  }

  while (queuedSitemaps.length > 0) {
    const next = queuedSitemaps.shift()!;
    const fetched = await fetchSitemapWithBudget(next.url);
    if (!fetched.ok || fetched.status !== 200 || fetched.body === null) {
      partial = true;
      continue;
    }
    processSitemapBody(fetched.body, fetched.finalUrl, next.method, next.depth, next.discoveredFrom);
  }

  const urls = inventory.list();
  const manifest = buildManifest({
    scanId: input.scanId,
    scanMode,
    domain: seed.hostname,
    seedUrl: seed.toString(),
    startedAt,
    completedAt: new Date().toISOString(),
    status: partial ? 'partial' : 'complete',
    abortReason: null,
    config,
    urls,
    methodsUsed,
    sitemapsFound,
    sitemapsParsed,
    sitemapsSkippedCrossOrigin,
    sitemapEntriesSeen,
    discoveryComplete,
    truncationReason,
    requestsMade,
  });
  return { manifest, urls, robots: robotsObservation };

  function processSitemapBody(body: string, sourceUrl: string, method: DiscoveryMethod, depth: number, discoveredFrom: string | null): void {
    const parsed = parseSitemap(body, sourceUrl, config.maxLocEntries);
    if (!parsed.ok) {
      partial = true;
      return;
    }
    sitemapsParsed += 1;
    discoveryYieldedSitemap = true;
    sitemapEntriesSeen += parsed.locs.length;
    if (parsed.truncated) setTruncated('max_loc_entries');
    if (parsed.kind === 'index') {
      markMethod('sitemap_index');
      for (const loc of parsed.locs) {
        if (childSitemapsQueued >= config.maxChildSitemaps) {
          setTruncated('max_child_sitemaps');
          break;
        }
        if (depth + 1 > config.maxSitemapDepth) {
          setTruncated('max_sitemap_depth');
          break;
        }
        const before = sitemapsFound;
        queueSitemap(loc, 'sitemap_index', depth + 1, sourceUrl);
        if (sitemapsFound > before) childSitemapsQueued += 1;
      }
      return;
    }
    for (const loc of parsed.locs) {
      addUrl(loc, method === 'robots_sitemap' ? 'sitemap' : method, discoveredFrom, sourceUrl, null);
    }
  }
}

function observeRobots(outcome: FetchOutcome): DiscoveryResult['robots'] {
  return {
    body: outcome.body,
    httpStatus: outcome.status,
    determinable: outcome.status === 404 || (outcome.ok && outcome.status === 200 && outcome.body !== null && !looksHtml(outcome.body)),
  };
}

function looksHtml(value: string): boolean {
  return /<!doctype html|<html[\s>]/i.test(value);
}

function clampConfig(config: Partial<DiscoveryConfig> | undefined): DiscoveryConfig {
  return {
    maxChildSitemaps: Math.min(config?.maxChildSitemaps ?? MAX_CHILD_SITEMAPS, MAX_CHILD_SITEMAPS),
    maxSitemapDepth: Math.min(config?.maxSitemapDepth ?? MAX_SITEMAP_DEPTH, MAX_SITEMAP_DEPTH),
    maxLocEntries: Math.min(config?.maxLocEntries ?? MAX_LOC_ENTRIES, MAX_LOC_ENTRIES),
    maxDiscoveryRequests: Math.min(config?.maxDiscoveryRequests ?? MAX_DISCOVERY_REQUESTS, MAX_DISCOVERY_REQUESTS),
  };
}

async function discoveryFetch(url: string, options: {
  requiredOrigin?: string;
  canRequest: () => boolean;
  recordRequest: () => void;
  onBudgetExceeded: () => void;
}): Promise<FetchOutcome> {
  let nextUrl = url;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    let validated = await validateUrl(nextUrl);
    if (!validated.ok) {
      return { ok: false, status: null, body: null, finalUrl: nextUrl, error: validated.reason };
    }
    if (options.requiredOrigin && new URL(validated.url).origin !== options.requiredOrigin) {
      return { ok: false, status: null, body: null, finalUrl: validated.url, error: 'cross_origin_sitemap' };
    }
    if (!options.canRequest()) {
      options.onBudgetExceeded();
      return { ok: false, status: null, body: null, finalUrl: validated.url, error: 'max_discovery_requests' };
    }
    options.recordRequest();
    try {
      const response = await fetch(validated.url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'user-agent': USER_AGENT },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) return { ok: false, status: response.status, body: null, finalUrl: validated.url, error: 'redirect_without_location' };
        nextUrl = new URL(location, validated.url).toString();
        validated = await validateUrl(nextUrl);
        if (!validated.ok) {
          return { ok: false, status: response.status, body: null, finalUrl: nextUrl, error: validated.reason };
        }
        if (options.requiredOrigin && new URL(validated.url).origin !== options.requiredOrigin) {
          return { ok: false, status: response.status, body: null, finalUrl: validated.url, error: 'cross_origin_sitemap' };
        }
        continue;
      }
      const body = await readCappedBody(response);
      if (!body.ok) {
        return { ok: false, status: response.status, body: null, finalUrl: validated.url, error: body.error };
      }
      return { ok: true, status: response.status, body: body.body, finalUrl: validated.url };
    } catch (error) {
      return { ok: false, status: null, body: null, finalUrl: nextUrl, error: error instanceof Error ? error.message : 'fetch_failed' };
    }
  }
  return { ok: false, status: null, body: null, finalUrl: nextUrl, error: 'max_redirects' };
}

async function readCappedBody(response: Response): Promise<BodyOutcome> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).length > MAX_SITEMAP_BYTES) return { ok: false, error: 'oversize' };
    return { ok: true, body: text };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_SITEMAP_BYTES) {
      await reader.cancel();
      return { ok: false, error: 'oversize' };
    }
    chunks.push(value);
  }
  return { ok: true, body: new TextDecoder().decode(concat(chunks, total)) };
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
