import { describe, it, expect } from 'vitest';
import { TRACKED_EVENTS, isTrackedEvent, sanitizeProps } from './events';

describe('event tracking allowlist', () => {
  it('covers exactly the five sprint events', () => {
    expect([...TRACKED_EVENTS].sort()).toEqual(
      [
        'email_prompt_shown',
        'email_submitted',
        'report_delivery_failed',
        'report_delivery_succeeded',
        'scan_completed',
      ].sort(),
    );
  });

  it('rejects unknown event names', () => {
    expect(isTrackedEvent('scan_completed')).toBe(true);
    expect(isTrackedEvent('made_up_event')).toBe(false);
    expect(isTrackedEvent(null)).toBe(false);
  });

  it('strips PII-bearing properties — email, phone, and arbitrary keys never pass', () => {
    const out = sanitizeProps({
      surface: 'scan',
      band: 'strong',
      email: 'leak@example.com',
      phone: '555-000-1111',
      anything: 'else',
    });
    expect(out).toEqual({ surface: 'scan', band: 'strong' });
  });

  it('handles non-object props safely', () => {
    expect(sanitizeProps(null)).toEqual({});
    expect(sanitizeProps('str')).toEqual({});
  });
});
