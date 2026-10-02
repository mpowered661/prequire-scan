// Turning a public-audit.php response into something a person can act on.
//
// The endpoint refuses with a bounded reason code and, for 429/503, a
// Retry-After header. This maps (status, reason, retry-after) to one honest
// sentence. Both callers — the scan page and the email-report form — use this,
// so the wording cannot drift between them.
//
// READING Retry-After CROSS-ORIGIN requires the server to send
// `Access-Control-Expose-Headers: Retry-After`. Without it the browser hides
// the header and `retryAfterSeconds` is undefined, so every message below has
// to read correctly with no wait time at all.

export interface DeliveryFailure {
  ok: false;
  reason: string;
  message: string;
  retryAfterSeconds?: number;
}

export type DeliveryOutcome = { ok: true; deduped: boolean } | DeliveryFailure;

/** Retry-After is either delta-seconds or an HTTP-date. Both are accepted. */
export function parseRetryAfter(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  }
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return undefined;
  const secs = Math.round((when - Date.now()) / 1000);
  return secs > 0 ? secs : undefined;
}

/** "in about 2 hours" / "in 45 seconds" / "" when there is no wait time. */
export function humanizeWait(seconds: number | undefined): string {
  if (seconds === undefined) return '';
  if (seconds < 90) {
    const secs = Math.max(1, Math.round(seconds));
    return `in ${secs} second${secs === 1 ? '' : 's'}`;
  }
  // Under an hour reads better in minutes; at an hour or more, in hours —
  // otherwise the IP window (3600s) comes out as "about 60 minutes".
  if (seconds < 3600) {
    const mins = Math.round(seconds / 60);
    return `in about ${mins} minute${mins === 1 ? '' : 's'}`;
  }
  const hours = Math.round(seconds / 3600);
  return `in about ${hours} hour${hours === 1 ? '' : 's'}`;
}

function withWait(base: string, seconds: number | undefined): string {
  const wait = humanizeWait(seconds);
  return wait ? `${base} Try again ${wait}.` : `${base} Please try again later.`;
}

/**
 * Classify a delivery attempt. `body` is the parsed JSON if there was one.
 *
 * Every failure message states what happened, that the on-screen result is
 * unaffected, and what to do next. None of them relies on colour or an icon to
 * carry meaning.
 */
export function classifyDelivery(
  status: number,
  retryAfterSeconds: number | undefined,
  body: unknown,
): DeliveryOutcome {
  const reason =
    typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : '';

  if (status >= 200 && status < 300) {
    const deduped =
      typeof body === 'object' && body !== null && (body as { deduped?: unknown }).deduped === true;
    return { ok: true, deduped };
  }

  if (status === 403) {
    return {
      ok: false,
      reason: reason || 'bot_check_failed',
      message:
        'We could not verify that this request came from a browser, so the report email was not sent. ' +
        'Your result is still on this page. Reload the page and request it again.',
    };
  }

  if (status === 429) {
    const base =
      reason === 'rate_limited_email'
        ? 'A report has already been emailed to this address in the last 24 hours, so we did not send another. Check your inbox, including spam.'
        : reason === 'rate_limited_domain'
          ? 'This site was already queued for a report in the last 24 hours, so we did not queue another.'
          : 'Too many report requests have come from your connection recently, so this one was not queued.';
    return {
      ok: false,
      reason: reason || 'rate_limited',
      message: `${withWait(base, retryAfterSeconds)} Your result stays available on this page.`,
      retryAfterSeconds,
    };
  }

  if (status === 503) {
    const base =
      reason === 'bot_check_failed'
        ? 'The bot check is not available right now, so the report email was not sent.'
        : 'Report delivery is temporarily unavailable, so the email was not sent.';
    return {
      ok: false,
      reason: reason || 'unavailable',
      message: `${withWait(base, retryAfterSeconds)} Your result stays available on this page.`,
      retryAfterSeconds,
    };
  }

  return {
    ok: false,
    reason: reason || `http_${status}`,
    message:
      'We could not queue the report email. Your result stays available on this page — please try again.',
  };
}

/** Network-level failure: no response at all. */
export function networkDeliveryFailure(): DeliveryFailure {
  return {
    ok: false,
    reason: 'network_error',
    message:
      'We could not reach the report service, so the email was not sent. ' +
      'Your result stays available on this page — please check your connection and try again.',
  };
}
