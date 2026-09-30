import dns from 'node:dns';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ipIsPublic, validateUrl } from './egress-policy';

describe('ipIsPublic', () => {
  it('refuses private and documentation ranges', () => {
    expect(ipIsPublic('127.0.0.1')).toBe(false);
    expect(ipIsPublic('10.0.0.1')).toBe(false);
    expect(ipIsPublic('100.64.0.1')).toBe(false);
    expect(ipIsPublic('192.168.1.1')).toBe(false);
    expect(ipIsPublic('2001:db8::1')).toBe(false);
    expect(ipIsPublic('::1')).toBe(false);
  });

  it('accepts public addresses', () => {
    expect(ipIsPublic('93.184.216.34')).toBe(true);
    expect(ipIsPublic('2606:2800:220:1:248:1893:25c8:1946')).toBe(true);
  });
});

describe('validateUrl', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    'http://127.0.0.1/',
    'http://169.254.169.254/',
    'http://[::1]/',
    'http://10.0.0.1/',
    'http://192.168.1.1/',
    'http://100.64.0.1/',
    'http://2130706433/',
    'http://0x7f000001/',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'http://example.com:8080/',
    'http://exa mple.com/',
  ])('rejects unsafe URL %s', async url => {
    await expect(validateUrl(url)).resolves.toMatchObject({ ok: false });
  });

  it('accepts a public host when all DNS answers are public', async () => {
    vi.spyOn(dns.promises, 'resolve4').mockResolvedValue(['93.184.216.34']);
    vi.spyOn(dns.promises, 'resolve6').mockRejectedValue(new Error('none'));

    await expect(validateUrl('https://example.com/path')).resolves.toMatchObject({
      ok: true,
      host: 'example.com',
      port: 443,
    });
  });

  it('rejects a host when any DNS answer is private', async () => {
    vi.spyOn(dns.promises, 'resolve4').mockResolvedValue(['93.184.216.34', '127.0.0.1']);
    vi.spyOn(dns.promises, 'resolve6').mockRejectedValue(new Error('none'));

    await expect(validateUrl('https://example.com/')).resolves.toMatchObject({
      ok: false,
      reason: 'dns_not_public',
    });
  });
});
