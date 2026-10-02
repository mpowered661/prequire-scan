'use client';

import { useEffect, useRef, useState } from 'react';
import { track } from '@/lib/track';
import { getTurnstileToken } from '@/lib/turnstile';
import { classifyDelivery, networkDeliveryFailure, parseRetryAfter, type DeliveryOutcome } from '@/lib/report-delivery';

// Optional email-report capture. Renders AFTER the scan result is already on
// screen — it never gates anything, and every failure path leaves the visible
// result untouched. Email is the only contact field; there is no phone input
// and nothing here can trigger SMS.

export interface EmailReportMeta {
  scan_id?: string | null;
  scanned_at?: string | null;
  registry_version?: string | null;
  prompt_version?: string | null;
  model?: string | null;
}

interface Props {
  url: string;
  score: number;
  surface: 'scan' | 'overview';
  meta?: EmailReportMeta;
  utm?: Record<string, string | null>;
}

type FormState =
  | { phase: 'idle' }
  | { phase: 'submitting' }
  | { phase: 'done'; duplicate: boolean; delivery: DeliveryOutcome | null }
  | { phase: 'error'; message: string };

const SUBMITTED_KEY = 'pq_report_emailed';

function alreadySubmitted(url: string): boolean {
  try {
    return JSON.parse(sessionStorage.getItem(SUBMITTED_KEY) ?? '[]').includes(url);
  } catch {
    return false;
  }
}

function markSubmitted(url: string): void {
  try {
    const list = JSON.parse(sessionStorage.getItem(SUBMITTED_KEY) ?? '[]');
    sessionStorage.setItem(SUBMITTED_KEY, JSON.stringify([...list, url]));
  } catch {
    /* best effort */
  }
}

export function EmailReportForm({ url, score, surface, meta, utm }: Props) {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<FormState>({ phase: 'idle' });
  const shownTracked = useRef(false);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (alreadySubmitted(url)) {
      setHidden(true);
      return;
    }
    if (!shownTracked.current) {
      shownTracked.current = true;
      track('email_prompt_shown', { surface });
    }
  }, [url, surface]);

  if (hidden) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) {
      setState({ phase: 'error', message: 'Please enter your email address.' });
      return;
    }
    setState({ phase: 'submitting' });
    track('email_submitted', { surface });

    // 1. Persist the consented capture (email, scan context, versions, UTM).
    let duplicate = false;
    try {
      const res = await fetch('/api/capture-lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: trimmed,
          url,
          score,
          scan_id: meta?.scan_id ?? null,
          scanned_at: meta?.scanned_at ?? null,
          registry_version: meta?.registry_version ?? null,
          prompt_version: meta?.prompt_version ?? null,
          model: meta?.model ?? null,
          ...(utm ?? {}),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setState({
          phase: 'error',
          message:
            (json as { error?: string }).error ??
            'Could not save your request. Your scan result is unaffected — please try again.',
        });
        return;
      }
      duplicate = (json as { duplicate?: boolean }).duplicate === true;
    } catch {
      setState({
        phase: 'error',
        message: 'Network hiccup — your scan result is unaffected. Please try again.',
      });
      return;
    }

    // 2. Queue the report email through the existing audit pipeline
    // (app.prequire.ai → cron → GHL with Resend fallback). A duplicate never
    // queues a second email. A queue failure is reported honestly but the
    // capture above already succeeded and the scan stays valid.
    let delivery: DeliveryOutcome | null = null;
    if (!duplicate) {
      // The server refuses a request with no token; an undefined token here
      // becomes an explained refusal rather than a silent non-delivery.
      const turnstileToken = await getTurnstileToken();
      try {
        const res = await fetch('https://app.prequire.ai/api/audit/public-audit.php', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url,
            email: trimmed,
            name: '',
            scan_id: meta?.scan_id ?? null,
            turnstileToken,
          }),
        });
        const payload = await res.json().catch(() => null);
        delivery = classifyDelivery(res.status, parseRetryAfter(res.headers.get('Retry-After')), payload);
      } catch {
        delivery = networkDeliveryFailure();
      }
      track(delivery.ok ? 'report_delivery_succeeded' : 'report_delivery_failed', {
        surface,
        ...(meta?.scan_id ? { scan_id: meta.scan_id } : {}),
        ...(delivery.ok ? {} : { reason: delivery.reason }),
      });
    }

    markSubmitted(url);
    setState({ phase: 'done', duplicate, delivery });
  }

  if (state.phase === 'done') {
    const failed = state.delivery !== null && !state.delivery.ok;
    return (
      <div
        // This block replaces the form, so the region is inserted at the same
        // moment as its text. role="alert" is announced on insertion, which a
        // bare aria-live region is not reliably; no redundant aria-live is set,
        // because each role already implies its politeness. A failure is
        // actionable, so it gets the assertive role. Meaning is carried by the
        // leading text label, never by colour.
        role={failed ? 'alert' : 'status'}
        className="bg-[#0d1525] border border-slate-800 rounded-2xl p-5 text-sm text-slate-300"
      >
        {state.duplicate ? (
          <p>You already requested this report — it&apos;s on its way to your inbox.</p>
        ) : failed ? (
          <p>
            <strong className="font-semibold text-slate-100">Email not sent.</strong>{' '}
            {state.delivery && !state.delivery.ok ? state.delivery.message : ''}
          </p>
        ) : (
          <p>Report requested — check your inbox shortly for the full breakdown and recommended next steps.</p>
        )}
      </div>
    );
  }

  return (
    <div className="bg-[#0d1525] border border-slate-800 rounded-2xl p-5">
      <h3 className="font-semibold text-slate-100 mb-1">Want this report in your inbox?</h3>
      <p className="text-xs text-slate-400 mb-4">
        Optional — your results stay right here either way. We&apos;ll email you the complete
        report with your saved result link and a recommended action plan.
      </p>
      <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-3" noValidate>
        <div className="flex-1">
          <label htmlFor="report-email" className="sr-only">
            Email address for your report
          </label>
          <input
            id="report-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            aria-describedby={state.phase === 'error' ? 'report-email-error' : 'report-email-consent'}
            aria-invalid={state.phase === 'error' || undefined}
            className="w-full bg-[#060d18] border border-slate-700 rounded-xl px-4 py-2.5 text-slate-100 placeholder-slate-500 focus:outline-none focus:border-orange-500 transition-colors text-sm"
            disabled={state.phase === 'submitting'}
          />
        </div>
        <button
          type="submit"
          disabled={state.phase === 'submitting'}
          className="bg-orange-500 hover:bg-orange-400 disabled:bg-orange-500/40 disabled:cursor-not-allowed text-white font-semibold px-5 py-2.5 rounded-xl transition-colors text-sm whitespace-nowrap"
        >
          {state.phase === 'submitting' ? 'Sending…' : 'Email my report'}
        </button>
      </form>
      {state.phase === 'error' && (
        <p id="report-email-error" role="alert" className="mt-2 text-xs text-red-400">
          {state.message}
        </p>
      )}
      <p id="report-email-consent" className="mt-3 text-xs text-slate-500">
        By submitting, you agree to receive this report and occasional Prequire emails.
        Unsubscribe anytime. No phone number required — we never send SMS.
      </p>
    </div>
  );
}
