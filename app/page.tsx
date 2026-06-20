'use client';

import { useState, useRef, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

const PASSTHROUGH = ['email', 'name', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;

function EntryPageInner() {
  const router       = useRouter();
  const searchParams = useSearchParams();
  const [url, setUrl] = useState(searchParams.get('url') ?? '');
  const autoRanRef   = useRef(false);

  function overviewHref(rawUrl: string): string {
    const params = new URLSearchParams({ url: rawUrl.trim() });
    PASSTHROUGH.forEach((k) => {
      const v = searchParams.get(k);
      if (v) params.set(k, v);
    });
    return `/overview?${params.toString()}`;
  }

  useEffect(() => {
    if (autoRanRef.current) return;
    const paramUrl = searchParams.get('url') ?? '';
    if (!paramUrl.trim()) return;
    autoRanRef.current = true;
    router.push(overviewHref(paramUrl));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    router.push(overviewHref(url));
  }

  return (
    <main className="min-h-screen bg-[#060d18] text-slate-100">
      {/* Hero */}
      <section className="max-w-3xl mx-auto px-4 pt-20 pb-12 text-center">
        <div className="inline-flex items-center gap-2 bg-orange-500/10 border border-orange-500/20 rounded-full px-4 py-1.5 mb-6">
          <span className="w-2 h-2 bg-orange-500 rounded-full animate-pulse" />
          <span className="text-xs font-mono text-orange-400 uppercase tracking-wider">
            Prequire Scan
          </span>
        </div>

        <h1 className="text-4xl sm:text-5xl font-bold mb-4 leading-tight">
          Can AI find your site,
          <br />
          <span className="text-orange-400">and will it cite it?</span>
        </h1>

        <p className="text-slate-400 text-lg mb-10">
          Two checks. One score. See if ChatGPT, Claude, and Perplexity
          can reach and cite your content.
        </p>

        {/* Input */}
        <form onSubmit={handleSubmit} className="flex gap-3 max-w-xl mx-auto">
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://yoursite.com"
            className="flex-1 bg-[#0d1525] border border-slate-700 rounded-xl px-4 py-3 text-slate-100 placeholder-slate-500 focus:outline-none focus:border-orange-500 transition-colors font-mono text-sm"
          />
          <button
            type="submit"
            disabled={!url.trim()}
            className="bg-orange-500 hover:bg-orange-400 disabled:bg-orange-500/40 disabled:cursor-not-allowed text-white font-semibold px-6 py-3 rounded-xl transition-colors whitespace-nowrap"
          >
            Run Scan
          </button>
        </form>

        {/* Check preview cards */}
        <div className="mt-12 grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-xl mx-auto text-left">
          <div className="bg-[#0d1525] border border-slate-800 rounded-xl p-4">
            <p className="text-xs font-mono text-orange-400 uppercase tracking-wider mb-1">
              Visibility Check
            </p>
            <p className="text-sm text-slate-300">
              Can AI engines reach and read your site?
            </p>
          </div>
          <div className="bg-[#0d1525] border border-slate-800 rounded-xl p-4">
            <p className="text-xs font-mono text-orange-400 uppercase tracking-wider mb-1">
              Citation Check
            </p>
            <p className="text-sm text-slate-300">
              Is your content built to get cited?
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}

export default function EntryPage() {
  return (
    <Suspense>
      <EntryPageInner />
    </Suspense>
  );
}
