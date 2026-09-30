import { describe, expect, it } from 'vitest';
import { assertPageEngine, PAGE_ENGINES, PAGE_ENGINE_SET_VERSION, type PageEngine } from './page-engines';

describe('page engine registry', () => {
  it('1 lists the frozen zero-network page engines in contract order', () => {
    expect(PAGE_ENGINE_SET_VERSION).toBe('page-engines-0.1');
    expect(PAGE_ENGINES.map(engine => engine.name)).toEqual([
      'extraction_resilience',
      'structured_data',
      'content_delivery',
      'meta_tags',
    ]);
    expect(PAGE_ENGINES.every(engine => engine.scope === 'page' && engine.networkRequests === 0)).toBe(true);
    expect(Object.isFrozen(PAGE_ENGINES)).toBe(true);
  });

  it('2 reads engine versions from the source exports', () => {
    expect(PAGE_ENGINES.map(engine => [engine.name, engine.engineVersion])).toEqual([
      ['extraction_resilience', '2026-08-inc2'],
      ['structured_data', '2026-08'],
      ['content_delivery', '2026-08'],
      ['meta_tags', '2026-08'],
    ]);
  });

  it('3 refuses a site-scope engine in the page loop', () => {
    const engine = { name: 'meta_tags', scope: 'site', networkRequests: 0 } as Pick<PageEngine, 'name' | 'scope' | 'networkRequests'>;
    expect(() => assertPageEngine(engine)).toThrow('non_page_engine_in_page_loop');
  });

  it('4 refuses a page engine that declares network requests', () => {
    expect(() => assertPageEngine({ name: 'meta_tags', scope: 'page', networkRequests: 1 as 0 })).toThrow('page_engine_network_requests_forbidden');
  });
});
