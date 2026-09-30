import { describe, expect, it } from 'vitest';
import { matchRole, ROLE_PATTERNS_VERSION } from './role-patterns';

describe('role patterns', () => {
  it('exports the frozen version', () => {
    expect(ROLE_PATTERNS_VERSION).toBe('roles-0.1');
  });

  it('matches exact path segments case-insensitively', () => {
    expect(matchRole('https://example.com/About-Us/')).toBe('about');
    expect(matchRole('https://example.com/all-about-cats/')).toBeNull();
  });

  it('keeps hub-only roles to one-segment hubs', () => {
    expect(matchRole('https://example.com/blog/')).toBe('blog');
    expect(matchRole('https://example.com/blog/post-one/')).toBeNull();
  });
});
