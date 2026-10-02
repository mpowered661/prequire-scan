// Cloudflare Turnstile token acquisition for the public report-request flow.
//
// Same pattern as prequire-engage's widget/widget.ts: the script is loaded on
// demand in explicit-render mode, rendered into a throwaway holder, and the
// promise resolves `undefined` on ANY failure — a missing script, a render
// error, or a timeout.
//
// RESOLVING UNDEFINED IS NOT A BYPASS. app.prequire.ai/api/audit/public-audit.php
// is the enforcement point: a request with no token is refused there. Resolving
// undefined simply means the client sends no token and gets a clean, explained
// refusal instead of hanging.
//
// The site key is public by design (NEXT_PUBLIC_TURNSTILE_SITE_KEY). With no
// key configured, no token is requested, which matches the server's
// unconfigured-secret posture during the rollout window.

const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const RENDER_TIMEOUT_MS = 20_000;

interface TurnstileApi {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      'error-callback'?: () => void;
      'timeout-callback'?: () => void;
    },
  ) => string;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

export function turnstileSiteKey(): string {
  return process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? '';
}

function loadTurnstile(): Promise<TurnstileApi | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (window.turnstile) return Promise.resolve(window.turnstile);
  return new Promise((resolve) => {
    const existing = document.querySelector(`script[src="${TURNSTILE_SRC}"]`);
    const done = () => resolve(window.turnstile ?? null);
    if (existing) {
      existing.addEventListener('load', done, { once: true });
      existing.addEventListener('error', () => resolve(null), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = TURNSTILE_SRC;
    script.async = true;
    script.addEventListener('load', done, { once: true });
    script.addEventListener('error', () => resolve(null), { once: true });
    document.head.appendChild(script);
  });
}

/**
 * Obtain a bot-check token. Resolves undefined on any failure.
 *
 * The holder is `aria-hidden` and not focusable: in invisible/managed mode
 * Turnstile renders nothing a user interacts with, and if it ever does show an
 * interactive challenge Cloudflare moves it into its own accessible overlay.
 */
export async function getTurnstileToken(): Promise<string | undefined> {
  const siteKey = turnstileSiteKey();
  if (!siteKey) return undefined;

  try {
    const ts = await loadTurnstile();
    if (!ts) return undefined;

    return await new Promise<string | undefined>((resolve) => {
      const holder = document.createElement('div');
      holder.setAttribute('aria-hidden', 'true');
      holder.style.position = 'fixed';
      holder.style.bottom = '0';
      holder.style.right = '0';
      holder.style.zIndex = '2147483000';
      document.body.appendChild(holder);

      let settled = false;
      const finish = (token: string | undefined) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        holder.remove();
        resolve(token);
      };
      const timer = setTimeout(() => finish(undefined), RENDER_TIMEOUT_MS);

      try {
        ts.render(holder, {
          sitekey: siteKey,
          callback: (token: string) => finish(token),
          'error-callback': () => finish(undefined),
          'timeout-callback': () => finish(undefined),
        });
      } catch {
        finish(undefined);
      }
    });
  } catch {
    return undefined;
  }
}
