import { createHash } from 'node:crypto';
import { validateUrl } from './egress-policy';
import { updateFetchState, type InventoryUrl } from './inventory';
import { evaluateRobots, getCrawlDelayMs } from './robots-rules';
import type { FetchConfig } from './types';
import {
  FETCHER_VERSION,
  HARD_MAX_PAGE_FETCHES,
  HARD_MAX_TOTAL_REQUESTS,
  MAX_CRAWL_DELAY_MS,
  MAX_PAGE_BYTES,
  MAX_REDIRECTS,
  MAX_RETRIES,
  PAGE_FETCH_TIMEOUT_MS,
} from './versions';

export { FETCHER_VERSION };

export class BudgetTracker {
  totalRequestsMade = 0;
  readonly maxTotalRequests: number;

  constructor(maxTotalRequests?: number, initialRequests = 0) {
    this.maxTotalRequests = Math.min(maxTotalRequests ?? HARD_MAX_TOTAL_REQUESTS, HARD_MAX_TOTAL_REQUESTS);
    this.totalRequestsMade = initialRequests;
  }

  tryConsume(): boolean {
    if (this.totalRequestsMade >= this.maxTotalRequests) return false;
    this.totalRequestsMade += 1;
    return true;
  }
}

export interface FetchOutcomeSummary {
  attempted: number;
  fetched: number;
  redirected_not_followed: number;
  skipped_robots: number;
  skipped_excluded: number;
  skipped_not_selected: number;
  blocked: number;
  failed: number;
  retries_used: number;
  page_requests_made: number;
  total_requests_made: number;
  robots_determinable: boolean;
  stop_reason: null | 'complete' | 'page_budget' | 'page_fetch_ceiling'
    | 'total_request_ceiling' | 'rate_limited'
    | 'robots_undeterminable' | 'crawl_delay_too_large';
}

const USER_AGENT = 'Prequire-SiteDiscovery/0.1 (+https://prequire.ai)';

export async function fetchSelected(
  rows: InventoryUrl[],
  opts: {
    scopeOrigin: string;
    robotsTxt: string | null;
    robotsDeterminable: boolean;
    config: FetchConfig;
    budgetTracker: BudgetTracker;
    onHtml?: (sourceUrl: string, html: string) => void;
  },
): Promise<FetchOutcomeSummary> {
  let pageRequests = 0;
  let retriesUsed = 0;
  let stopReason: FetchOutcomeSummary['stop_reason'] = null;
  const selectedRows = rows.filter(row => row.selected === true);
  const crawlDelay = getCrawlDelayMs(opts.robotsTxt, USER_AGENT);
  if (!opts.robotsDeterminable) {
    for (const row of selectedRows) updateFetchState(row, { fetchState: 'skipped', skipReason: 'robots_undeterminable', lastCheckedAt: now() });
    return summary(rows, opts.budgetTracker, pageRequests, retriesUsed, false, 'robots_undeterminable');
  }
  if (crawlDelay !== null && crawlDelay > MAX_CRAWL_DELAY_MS) {
    for (const row of selectedRows) updateFetchState(row, { fetchState: 'skipped', skipReason: 'crawl_delay_too_large', lastCheckedAt: now() });
    return summary(rows, opts.budgetTracker, pageRequests, retriesUsed, true, 'crawl_delay_too_large');
  }
  let hostStopped = false;

  for (const row of selectedRows) {
    if (hostStopped) {
      if (row.fetchState === 'not_attempted') {
        updateFetchState(row, { fetchState: 'skipped', skipReason: 'host_rate_limited', lastCheckedAt: now() });
      }
      continue;
    }
    if (!canAttempt(row, opts.scopeOrigin)) continue;
    const robots = evaluateRobots(opts.robotsTxt, new URL(row.urlNormalized!).pathname, USER_AGENT);
    if (!robots.determinable) {
      updateFetchState(row, { fetchState: 'skipped', skipReason: 'robots_undeterminable', lastCheckedAt: now() });
      stopReason = 'robots_undeterminable';
      break;
    }
    if (!robots.allowed) {
      updateFetchState(row, { fetchState: 'skipped', skipReason: 'robots_disallowed', lastCheckedAt: now() });
      continue;
    }
    if (pageRequests >= HARD_MAX_PAGE_FETCHES) {
      updateFetchState(row, { fetchState: 'skipped', skipReason: 'page_fetch_ceiling', lastCheckedAt: now() });
      stopReason = 'page_fetch_ceiling';
      break;
    }
    const outcome = await fetchOne(row.urlNormalized!, opts.scopeOrigin, opts.budgetTracker, () => pageRequests++, () => retriesUsed++, opts.onHtml);
    applyOutcome(row, outcome);
    if (outcome.reason === 'total_request_ceiling') {
      stopReason = 'total_request_ceiling';
      break;
    }
    if (outcome.reason === 'rate_limited') {
      hostStopped = true;
      stopReason = 'rate_limited';
      for (const remaining of selectedRows) {
        if (remaining.fetchState === 'not_attempted') {
          updateFetchState(remaining, { fetchState: 'skipped', skipReason: 'host_rate_limited', lastCheckedAt: now() });
        }
      }
      break;
    }
    if (outcome.reason === 'page_fetch_ceiling') {
      stopReason = 'page_fetch_ceiling';
      break;
    }
  }

  return summary(rows, opts.budgetTracker, pageRequests, retriesUsed, true, stopReason ?? 'complete');
}

type FetchOneOutcome = {
  state: InventoryUrl['fetchState'];
  reason: string | null;
  status: number | null;
  redirectTargetUrl?: string | null;
  contentSha256?: string | null;
  contentLength?: number | null;
  responseMs?: number | null;
};

async function fetchOne(
  startUrl: string,
  scopeOrigin: string,
  budget: BudgetTracker,
  recordPageRequest: () => void,
  recordRetry: () => void,
  onHtml?: (sourceUrl: string, html: string) => void,
): Promise<FetchOneOutcome> {
  let attempt = 0;
  for (;;) {
    const outcome = await fetchAttempt(startUrl, scopeOrigin, budget, recordPageRequest, onHtml);
    if ((outcome.reason === 'timeout' || outcome.reason === 'http_5xx') && attempt < MAX_RETRIES) {
      attempt += 1;
      recordRetry();
      continue;
    }
    return outcome;
  }
}

async function fetchAttempt(
  url: string,
  scopeOrigin: string,
  budget: BudgetTracker,
  recordPageRequest: () => void,
  onHtml?: (sourceUrl: string, html: string) => void,
): Promise<FetchOneOutcome> {
  let nextUrl = url;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const validated = await validateUrl(nextUrl);
    if (!validated.ok) return { state: 'blocked', reason: 'egress_rejected', status: null };
    if (new URL(validated.url).origin !== scopeOrigin) return { state: 'blocked', reason: 'off_origin', status: null };
    if (!budget.tryConsume()) return { state: 'skipped', reason: 'total_request_ceiling', status: null };
    recordPageRequest();
    const started = Date.now();
    try {
      const response = await fetch(validated.url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(PAGE_FETCH_TIMEOUT_MS),
        headers: { 'user-agent': USER_AGENT },
      });
      const responseMs = Date.now() - started;
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) return { state: 'redirected', reason: 'redirect_without_location', status: response.status, responseMs };
        const redirectUrl = new URL(location, validated.url).toString();
        const redirectValidated = await validateUrl(redirectUrl);
        if (!redirectValidated.ok) return { state: 'blocked', reason: 'egress_rejected', status: response.status, redirectTargetUrl: redirectUrl, responseMs };
        if (new URL(redirectValidated.url).origin !== scopeOrigin) return { state: 'redirected', reason: 'off_origin_redirect', status: response.status, redirectTargetUrl: redirectValidated.url, responseMs };
        nextUrl = redirectValidated.url;
        continue;
      }
      if (response.status === 429) return { state: 'blocked', reason: 'rate_limited', status: response.status, responseMs };
      if (response.status >= 400 && response.status < 500) return { state: 'failed', reason: 'http_4xx', status: response.status, responseMs };
      if (response.status >= 500) return { state: 'failed', reason: 'http_5xx', status: response.status, responseMs };
      const body = await readCappedBody(response);
      if (!body.ok) return { state: 'failed', reason: 'oversize', status: response.status, responseMs };
      if (onHtml) onHtml(validated.url, new TextDecoder().decode(body.bytes));
      return {
        state: 'fetched',
        reason: null,
        status: response.status,
        responseMs,
        contentLength: body.bytes.length,
        contentSha256: createHash('sha256').update(body.bytes).digest('hex'),
      };
    } catch {
      return { state: 'failed', reason: 'timeout', status: null, responseMs: Date.now() - started };
    }
  }
  return { state: 'failed', reason: 'max_redirects', status: null };
}

function applyOutcome(row: InventoryUrl, outcome: FetchOneOutcome): void {
  updateFetchState(row, {
    fetchState: outcome.state,
    httpStatus: outcome.status,
    skipReason: outcome.reason,
    redirectTargetUrl: outcome.redirectTargetUrl ?? null,
    contentSha256: outcome.contentSha256 ?? null,
    contentLength: outcome.contentLength ?? null,
    responseMs: outcome.responseMs ?? null,
    lastCheckedAt: now(),
  });
}

async function readCappedBody(response: Response): Promise<{ ok: true; bytes: Uint8Array } | { ok: false }> {
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new TextEncoder().encode(await response.text());
    return bytes.length > MAX_PAGE_BYTES ? { ok: false } : { ok: true, bytes };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_PAGE_BYTES) {
      await reader.cancel();
      return { ok: false };
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes: out };
}

function canAttempt(row: InventoryUrl, scopeOrigin: string): boolean {
  return row.selected === true && row.inScope && row.excludedReason === null && row.urlNormalized !== null;
}

function summary(
  rows: InventoryUrl[],
  budget: BudgetTracker,
  pageRequests: number,
  retriesUsed: number,
  robotsDeterminable: boolean,
  stopReason: FetchOutcomeSummary['stop_reason'],
): FetchOutcomeSummary {
  return {
    attempted: rows.filter(row => ['fetched', 'redirected', 'blocked', 'failed'].includes(row.fetchState)).length,
    fetched: rows.filter(row => row.fetchState === 'fetched').length,
    redirected_not_followed: rows.filter(row => row.fetchState === 'redirected').length,
    skipped_robots: rows.filter(row => row.skipReason === 'robots_disallowed' || row.skipReason === 'robots_undeterminable').length,
    skipped_excluded: rows.filter(row => row.excludedReason !== null && row.fetchState === 'skipped').length,
    skipped_not_selected: rows.filter(row => row.selected !== true && row.fetchState === 'skipped').length,
    blocked: rows.filter(row => row.fetchState === 'blocked').length,
    failed: rows.filter(row => row.fetchState === 'failed').length,
    retries_used: retriesUsed,
    page_requests_made: pageRequests,
    total_requests_made: budget.totalRequestsMade,
    robots_determinable: robotsDeterminable,
    stop_reason: stopReason,
  };
}

function now(): string {
  return new Date().toISOString();
}
