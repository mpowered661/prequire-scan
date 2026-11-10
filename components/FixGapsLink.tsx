// The one "fix these gaps" control. Its href comes from fixHref(), so it always
// carries the scanned domain and report links. While that href is a mailto:,
// the visible hint says so — following the link opens the visitor's email app.
export function FixGapsLink({
  href,
  label = 'Fix these gaps →',
  size = 'md',
}: {
  href: string;
  label?: string;
  size?: 'md' | 'lg';
}) {
  const pad = size === 'lg' ? 'px-8 py-3' : 'px-5 py-2.5 text-sm';
  return (
    <span className="inline-flex flex-col items-center gap-1">
      <a
        href={href}
        className={`inline-block bg-orange-500 hover:bg-orange-400 text-white font-semibold rounded-xl transition-colors ${pad}`}
      >
        {label}
      </a>
      {href.startsWith('mailto:') && (
        <span className="text-xs text-slate-400">Opens your email app, with this report attached as links</span>
      )}
    </span>
  );
}
