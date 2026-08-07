import { describe, it, expect } from 'vitest';
import { resolveStudyAuth, buildStudyEnvelope } from './study';

describe('resolveStudyAuth', () => {
  it('is not_requested when the study flag is absent or not exactly true', () => {
    expect(resolveStudyAuth(undefined, 'tok', 'tok')).toBe('not_requested');
    expect(resolveStudyAuth(false, 'tok', 'tok')).toBe('not_requested');
    expect(resolveStudyAuth('true', 'tok', 'tok')).toBe('not_requested');
    expect(resolveStudyAuth(1, 'tok', 'tok')).toBe('not_requested');
  });

  it('authorizes only when header token matches the configured env token', () => {
    expect(resolveStudyAuth(true, 'secret', 'secret')).toBe('authorized');
  });

  it('fails closed: rejected when env token is unset, header missing, or mismatched', () => {
    expect(resolveStudyAuth(true, 'secret', undefined)).toBe('rejected');
    expect(resolveStudyAuth(true, 'secret', '')).toBe('rejected');
    expect(resolveStudyAuth(true, null, 'secret')).toBe('rejected');
    expect(resolveStudyAuth(true, 'wrong', 'secret')).toBe('rejected');
  });
});

describe('buildStudyEnvelope', () => {
  it('produces a deterministic content hash and byte count', () => {
    const a = buildStudyEnvelope('https://example.com/', '<html>x</html>', { v: '1' });
    const b = buildStudyEnvelope('https://example.com/', '<html>x</html>', { v: '1' });
    expect(a.html_sha256).toBe(b.html_sha256);
    expect(a.html_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(a.html_bytes).toBe(Buffer.byteLength('<html>x</html>', 'utf8'));
  });

  it('different content yields a different hash', () => {
    const a = buildStudyEnvelope('https://example.com/', 'aaa', {});
    const b = buildStudyEnvelope('https://example.com/', 'bbb', {});
    expect(a.html_sha256).not.toBe(b.html_sha256);
  });

  it('records mode, url, versions, and persisted:false', () => {
    const env = buildStudyEnvelope('https://example.com/', 'x', {
      prompt_version: '2026-08',
      model: 'claude-haiku-4-5-20251001',
    });
    expect(env.mode).toBe('study');
    expect(env.persisted).toBe(false);
    expect(env.input_url).toBe('https://example.com/');
    expect(env.versions.prompt_version).toBe('2026-08');
    expect(new Date(env.fetched_at).toString()).not.toBe('Invalid Date');
  });
});
