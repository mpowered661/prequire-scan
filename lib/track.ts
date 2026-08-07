'use client';

import type { TrackedEvent } from './events';

// Fire-and-forget client event beacon. Never throws, never blocks the UI, and
// a tracking failure must never affect the scan or capture flow.
export function track(event: TrackedEvent, props?: Record<string, string | boolean>): void {
  try {
    const payload = JSON.stringify({ event, props: props ?? {} });
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon('/api/events', new Blob([payload], { type: 'application/json' }));
      return;
    }
    void fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // swallow — tracking is strictly best-effort
  }
}
