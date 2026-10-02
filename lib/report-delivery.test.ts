import { describe, expect, it } from 'vitest';
import {
  classifyDelivery,
  humanizeWait,
  networkDeliveryFailure,
  parseRetryAfter,
} from './report-delivery';

// These are pure functions, so this suite exercises real behaviour rather than
// asserting on source text.

describe('parseRetryAfter', () => {
  it('accepts delta-seconds', () => {
    expect(parseRetryAfter('60')).toBe(60);
    expect(parseRetryAfter('  3600 ')).toBe(3600);
    expect(parseRetryAfter('0')).toBe(0);
  });

  it('accepts an HTTP-date and converts it to a remaining duration', () => {
    const future = new Date(Date.now() + 120_000).toUTCString();
    const secs = parseRetryAfter(future);
    expect(secs).toBeGreaterThan(100);
    expect(secs).toBeLessThanOrEqual(121);
  });

  it('treats a past date as no usable wait', () => {
    expect(parseRetryAfter(new Date(Date.now() - 60_000).toUTCString())).toBeUndefined();
  });

  it('returns undefined for absent or unparseable values', () => {
    // The cross-origin case: the browser hides the header unless the server
    // sends Access-Control-Expose-Headers, so null must be tolerated.
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter('-5')).toBeUndefined();
  });
});

describe('humanizeWait', () => {
  it('reads naturally across the ranges', () => {
    expect(humanizeWait(45)).toBe('in 45 seconds');
    expect(humanizeWait(600)).toBe('in about 10 minutes');
    expect(humanizeWait(3600)).toBe('in about 1 hour');
    expect(humanizeWait(86_400)).toBe('in about 24 hours');
  });

  it('never says "0 seconds", and is grammatical at 1', () => {
    expect(humanizeWait(0)).toBe('in 1 second');
    expect(humanizeWait(1)).toBe('in 1 second');
  });

  it('is empty when there is no wait time to report', () => {
    expect(humanizeWait(undefined)).toBe('');
  });
});

describe('classifyDelivery — success', () => {
  it('reports a queued report', () => {
    const out = classifyDelivery(200, undefined, { queued: true });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.deduped).toBe(false);
  });

  it('surfaces a cached delivery so the message can say so', () => {
    const out = classifyDelivery(200, undefined, { queued: true, deduped: true, scan_id: 'abc' });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.deduped).toBe(true);
  });

  it('tolerates an unparseable success body', () => {
    expect(classifyDelivery(200, undefined, null).ok).toBe(true);
  });
});

describe('classifyDelivery — 403 bot check', () => {
  const out = classifyDelivery(403, undefined, { error: 'bot_check_failed' });

  it('is a failure carrying the server reason', () => {
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('bot_check_failed');
  });

  it('tells the person what happened, that the result survives, and what to do', () => {
    if (out.ok) throw new Error('unreachable');
    expect(out.message).toMatch(/not verify/i);
    expect(out.message).toMatch(/was not sent/i);
    expect(out.message).toMatch(/still on this page/i);
    expect(out.message).toMatch(/reload the page|request it again/i);
  });

  it('does not invent a wait time it was not given', () => {
    if (out.ok) throw new Error('unreachable');
    expect(out.retryAfterSeconds).toBeUndefined();
  });
});

describe('classifyDelivery — 429 rate limited', () => {
  it('uses Retry-After when the server exposed it', () => {
    const out = classifyDelivery(429, 3600, { error: 'rate_limited_ip' });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.retryAfterSeconds).toBe(3600);
    expect(out.message).toContain('in about 1 hour');
  });

  it('still reads correctly with no Retry-After', () => {
    const out = classifyDelivery(429, undefined, { error: 'rate_limited_ip' });
    if (out.ok) throw new Error('unreachable');
    expect(out.message).toContain('Please try again later.');
    expect(out.message).not.toContain('undefined');
    expect(out.message).not.toContain('NaN');
  });

  it('distinguishes the recipient cap from the connection and domain limits', () => {
    const byEmail = classifyDelivery(429, 86_400, { error: 'rate_limited_email' });
    const byDomain = classifyDelivery(429, 86_400, { error: 'rate_limited_domain' });
    const byIp = classifyDelivery(429, 3600, { error: 'rate_limited_ip' });
    if (byEmail.ok || byDomain.ok || byIp.ok) throw new Error('unreachable');
    expect(byEmail.message).toMatch(/already been emailed to this address/i);
    expect(byEmail.message).toMatch(/check your inbox/i);
    expect(byDomain.message).toMatch(/already queued/i);
    expect(byIp.message).toMatch(/from your connection/i);
    // Three distinct messages — a person can tell which limit they hit.
    expect(new Set([byEmail.message, byDomain.message, byIp.message]).size).toBe(3);
  });
});

describe('classifyDelivery — 503 unavailable', () => {
  it('separates an unconfigured bot check from general unavailability', () => {
    const bot = classifyDelivery(503, 60, { error: 'bot_check_failed' });
    const other = classifyDelivery(503, 60, { error: 'rate_limit_unavailable' });
    if (bot.ok || other.ok) throw new Error('unreachable');
    expect(bot.message).toMatch(/bot check is not available/i);
    expect(other.message).toMatch(/temporarily unavailable/i);
    expect(bot.message).toContain('in 60 seconds');
  });
});

describe('classifyDelivery — anything else', () => {
  it('falls back to an honest generic failure with a synthetic reason', () => {
    const out = classifyDelivery(500, undefined, null);
    if (out.ok) throw new Error('unreachable');
    expect(out.reason).toBe('http_500');
    expect(out.message).toMatch(/could not queue/i);
  });

  it('prefers the server reason when there is one', () => {
    const out = classifyDelivery(400, undefined, { error: 'Valid email required' });
    if (out.ok) throw new Error('unreachable');
    expect(out.reason).toBe('Valid email required');
  });
});

describe('networkDeliveryFailure', () => {
  it('is a failure the caller can report without narrowing', () => {
    const out = networkDeliveryFailure();
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('network_error');
    expect(out.message).toMatch(/could not reach/i);
    expect(out.message).toMatch(/stays available/i);
  });
});

describe('every failure message is self-sufficient', () => {
  const cases = [
    classifyDelivery(403, undefined, { error: 'bot_check_failed' }),
    classifyDelivery(429, 3600, { error: 'rate_limited_ip' }),
    classifyDelivery(429, undefined, { error: 'rate_limited_email' }),
    classifyDelivery(503, 60, { error: 'rate_limit_unavailable' }),
    classifyDelivery(500, undefined, null),
    networkDeliveryFailure(),
  ];

  it('states the outcome in words, so nothing depends on colour or an icon', () => {
    for (const c of cases) {
      if (c.ok) throw new Error('unreachable');
      // Each message says the email did not go out, in prose.
      expect(c.message).toMatch(/not sent|not queued|could not queue|could not reach|did not send|did not queue/i);
      expect(c.message.length).toBeGreaterThan(40);
    }
  });

  it('never leaks a placeholder', () => {
    for (const c of cases) {
      if (c.ok) throw new Error('unreachable');
      for (const bad of ['undefined', 'NaN', 'null', '[object']) {
        expect(c.message).not.toContain(bad);
      }
    }
  });
});
