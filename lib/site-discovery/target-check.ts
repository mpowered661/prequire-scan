import { validateUrl } from './egress-policy';
import type { BudgetTracker } from './fetcher';
import { evaluateRobots } from './robots-rules';
import type { TargetObservation } from './types';
import {
  MAX_PAGE_BYTES,
  MAX_REDIRECTS,
  MAX_RETRIES,
  PAGE_FETCH_TIMEOUT_MS,
  TARGET_CHECK_VERSION,
} from './versions';
import type { LinkTargetCandidate } from './link-targets';
import { unchecked } from './link-targets';

export { TARGET_CHECK_VERSION };

const USER_AGENT = 'Prequire-SiteDiscovery/0.1 (+https://prequire.ai)';

export interface TargetCheckStats {
  headRequests: number;
  getFallbacks: number;
  redirectHops: number;
  retriesUsed: number;
  targetCheckRequestsMade: number;
  stopReason: null | 'complete' | 'total_request_ceiling' | 'rate_limited';
}

export async function checkTargets(
  targets: LinkTargetCandidate[],
  opts: {
    scopeOrigin: string;
    robotsTxt: string | null;
    budgetTracker: BudgetTracker;
  },
): Promise<{ observations: TargetObservation[]; stats: TargetCheckStats }> {
  const stats: TargetCheckStats = {
    headRequests: 0,
    getFallbacks: 0,
    redirectHops: 0,
    retriesUsed: 0,
    targetCheckRequestsMade: 0,
    stopReason: null,
  };
  const observations: TargetObservation[] = [];
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    const robots = evaluateRobots(opts.robotsTxt, new URL(target.targetUrlNormalized).pathname, USER_AGENT);
    if (!robots.allowed) {
      observations.push(unchecked(target, 'robots_disallowed'));
      continue;
    }
    const checked = await checkOne(target, opts.scopeOrigin, opts.budgetTracker, stats);
    observations.push(checked.observation);
    if (checked.stopReason) {
      stats.stopReason = checked.stopReason;
      const reason = checked.stopReason === 'rate_limited' ? 'host_rate_limited' : 'global_budget_exhausted';
      observations.push(...targets.slice(index + 1).map(candidate => unchecked(candidate, reason)));
      break;
    }
  }
  stats.stopReason ??= 'complete';
  return { observations, stats };
}

async function checkOne(
  target: LinkTargetCandidate,
  scopeOrigin: string,
  budget: BudgetTracker,
  stats: TargetCheckStats,
): Promise<{ observation: TargetObservation; stopReason: null | 'total_request_ceiling' | 'rate_limited' }> {
  let attempt = 0;
  for (;;) {
    const outcome = await requestChain(target, target.targetUrlNormalized, 'HEAD', scopeOrigin, budget, stats);
    if (outcome.kind === 'global_budget') return { observation: unchecked(target, 'global_budget_exhausted'), stopReason: 'total_request_ceiling' };
    if (outcome.observation.classification === 'blocked' && outcome.observation.uncheckedReason === 'rate_limited') {
      return { observation: outcome.observation, stopReason: 'rate_limited' };
    }
    if ((outcome.observation.classification === 'timeout' || outcome.observation.classification === 'server_failure_5xx') && attempt < MAX_RETRIES) {
      attempt += 1;
      stats.retriesUsed += 1;
      continue;
    }
    if (outcome.observation.httpStatus === 405 || outcome.observation.httpStatus === 501) {
      const fallback = await requestChain(target, target.targetUrlNormalized, 'GET', scopeOrigin, budget, stats);
      if (fallback.kind === 'global_budget') return { observation: unchecked(target, 'global_budget_exhausted'), stopReason: 'total_request_ceiling' };
      return { observation: fallback.observation, stopReason: fallback.observation.uncheckedReason === 'rate_limited' ? 'rate_limited' : null };
    }
    return { observation: outcome.observation, stopReason: null };
  }
}

async function requestChain(
  target: LinkTargetCandidate,
  startUrl: string,
  method: 'HEAD' | 'GET',
  scopeOrigin: string,
  budget: BudgetTracker,
  stats: TargetCheckStats,
): Promise<{ kind: 'ok'; observation: TargetObservation } | { kind: 'global_budget' }> {
  let nextUrl = startUrl;
  let redirectHops = 0;
  const started = Date.now();
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const validated = await validateUrl(nextUrl);
    if (!validated.ok) {
      return { kind: 'ok', observation: checked(target, {
        classification: 'blocked',
        uncheckedReason: validated.reason,
        httpStatus: null,
        redirectTargetUrl: nextUrl,
        redirectLeftOrigin: null,
        redirectHops,
        methodUsed: method,
        responseMs: Date.now() - started,
      }) };
    }
    if (new URL(validated.url).origin !== scopeOrigin) {
      return { kind: 'ok', observation: checked(target, {
        classification: 'redirected',
        uncheckedReason: null,
        httpStatus: null,
        redirectTargetUrl: validated.url,
        redirectLeftOrigin: true,
        redirectHops,
        methodUsed: method,
        responseMs: Date.now() - started,
      }) };
    }
    if (!budget.tryConsume()) return { kind: 'global_budget' };
    stats.targetCheckRequestsMade += 1;
    if (method === 'HEAD') stats.headRequests += 1;
    if (method === 'GET') stats.getFallbacks += 1;
    try {
      const response = await fetch(validated.url, {
        method,
        redirect: 'manual',
        signal: AbortSignal.timeout(PAGE_FETCH_TIMEOUT_MS),
        headers: { 'user-agent': USER_AGENT },
      });
      if (method === 'GET') await discardCappedBody(response);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) return { kind: 'ok', observation: classify(target, response.status, method, redirectHops, Date.now() - started, null) };
        const redirectUrl = new URL(location, validated.url).toString();
        const redirectValidated = await validateUrl(redirectUrl);
        redirectHops += 1;
        stats.redirectHops += 1;
        if (!redirectValidated.ok) {
          return { kind: 'ok', observation: checked(target, {
            classification: 'blocked',
            uncheckedReason: 'egress_rejected',
            httpStatus: response.status,
            redirectTargetUrl: redirectUrl,
            redirectLeftOrigin: null,
            redirectHops,
            methodUsed: method,
            responseMs: Date.now() - started,
          }) };
        }
        if (new URL(redirectValidated.url).origin !== scopeOrigin) {
          return { kind: 'ok', observation: checked(target, {
            classification: 'redirected',
            uncheckedReason: null,
            httpStatus: response.status,
            redirectTargetUrl: redirectValidated.url,
            redirectLeftOrigin: true,
            redirectHops,
            methodUsed: method,
            responseMs: Date.now() - started,
          }) };
        }
        nextUrl = redirectValidated.url;
        continue;
      }
      return { kind: 'ok', observation: classify(target, response.status, method, redirectHops, Date.now() - started, validated.url) };
    } catch {
      return { kind: 'ok', observation: checked(target, {
        classification: 'timeout',
        uncheckedReason: null,
        httpStatus: null,
        redirectTargetUrl: null,
        redirectLeftOrigin: null,
        redirectHops,
        methodUsed: method,
        responseMs: Date.now() - started,
      }) };
    }
  }
  return { kind: 'ok', observation: checked(target, {
    classification: 'undeterminable',
    uncheckedReason: null,
    httpStatus: null,
    redirectTargetUrl: nextUrl,
    redirectLeftOrigin: false,
    redirectHops,
    methodUsed: method,
    responseMs: Date.now() - started,
  }) };
}

function classify(target: LinkTargetCandidate, status: number, method: 'HEAD' | 'GET', redirectHops: number, responseMs: number, finalUrl: string | null): TargetObservation {
  if (status === 429) {
    return checked(target, { classification: 'blocked', uncheckedReason: 'rate_limited', httpStatus: status, redirectTargetUrl: null, redirectLeftOrigin: null, redirectHops, methodUsed: method, responseMs });
  }
  if (status >= 200 && status < 300) {
    return checked(target, { classification: redirectHops > 0 ? 'redirected' : 'healthy', uncheckedReason: null, httpStatus: status, redirectTargetUrl: redirectHops > 0 ? finalUrl : null, redirectLeftOrigin: false, redirectHops, methodUsed: method, responseMs });
  }
  if (status === 405 || status === 501) {
    return checked(target, { classification: 'undeterminable', uncheckedReason: null, httpStatus: status, redirectTargetUrl: null, redirectLeftOrigin: null, redirectHops, methodUsed: method, responseMs });
  }
  if (status >= 400 && status < 500) {
    return checked(target, { classification: 'broken_4xx', uncheckedReason: null, httpStatus: status, redirectTargetUrl: null, redirectLeftOrigin: null, redirectHops, methodUsed: method, responseMs });
  }
  if (status >= 500) {
    return checked(target, { classification: 'server_failure_5xx', uncheckedReason: null, httpStatus: status, redirectTargetUrl: null, redirectLeftOrigin: null, redirectHops, methodUsed: method, responseMs });
  }
  return checked(target, { classification: 'undeterminable', uncheckedReason: null, httpStatus: status, redirectTargetUrl: null, redirectLeftOrigin: null, redirectHops, methodUsed: method, responseMs });
}

function checked(
  target: LinkTargetCandidate,
  values: Pick<TargetObservation, 'classification' | 'httpStatus' | 'redirectTargetUrl' | 'redirectLeftOrigin' | 'redirectHops' | 'methodUsed' | 'responseMs'> & { uncheckedReason: string | null },
): TargetObservation {
  return {
    targetUrlNormalized: target.targetUrlNormalized,
    checkState: 'checked',
    uncheckedReason: values.uncheckedReason,
    classification: values.classification,
    httpStatus: values.httpStatus,
    redirectTargetUrl: values.redirectTargetUrl,
    redirectLeftOrigin: values.redirectLeftOrigin,
    redirectHops: values.redirectHops,
    methodUsed: values.methodUsed,
    responseMs: values.responseMs,
    sourceLinkCount: target.sourceLinkCount,
    checkedAt: new Date().toISOString(),
  };
}

async function discardCappedBody(response: Response): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    await response.text();
    return;
  }
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    total += value?.byteLength ?? 0;
    if (total > MAX_PAGE_BYTES) {
      await reader.cancel();
      return;
    }
  }
}
