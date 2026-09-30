import { describe, expect, it } from 'vitest';
import { selectTargets } from './link-targets';
import type { ExtractedLink } from './types';

describe('link targets', () => {
  it('deduplicates checks while preserving source relationships outside the target list', () => {
    const links = [
      link('https://example.com/1', '/about', 'https://example.com/about', 'body'),
      link('https://example.com/2', '/about#x', 'https://example.com/about', 'nav'),
      link('https://example.com/3', '/about?utm_source=x', 'https://example.com/about', 'footer'),
    ];
    const selected = selectTargets(links, 40);
    expect(links).toHaveLength(3);
    expect(selected.candidates).toHaveLength(1);
    expect(selected.candidates[0].sourceLinkCount).toBe(3);
  });

  it('selects deterministically by source count, placement, then target URL', () => {
    const links = [
      link('https://example.com/', '/c', 'https://example.com/c', 'body'),
      link('https://example.com/', '/b', 'https://example.com/b', 'nav'),
      link('https://example.com/2', '/a', 'https://example.com/a', 'body'),
      link('https://example.com/3', '/a', 'https://example.com/a', 'body'),
      link('https://example.com/', '/d', 'https://example.com/d', 'footer'),
    ];
    const first = selectTargets(links, 3).selected.map(target => target.targetUrlNormalized);
    const second = selectTargets([...links].reverse(), 3).selected.map(target => target.targetUrlNormalized);
    expect(first).toEqual(['https://example.com/a', 'https://example.com/d', 'https://example.com/b']);
    expect(second).toEqual(first);
  });

  it('marks unselected targets unchecked without classification', () => {
    const out = selectTargets([link('s', '/a', 'https://example.com/a', 'body'), link('s', '/b', 'https://example.com/b', 'body')], 1);
    expect(out.unselected).toMatchObject([{ checkState: 'unchecked', uncheckedReason: 'target_budget_exhausted', classification: null }]);
  });
});

function link(sourceUrl: string, hrefRaw: string, targetUrlNormalized: string, placement: ExtractedLink['placement']): ExtractedLink {
  return {
    sourceUrl,
    hrefRaw,
    targetUrlNormalized,
    anchorText: hrefRaw,
    placement,
    isInternal: true,
    eligibleForCheck: true,
    exclusionReason: null,
  };
}
