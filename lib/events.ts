// Event tracking for the scan funnel (Lead Capture sprint).
//
// Events are structured operational logs, not stored analytics: the /api/events
// route validates against this allowlist and emits one JSON line to function
// logs (observable in Vercel). No PII is accepted in event properties — emails
// never travel through this channel. Durable analytics storage would need a
// table and is deliberately out of scope (schema changes are owner-gated).

export const TRACKED_EVENTS = [
  'scan_completed',
  'email_prompt_shown',
  'email_submitted',
  'report_delivery_succeeded',
  'report_delivery_failed',
] as const;

export type TrackedEvent = (typeof TRACKED_EVENTS)[number];

export function isTrackedEvent(name: unknown): name is TrackedEvent {
  return typeof name === 'string' && (TRACKED_EVENTS as readonly string[]).includes(name);
}

// Property allowlist: anything else is dropped server-side. Deliberately
// excludes email, name, phone — this channel carries funnel state only.
const ALLOWED_PROPS = ['surface', 'scan_id', 'band', 'reason', 'duplicate'] as const;

export function sanitizeProps(props: unknown): Record<string, string | boolean> {
  if (!props || typeof props !== 'object') return {};
  const out: Record<string, string | boolean> = {};
  for (const key of ALLOWED_PROPS) {
    const v = (props as Record<string, unknown>)[key];
    if (typeof v === 'boolean') out[key] = v;
    else if (typeof v === 'string' && v.length <= 120) out[key] = v;
  }
  return out;
}
