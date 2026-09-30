import { ROLE_PATTERNS_VERSION } from './versions';

export { ROLE_PATTERNS_VERSION };

export interface RolePattern {
  role: string;
  segments: readonly string[];
  hubOnly?: boolean;
}

export const ROLE_PATTERNS: readonly RolePattern[] = [
  { role: 'about', segments: ['about', 'about-us', 'our-story'] },
  { role: 'company', segments: ['company', 'who-we-are'] },
  { role: 'team', segments: ['team', 'our-team', 'staff', 'people'] },
  { role: 'services', segments: ['services', 'service'] },
  { role: 'products', segments: ['products', 'product'] },
  { role: 'solutions', segments: ['solutions'] },
  { role: 'contact', segments: ['contact', 'contact-us'] },
  { role: 'pricing', segments: ['pricing', 'plans'] },
  { role: 'blog', segments: ['blog', 'news', 'insights', 'articles'], hubOnly: true },
  { role: 'podcast', segments: ['podcast', 'episodes', 'videos'], hubOnly: true },
];

export function matchRole(normalizedUrl: string): string | null {
  const segments = new URL(normalizedUrl).pathname.split('/').filter(Boolean).map(segment => segment.toLowerCase());
  for (const pattern of ROLE_PATTERNS) {
    if (pattern.hubOnly) {
      if (segments.length === 1 && pattern.segments.includes(segments[0])) return pattern.role;
      continue;
    }
    if (segments.some(segment => pattern.segments.includes(segment))) return pattern.role;
  }
  return null;
}
