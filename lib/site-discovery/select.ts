import type { InventoryUrl } from './inventory';
import { evaluateExclusion } from './exclusions';
import { matchRole } from './role-patterns';
import { DEFAULT_PAGE_BUDGET, HARD_MAX_SELECTED_PAGES, SELECTOR_VERSION, TIER1_NAV_LIMIT, TIER2_ROLE_LIMIT } from './versions';

export { SELECTOR_VERSION };

export interface SelectionDecision {
  urlNormalized: string;
  reason: string;
  rank: number;
}

export interface SelectionOutcome {
  version: typeof SELECTOR_VERSION;
  decisions: SelectionDecision[];
  budget: number;
}

export function selectUrls(
  urls: InventoryUrl[],
  opts: { scopeOrigin: string; budget: number; navUrls?: string[] },
): SelectionOutcome {
  const budget = Math.max(0, Math.min(opts.budget ?? DEFAULT_PAGE_BUDGET, HARD_MAX_SELECTED_PAGES));
  const selected = new Map<string, string>();
  const candidates = urls.filter(row => selectable(row, opts.scopeOrigin)).sort(compareRows);
  const add = (url: string, reason: string): void => {
    if (selected.size >= budget || selected.has(url)) return;
    selected.set(url, reason);
  };

  for (const row of candidates.filter(row => row.discoveryMethod === 'seed')) add(row.urlNormalized!, 'seed');

  let navAdded = 0;
  for (const navUrl of [...(opts.navUrls ?? [])].sort()) {
    if (navAdded >= TIER1_NAV_LIMIT) break;
    const normalized = normalizeSameOrigin(navUrl, opts.scopeOrigin);
    if (normalized && selectableUrl(normalized, opts.scopeOrigin) && candidates.some(row => row.urlNormalized === normalized)) {
      const before = selected.size;
      add(normalized, 'nav_footer');
      if (selected.size > before) navAdded += 1;
    }
  }

  const roles = new Set<string>();
  let roleTotal = 0;
  for (const row of candidates) {
    if (roleTotal >= TIER2_ROLE_LIMIT) break;
    if (row.urlNormalized === null || selected.has(row.urlNormalized)) continue;
    const role = matchRole(row.urlNormalized);
    if (!role || roles.has(role)) continue;
    roles.add(role);
    roleTotal += 1;
    add(row.urlNormalized, `role:${role}`);
  }

  const remaining = budget - selected.size;
  if (remaining > 0) {
    const breadth = candidates.filter(row => row.urlNormalized !== null && !selected.has(row.urlNormalized));
    const step = Math.max(1, Math.floor(breadth.length / remaining));
    for (let i = 0; i < breadth.length && selected.size < budget; i += step) {
      add(breadth[i].urlNormalized!, 'sitemap_sample');
    }
  }

  return {
    version: SELECTOR_VERSION,
    budget,
    decisions: [...selected.entries()].map(([urlNormalized, reason], index) => ({
      urlNormalized,
      reason,
      rank: index + 1,
    })),
  };
}

function selectable(row: InventoryUrl, scopeOrigin: string): boolean {
  return row.urlNormalized !== null && row.inScope && row.excludedReason === null && selectableUrl(row.urlNormalized, scopeOrigin);
}

function selectableUrl(url: string, scopeOrigin: string): boolean {
  try {
    return new URL(url).origin === scopeOrigin && !evaluateExclusion(url).excluded;
  } catch {
    return false;
  }
}

function normalizeSameOrigin(url: string, scopeOrigin: string): string | null {
  try {
    return new URL(url, scopeOrigin).toString();
  } catch {
    return null;
  }
}

function compareRows(a: InventoryUrl, b: InventoryUrl): number {
  return (a.urlNormalized ?? '').localeCompare(b.urlNormalized ?? '');
}
