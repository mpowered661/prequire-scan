import type { RawCrawlerFetch, HttpTesterOptions } from './types';
import { getActiveCrawlers, BROWSER_UA, PREQUIRE_SUFFIX } from './crawlers';

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 10000;
const RATE_LIMITED_DOMAINS = new Set<string>();

function getDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

async function fetchWithUA(
  url: string,
  ua: string,
  crawlerName: string,
): Promise<RawCrawlerFetch> {
  const domain = getDomain(url);

  if (RATE_LIMITED_DOMAINS.has(domain)) {
    return {
      crawler_name: crawlerName,
      user_agent: ua,
      status_code: 429,
      response_time_ms: 0,
      headers: {},
      body: '',
      error: 'Aborted: domain returned 429 for a prior request',
    };
  }

  const start = Date.now();

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': ua },
      redirect: 'follow',
      // AbortSignal.timeout is available in Node 18+ and modern browsers
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const response_time_ms = Date.now() - start;

    if (response.status === 429) {
      RATE_LIMITED_DOMAINS.add(domain);
    }

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    const body = await response.text();

    return {
      crawler_name: crawlerName,
      user_agent: ua,
      status_code: response.status,
      response_time_ms,
      headers,
      body,
      error: null,
    };
  } catch (err: unknown) {
    const response_time_ms = Date.now() - start;
    const isTimeout =
      err instanceof Error && err.name === 'TimeoutError';

    return {
      crawler_name: crawlerName,
      user_agent: ua,
      status_code: 0,
      response_time_ms,
      headers: {},
      body: '',
      error: isTimeout ? 'Request timed out after 10s' : String(err),
    };
  }
}

export async function runHttpTests(
  url: string,
  options: HttpTesterOptions = {},
): Promise<{ crawler_fetches: RawCrawlerFetch[]; browser_fetch: RawCrawlerFetch }> {
  const { include_seo_bots = false } = options;
  const crawlers = getActiveCrawlers(include_seo_bots);

  // Append Prequire identification suffix to every bot UA
  const crawlerFetchPromises = crawlers.map((c) =>
    fetchWithUA(url, c.user_agent + PREQUIRE_SUFFIX, c.name),
  );

  // Browser fetch for cloaking comparison — no Prequire suffix to get the most realistic response
  const browserFetchPromise = fetchWithUA(url, BROWSER_UA, '__browser__');

  // Run all requests in parallel; browser fetch races alongside the bots
  const allResults = await Promise.allSettled([
    ...crawlerFetchPromises,
    browserFetchPromise,
  ]);

  const crawler_fetches: RawCrawlerFetch[] = [];
  let browser_fetch: RawCrawlerFetch = {
    crawler_name: '__browser__',
    user_agent: BROWSER_UA,
    status_code: 0,
    response_time_ms: 0,
    headers: {},
    body: '',
    error: 'Browser fetch did not complete',
  };

  allResults.forEach((result, idx) => {
    if (result.status === 'fulfilled') {
      if (idx < crawlers.length) {
        crawler_fetches.push(result.value);
      } else {
        browser_fetch = result.value;
      }
    } else {
      const name = idx < crawlers.length ? crawlers[idx].name : '__browser__';
      const ua =
        idx < crawlers.length
          ? crawlers[idx].user_agent + PREQUIRE_SUFFIX
          : BROWSER_UA;
      const payload: RawCrawlerFetch = {
        crawler_name: name,
        user_agent: ua,
        status_code: 0,
        response_time_ms: 0,
        headers: {},
        body: '',
        error: String(result.reason),
      };
      if (idx < crawlers.length) {
        crawler_fetches.push(payload);
      } else {
        browser_fetch = payload;
      }
    }
  });

  return { crawler_fetches, browser_fetch };
}
