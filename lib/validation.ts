// Pure input validation — no I/O imports, safe to use anywhere.

// Pragmatic email shape check: local@domain.tld, no whitespace, sane length.
// Deliverability is proven by the email itself, not the regex.
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;

export function isValidEmail(email: unknown): email is string {
  return typeof email === 'string' && email.length <= 254 && EMAIL_RE.test(email.trim());
}
