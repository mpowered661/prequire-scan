import { analyzeContentDelivery, analyzeMetaTags } from '../aeo-readiness/content-analyzer';
import { REGISTRY_VERSION } from '../aeo-readiness/crawlers';
import { buildExtractionResilience, EXTRACTION_RESILIENCE_VERSION } from '../extraction-resilience';
import { extractJsonLd, SCAN_PROMPT_VERSION } from '../scanPrompt';
import { hasProjector } from './evidence-projection';
import type { FetchedPageArtifact, PageEngineName } from './types';

export const PAGE_ENGINE_SET_VERSION = 'page-engines-0.1';
export const REQUIRED_PAGE_ENGINE_NAMES = Object.freeze([
  'extraction_resilience',
  'structured_data',
  'content_delivery',
  'meta_tags',
] satisfies PageEngineName[]);

export interface PageEngine {
  name: PageEngineName;
  engineVersion: string;
  scope: 'page' | 'site' | 'link_target';
  networkRequests: 0;
  run: (artifact: FetchedPageArtifact) => unknown;
}

export const PAGE_ENGINES = Object.freeze([
  Object.freeze({
    name: 'extraction_resilience',
    engineVersion: EXTRACTION_RESILIENCE_VERSION,
    scope: 'page',
    networkRequests: 0,
    run: (artifact: FetchedPageArtifact) => buildExtractionResilience(artifact.finalUrl, artifact.html),
  }),
  Object.freeze({
    name: 'structured_data',
    engineVersion: SCAN_PROMPT_VERSION,
    scope: 'page',
    networkRequests: 0,
    run: (artifact: FetchedPageArtifact) => extractJsonLd(artifact.html),
  }),
  Object.freeze({
    name: 'content_delivery',
    engineVersion: REGISTRY_VERSION,
    scope: 'page',
    networkRequests: 0,
    run: (artifact: FetchedPageArtifact) => analyzeContentDelivery(artifact.html),
  }),
  Object.freeze({
    name: 'meta_tags',
    engineVersion: REGISTRY_VERSION,
    scope: 'page',
    networkRequests: 0,
    run: (artifact: FetchedPageArtifact) => analyzeMetaTags(artifact.html, 'GPTBot'),
  }),
] satisfies PageEngine[]);

export function assertPageEngine(engine: Pick<PageEngine, 'name' | 'scope' | 'networkRequests'>): void {
  if (!hasProjector(engine.name)) throw new Error('no_registered_projector');
  if (engine.scope !== 'page') throw new Error('non_page_engine_in_page_loop');
  if (engine.networkRequests !== 0) throw new Error('page_engine_network_requests_forbidden');
}

export function engineIndex(name: PageEngineName): number {
  const index = PAGE_ENGINES.findIndex(engine => engine.name === name);
  if (index < 0) throw new Error('unknown_page_engine');
  return index;
}
