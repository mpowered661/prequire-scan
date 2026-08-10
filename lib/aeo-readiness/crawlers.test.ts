import { describe, it, expect } from 'vitest';
import { CRAWLERS, REGISTRY_VERSION, getActiveCrawlers } from './crawlers';

// Registry v2026-08 integrity — scanner-audit-addendum-2026-08-06 Gate 2.
// These tests pin the study registry: any membership or check_type change must
// consciously update both the registry version and this file.
describe('crawler registry v2026-08', () => {
  const names = CRAWLERS.map((c) => c.name);

  it('exports a fixed registry version', () => {
    expect(REGISTRY_VERSION).toBe('2026-08');
  });

  it('does not test deprecated Anthropic identities (Claude-Web, anthropic-ai)', () => {
    expect(names).not.toContain('Claude-Web');
    expect(names).not.toContain('anthropic-ai');
  });

  it('tests all three current Anthropic crawlers', () => {
    expect(names).toContain('ClaudeBot');
    expect(names).toContain('Claude-SearchBot');
    expect(names).toContain('Claude-User');
  });

  it('tests the documented OpenAI, Perplexity, and Google identities', () => {
    for (const n of ['GPTBot', 'ChatGPT-User', 'OAI-SearchBot', 'PerplexityBot', 'Perplexity-User', 'Google-Extended']) {
      expect(names).toContain(n);
    }
  });

  it('never HTTP-probes robots-token-only identities (Google-Extended, Applebot-Extended)', () => {
    const googleExt = CRAWLERS.find((c) => c.name === 'Google-Extended')!;
    const appleExt = CRAWLERS.find((c) => c.name === 'Applebot-Extended')!;
    expect(googleExt.check_type).toBe('robots_only');
    expect(appleExt.check_type).toBe('robots_only');
    // and their UA strings are never real fetch UAs
    expect(googleExt.user_agent).toContain('not fetched');
    expect(appleExt.user_agent).toContain('not fetched');
  });

  it('assigns every crawler exactly one valid purpose', () => {
    const valid = ['training', 'search_index', 'user_fetch', 'seo'];
    for (const c of CRAWLERS) {
      expect(valid, `${c.name} has invalid purpose ${c.purpose}`).toContain(c.purpose);
    }
  });

  it('classifies purposes per vendor documentation', () => {
    const purposeOf = (n: string) => CRAWLERS.find((c) => c.name === n)?.purpose;
    expect(purposeOf('GPTBot')).toBe('training');
    expect(purposeOf('ClaudeBot')).toBe('training');
    expect(purposeOf('Google-Extended')).toBe('training');
    expect(purposeOf('Applebot-Extended')).toBe('training');
    expect(purposeOf('CCBot')).toBe('training');
    expect(purposeOf('OAI-SearchBot')).toBe('search_index');
    expect(purposeOf('Claude-SearchBot')).toBe('search_index');
    expect(purposeOf('PerplexityBot')).toBe('search_index');
    expect(purposeOf('ChatGPT-User')).toBe('user_fetch');
    expect(purposeOf('Claude-User')).toBe('user_fetch');
    expect(purposeOf('Perplexity-User')).toBe('user_fetch');
    expect(purposeOf('Googlebot')).toBe('seo');
    expect(purposeOf('Bingbot')).toBe('seo');
  });

  it('has no duplicate names', () => {
    expect(new Set(names).size).toBe(names.length);
  });

  it('excludes seo crawlers unless requested', () => {
    const active = getActiveCrawlers(false);
    expect(active.some((c) => c.tier === 'seo')).toBe(false);
    expect(getActiveCrawlers(true).length).toBe(CRAWLERS.length);
  });
});
