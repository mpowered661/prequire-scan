import { EXCLUSIONS_VERSION } from './versions';

export { EXCLUSIONS_VERSION };

const NON_HTML_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'ico', 'bmp', 'tif', 'tiff',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'zip', 'gz', 'tar',
  'rar', 'mp3', 'mp4', 'mov', 'avi', 'wmv', 'webm', 'css', 'js', 'json',
  'xml', 'txt', 'woff', 'woff2', 'ttf', 'eot',
]);

export function evaluateExclusion(normalizedUrl: string): { excluded: boolean; reason: string | null } {
  const url = new URL(normalizedUrl);
  const segments = url.pathname.split('/').filter(Boolean).map(segment => segment.toLowerCase());
  const keys = [...url.searchParams.keys()].map(key => key.toLowerCase());
  const hasSegment = (...values: string[]) => segments.some(segment => values.includes(segment));
  const hasKey = (...values: string[]) => keys.some(key => values.includes(key));
  const lastSegment = segments.at(-1) ?? '';
  const extension = lastSegment.includes('.') ? lastSegment.split('.').pop() ?? '' : '';

  if (hasSegment('wp-admin', 'admin', 'administrator', 'wp-login.php')) return excluded('admin_path');
  if (hasSegment('login', 'signin', 'sign-in', 'register', 'signup', 'sign-up')) return excluded('auth_path');
  if (hasSegment('logout', 'signout', 'sign-out')) return excluded('logout_path');
  if (hasSegment('cart', 'checkout', 'basket')) return excluded('cart_checkout');
  if (hasSegment('account', 'my-account', 'dashboard', 'profile')) return excluded('account_area');
  if (hasKey('s', 'q', 'search') || hasSegment('search')) return excluded('search_space');
  if (hasKey('add-to-cart', 'remove_item')) return excluded('cart_action');
  if (hasKey('replytocom', 'unapproved')) return excluded('comment_action');
  if (hasSegment('feed', 'rss', 'rss.xml', 'atom.xml') || ['feed', 'rss', 'rss.xml', 'atom.xml'].some(suffix => url.pathname.toLowerCase().endsWith(`/${suffix}`))) return excluded('feed_variant');
  if (/\/(19|20)\d{2}\/(0[1-9]|1[0-2])(\/\d{1,2})?\/?$/.test(url.pathname)) return excluded('calendar_archive');
  if (segments.length >= 2 && segments[segments.length - 2] === 'page' && Number(segments[segments.length - 1]) > 2) return excluded('pagination_deep');
  if (Number(url.searchParams.get('page')) > 2) return excluded('pagination_deep');
  if (keys.length >= 3) return excluded('faceted_navigation');
  if (extension && NON_HTML_EXTENSIONS.has(extension)) return excluded('non_html_asset');
  if (segments.some(segment => segments.filter(other => other === segment).length >= 3)) return excluded('repeated_path_segments');
  if (segments.length > 8) return excluded('path_too_deep');
  return { excluded: false, reason: null };
}

function excluded(reason: string): { excluded: true; reason: string } {
  return { excluded: true, reason };
}
